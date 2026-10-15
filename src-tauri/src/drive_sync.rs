//! Sincronización offline-first con Google Drive (SPECIFICATIONS.md §4.4).
//!
//! - OAuth 2.0 loopback (`127.0.0.1:<puerto>`) con PKCE S256; tokens en `app_settings`
//!   (`google_access_token`, `google_refresh_token`, `google_token_expiry` en RFC 3339).
//! - Estructura en Drive: `PianoTracker/` (snapshot de la BD), `PianoTracker/midi/`
//!   (fragmentos y pistas brutas) y `PianoTracker/media/` (imágenes). Los ids se cachean en
//!   `drive_folder_root`, `drive_folder_midi` y `drive_folder_media`.
//! - Worker: procesa `sync_queue` en orden FIFO cada 15 s o al recibir `notify_change`.
//!   Errores de red / 5xx / 429 / 401 → `Database::defer_sync_item` (retry_count sube sin llegar
//!   a `MAX_RETRIES`, el elemento sigue PENDING) y se corta el ciclo. Errores 4xx no
//!   recuperables → `fail_sync_item` y, al llegar a `MAX_RETRIES`, `mark_entity_error`.
//! - Nunca hace llamadas de red si no hay credenciales y cuenta conectada.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

use crate::db::{Database, MAX_RETRIES, SNAPSHOT_ENTITY_ID};
use crate::models::{
    SyncQueueItem, SyncStatusDto, ACTION_DELETE, ENTITY_DB_SNAPSHOT, ENTITY_MEDIA_IMAGE, ENTITY_MIDI_FRAGMENT,
    ENTITY_RAW_MIDI,
};
use crate::paths::AppPaths;

/// Callback para emitir el estado (el agente principal lo conecta a un evento Tauri).
pub type SyncStatusEmitter = Arc<dyn Fn(SyncStatusDto) + Send + Sync>;

pub const KEY_CLIENT_ID: &str = "google_client_id";
pub const KEY_CLIENT_SECRET: &str = "google_client_secret";
pub const KEY_ACCESS_TOKEN: &str = "google_access_token";
pub const KEY_REFRESH_TOKEN: &str = "google_refresh_token";
pub const KEY_TOKEN_EXPIRY: &str = "google_token_expiry";
pub const KEY_FOLDER_ROOT: &str = "drive_folder_root";
pub const KEY_FOLDER_MIDI: &str = "drive_folder_midi";
pub const KEY_FOLDER_MEDIA: &str = "drive_folder_media";

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

const ROOT_FOLDER_NAME: &str = "PianoTracker";
const MIDI_FOLDER_NAME: &str = "midi";
const MEDIA_FOLDER_NAME: &str = "media";
const SNAPSHOT_FILE_NAME: &str = "piano_tracker_backup.sqlite";

const WORKER_INTERVAL: Duration = Duration::from_secs(15);
const AUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const BATCH_SIZE: usize = 50;
const MAX_BATCHES_PER_CYCLE: usize = 20;

// ---------------------------------------------------------------------------
// Errores internos
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum SyncError {
    /// Sin respuesta (conexión, DNS, timeout...): se reintenta en el siguiente ciclo.
    Network(String),
    /// Respuesta del servidor recuperable (5xx, 429, cuota): se reintenta en el siguiente ciclo.
    Transient(String),
    /// 401: el access token ya no vale; se descarta para forzar el refresco.
    Unauthorized(String),
    /// La cuenta ya no está autorizada (invalid_grant o sin refresh token).
    Auth(String),
    /// Error HTTP 4xx no recuperable.
    Permanent(String),
    /// Error local (BD, fichero).
    Local(String),
}

impl SyncError {
    fn message(&self) -> &str {
        match self {
            SyncError::Network(m)
            | SyncError::Transient(m)
            | SyncError::Unauthorized(m)
            | SyncError::Auth(m)
            | SyncError::Permanent(m)
            | SyncError::Local(m) => m,
        }
    }
}

fn network_err(e: reqwest::Error) -> SyncError {
    SyncError::Network(format!("Sin conexión con Google: {e}"))
}

fn classify_status(status: u16, body: &str) -> SyncError {
    let snippet: String = body.chars().take(300).collect();
    let msg = format!("Google Drive respondió HTTP {status}: {snippet}");
    match status {
        401 => SyncError::Unauthorized(msg),
        403 if body.contains("rateLimitExceeded") || body.contains("userRateLimitExceeded") => {
            SyncError::Transient(msg)
        }
        408 | 429 => SyncError::Transient(msg),
        s if s >= 500 => SyncError::Transient(msg),
        _ => SyncError::Permanent(msg),
    }
}

async fn ensure_success(resp: reqwest::Response) -> Result<reqwest::Response, SyncError> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Err(classify_status(status, &body))
}

// ---------------------------------------------------------------------------
// Utilidades puras (testeables sin red)
// ---------------------------------------------------------------------------

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_token(len_bytes: usize) -> String {
    let mut buf = vec![0u8; len_bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    b64url(&buf)
}

/// `code_verifier` PKCE: 32 bytes aleatorios en base64url sin relleno (43 caracteres).
pub(crate) fn generate_code_verifier() -> String {
    random_token(32)
}

/// `code_challenge` PKCE S256 = BASE64URL(SHA256(verifier)).
pub(crate) fn code_challenge_s256(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    b64url(&Sha256::digest(verifier.as_bytes()))
}

pub(crate) fn build_auth_url(client_id: &str, redirect_uri: &str, state: &str, code_challenge: &str) -> String {
    let params = [
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", DRIVE_SCOPE),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("state", state),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
    ];
    match url::Url::parse_with_params(AUTH_ENDPOINT, &params) {
        Ok(u) => u.to_string(),
        Err(_) => {
            let query = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params).finish();
            format!("{AUTH_ENDPOINT}?{query}")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Parsea la línea de petición del callback (`GET /?code=...&state=... HTTP/1.1`).
/// Devuelve `None` si no es un GET con `code` o `error` (p. ej. `/favicon.ico`).
pub(crate) fn parse_callback_request(request_line: &str) -> Option<CallbackParams> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let base = url::Url::parse("http://127.0.0.1/").ok()?;
    let parsed = base.join(target).ok()?;
    let mut params = CallbackParams::default();
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => params.code = Some(v.into_owned()),
            "state" => params.state = Some(v.into_owned()),
            "error" => params.error = Some(v.into_owned()),
            _ => {}
        }
    }
    if params.code.is_none() && params.error.is_none() {
        return None;
    }
    Some(params)
}

/// Cuerpo `multipart/related` para la subida de Drive (metadatos JSON + contenido binario).
pub(crate) fn build_multipart_body(boundary: &str, metadata: &serde_json::Value, mime: &str, content: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(content.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend_from_slice(metadata.to_string().as_bytes());
    body.extend_from_slice(format!("\r\n--{boundary}\r\n").as_bytes());
    body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

pub(crate) fn mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mid" | "midi" => "audio/midi",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "sqlite" | "db" => "application/x-sqlite3",
        _ => "application/octet-stream",
    }
}

fn escape_query_value(v: &str) -> String {
    v.replace('\\', "\\\\").replace('\'', "\\'")
}

fn form_body(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn html_page(title: &str, message: &str) -> String {
    format!(
        "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:sans-serif;max-width:32rem;margin:4rem auto;text-align:center\">\
         <h1>{title}</h1><p>{message}</p><p>Puedes cerrar esta ventana y volver a Piano Practice Tracker.</p>\
         </body></html>"
    )
}

// ---------------------------------------------------------------------------
// Tipos de respuesta de Google
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DriveFile {
    id: String,
}

#[derive(Debug, Deserialize)]
struct DriveFileList {
    #[serde(default)]
    files: Vec<DriveFile>,
}

struct Folders {
    root: String,
    midi: String,
    media: String,
}

#[derive(Debug, Default)]
struct RuntimeState {
    is_syncing: bool,
    last_sync_at: Option<String>,
    last_error: Option<String>,
    online: bool,
}

// ---------------------------------------------------------------------------
// DriveSync
// ---------------------------------------------------------------------------

pub struct DriveSync {
    db: Arc<Database>,
    paths: AppPaths,
    notify: Notify,
    state: Mutex<RuntimeState>,
    emitter: SyncStatusEmitter,
    http: reqwest::Client,
    /// Evita ciclos de sincronización concurrentes (worker + `sync_now` manual).
    cycle_lock: tokio::sync::Mutex<()>,
}

impl DriveSync {
    pub fn new(db: Arc<Database>, paths: AppPaths, emitter: SyncStatusEmitter) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Arc::new(DriveSync {
            db,
            paths,
            notify: Notify::new(),
            state: Mutex::new(RuntimeState { online: true, ..RuntimeState::default() }),
            emitter,
            http,
            cycle_lock: tokio::sync::Mutex::new(()),
        })
    }

    fn rt(&self) -> MutexGuard<'_, RuntimeState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn setting(&self, key: &str) -> Option<String> {
        self.db.get_setting(key).ok().flatten().filter(|v| !v.trim().is_empty())
    }

    fn emit(&self) {
        (self.emitter)(self.status());
    }

    fn set_error(&self, msg: Option<String>) {
        if let Some(m) = &msg {
            log::warn!("drive_sync: {m}");
        }
        self.rt().last_error = msg;
    }

    fn set_online(&self, online: bool) {
        self.rt().online = online;
    }

    /// Guarda las credenciales de Google Cloud y borra los tokens previos.
    pub fn save_credentials(&self, client_id: &str, client_secret: &str) -> Result<(), String> {
        let client_id = client_id.trim();
        let client_secret = client_secret.trim();
        if client_id.is_empty() {
            return Err("El client_id de Google no puede estar vacío".into());
        }
        if client_secret.is_empty() {
            return Err("El client_secret de Google no puede estar vacío".into());
        }
        self.db.set_setting(KEY_CLIENT_ID, client_id)?;
        self.db.set_setting(KEY_CLIENT_SECRET, client_secret)?;
        self.clear_tokens()?;
        // Las carpetas cacheadas podrían pertenecer a otra cuenta.
        for key in [KEY_FOLDER_ROOT, KEY_FOLDER_MIDI, KEY_FOLDER_MEDIA] {
            self.db.delete_setting(key)?;
        }
        self.set_error(None);
        self.emit();
        Ok(())
    }

    fn clear_tokens(&self) -> Result<(), String> {
        for key in [KEY_ACCESS_TOKEN, KEY_REFRESH_TOKEN, KEY_TOKEN_EXPIRY] {
            self.db.delete_setting(key)?;
        }
        Ok(())
    }

    fn credentials(&self) -> Option<(String, String)> {
        Some((self.setting(KEY_CLIENT_ID)?, self.setting(KEY_CLIENT_SECRET)?))
    }

    pub fn status(&self) -> SyncStatusDto {
        let has_credentials = self.credentials().is_some();
        let connected = self.setting(KEY_REFRESH_TOKEN).is_some();
        let (pending_count, error_count) = self.db.sync_counts().unwrap_or((0, 0));
        let rt = self.rt();
        SyncStatusDto {
            has_credentials,
            connected,
            online: rt.online,
            is_syncing: rt.is_syncing,
            pending_count,
            error_count,
            last_sync_at: rt.last_sync_at.clone(),
            last_error: rt.last_error.clone(),
        }
    }

    /// Despierta al worker (llamar tras cualquier cambio que encole elementos).
    pub fn notify_change(&self) {
        self.notify.notify_one();
    }

    /// Bucle infinito del worker: un ciclo al arrancar y luego cada 15 s o al notificar cambios.
    pub async fn run_worker(self: Arc<Self>) {
        loop {
            self.sync_now().await;
            tokio::select! {
                _ = tokio::time::sleep(WORKER_INTERVAL) => {}
                _ = self.notify.notified() => {
                    // Pequeña espera para agrupar ráfagas de cambios.
                    tokio::time::sleep(Duration::from_millis(750)).await;
                }
            }
        }
    }

    // ----------------------------- OAuth -----------------------------

    /// Inicia el flujo OAuth loopback y devuelve inmediatamente la URL de autorización.
    pub async fn start_auth(self: &Arc<Self>) -> Result<String, String> {
        let (client_id, client_secret) = self.credentials().ok_or_else(|| {
            "Configura primero el client_id y el client_secret de Google en Ajustes".to_string()
        })?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("No se pudo abrir el puerto local para la autorización: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("No se pudo obtener el puerto local: {e}"))?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}");
        let state = random_token(24);
        let verifier = generate_code_verifier();
        let challenge = code_challenge_s256(&verifier);
        let auth_url = build_auth_url(&client_id, &redirect_uri, &state, &challenge);

        open_browser(&auth_url);

        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.auth_callback(listener, client_id, client_secret, redirect_uri, state, verifier)
                .await;
        });
        Ok(auth_url)
    }

    async fn auth_callback(
        self: Arc<Self>,
        listener: TcpListener,
        client_id: String,
        client_secret: String,
        redirect_uri: String,
        expected_state: String,
        verifier: String,
    ) {
        let deadline = tokio::time::Instant::now() + AUTH_TIMEOUT;
        loop {
            let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
            let mut stream = match accepted {
                Err(_) => {
                    self.set_error(Some("Tiempo de espera agotado para la autorización de Google".into()));
                    self.emit();
                    return;
                }
                Ok(Err(e)) => {
                    self.set_error(Some(format!("Error en el servidor local de autorización: {e}")));
                    self.emit();
                    return;
                }
                Ok(Ok((stream, _))) => stream,
            };
            let Some(line) = read_request_line(&mut stream).await else {
                continue;
            };
            let Some(params) = parse_callback_request(&line) else {
                // Peticiones ajenas (favicon, preconexiones...): se ignoran.
                respond(&mut stream, "404 Not Found", &html_page("No encontrado", "")).await;
                continue;
            };

            let outcome: Result<(), String> = if let Some(err) = params.error {
                Err(if err == "access_denied" {
                    "Has denegado el acceso a Google Drive".to_string()
                } else {
                    format!("Google devolvió un error de autorización: {err}")
                })
            } else if params.state.as_deref() != Some(expected_state.as_str()) {
                Err("La respuesta de autorización no es válida (state no coincide)".to_string())
            } else {
                match params.code {
                    Some(code) => {
                        self.exchange_code(&client_id, &client_secret, &redirect_uri, &code, &verifier)
                            .await
                    }
                    None => Err("La respuesta de autorización no contiene código".to_string()),
                }
            };

            match outcome {
                Ok(()) => {
                    respond(
                        &mut stream,
                        "200 OK",
                        &html_page("Google Drive conectado", "La autorización se ha completado correctamente."),
                    )
                    .await;
                    self.set_error(None);
                    self.emit();
                    self.sync_now().await;
                }
                Err(msg) => {
                    respond(&mut stream, "200 OK", &html_page("No se pudo conectar Google Drive", &msg)).await;
                    self.set_error(Some(msg));
                    self.emit();
                }
            }
            return;
        }
    }

    async fn exchange_code(
        &self,
        client_id: &str,
        client_secret: &str,
        redirect_uri: &str,
        code: &str,
        verifier: &str,
    ) -> Result<(), String> {
        let body = form_body(&[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ]);
        let resp = self
            .http
            .post(TOKEN_ENDPOINT)
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| {
                self.set_online(false);
                format!("No se pudo contactar con Google para canjear el código: {e}")
            })?;
        self.set_online(true);
        let status = resp.status();
        let token: TokenResponse = resp
            .json()
            .await
            .map_err(|e| format!("Respuesta de token no válida (HTTP {status}): {e}"))?;
        if !status.is_success() || token.error.is_some() {
            return Err(format!(
                "Google rechazó el canje del código: {} {}",
                token.error.unwrap_or_else(|| status.to_string()),
                token.error_description.unwrap_or_default()
            ));
        }
        let access = token
            .access_token
            .ok_or_else(|| "La respuesta de Google no incluye access_token".to_string())?;
        let refresh = token.refresh_token.ok_or_else(|| {
            "La respuesta de Google no incluye refresh_token; revoca el acceso y vuelve a conectar".to_string()
        })?;
        self.store_access_token(&access, token.expires_in)?;
        self.db.set_setting(KEY_REFRESH_TOKEN, &refresh)?;
        Ok(())
    }

    fn store_access_token(&self, access: &str, expires_in: Option<i64>) -> Result<(), String> {
        let expiry = chrono::Utc::now() + chrono::Duration::seconds(expires_in.unwrap_or(3600).max(0));
        self.db.set_setting(KEY_ACCESS_TOKEN, access)?;
        self.db.set_setting(KEY_TOKEN_EXPIRY, &expiry.to_rfc3339())?;
        Ok(())
    }

    /// Access token válido (refrescándolo si caduca en menos de 60 s).
    async fn access_token(&self) -> Result<String, SyncError> {
        if let (Some(token), Some(expiry)) = (self.setting(KEY_ACCESS_TOKEN), self.setting(KEY_TOKEN_EXPIRY)) {
            if let Ok(exp) = chrono::DateTime::parse_from_rfc3339(&expiry) {
                if exp.with_timezone(&chrono::Utc) - chrono::Utc::now() > chrono::Duration::seconds(60) {
                    return Ok(token);
                }
            }
        }
        self.refresh_access_token().await
    }

    async fn refresh_access_token(&self) -> Result<String, SyncError> {
        let refresh = self
            .setting(KEY_REFRESH_TOKEN)
            .ok_or_else(|| SyncError::Auth("No hay ninguna cuenta de Google conectada".into()))?;
        let (client_id, client_secret) = self
            .credentials()
            .ok_or_else(|| SyncError::Auth("Faltan las credenciales de Google".into()))?;
        let body = form_body(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ]);
        let resp = self
            .http
            .post(TOKEN_ENDPOINT)
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(network_err)?;
        self.set_online(true);
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(network_err)?;
        let parsed: Option<TokenResponse> = serde_json::from_str(&text).ok();
        let error_code = parsed.as_ref().and_then(|t| t.error.clone());
        if error_code.as_deref() == Some("invalid_grant") || (status == 401 && error_code.is_some()) {
            self.clear_tokens().map_err(SyncError::Local)?;
            return Err(SyncError::Auth(
                "La autorización de Google ha caducado o se ha revocado; vuelve a conectar Google Drive".into(),
            ));
        }
        if !(200..300).contains(&status) {
            return Err(classify_status(status, &text));
        }
        let token = parsed.ok_or_else(|| SyncError::Transient("Respuesta de token de Google no válida".into()))?;
        let access = token
            .access_token
            .ok_or_else(|| SyncError::Transient("La respuesta de Google no incluye access_token".into()))?;
        self.store_access_token(&access, token.expires_in).map_err(SyncError::Local)?;
        if let Some(new_refresh) = token.refresh_token.filter(|r| !r.is_empty()) {
            self.db.set_setting(KEY_REFRESH_TOKEN, &new_refresh).map_err(SyncError::Local)?;
        }
        Ok(access)
    }

    // ----------------------------- Drive API -----------------------------

    async fn find_file(
        &self,
        token: &str,
        name: &str,
        parent: &str,
        mime: Option<&str>,
    ) -> Result<Option<String>, SyncError> {
        let mut q = format!(
            "name = '{}' and trashed = false and '{}' in parents",
            escape_query_value(name),
            escape_query_value(parent)
        );
        if let Some(m) = mime {
            q.push_str(&format!(" and mimeType = '{m}'"));
        }
        let url = url::Url::parse_with_params(
            DRIVE_FILES_URL,
            &[("q", q.as_str()), ("fields", "files(id,name)"), ("spaces", "drive"), ("pageSize", "10")],
        )
        .map_err(|e| SyncError::Local(format!("URL de búsqueda no válida: {e}")))?;
        let resp = self.http.get(url).bearer_auth(token).send().await.map_err(network_err)?;
        self.set_online(true);
        let resp = ensure_success(resp).await?;
        let list: DriveFileList = resp
            .json()
            .await
            .map_err(|e| SyncError::Transient(format!("Respuesta de Drive no válida: {e}")))?;
        Ok(list.files.into_iter().next().map(|f| f.id))
    }

    async fn find_or_create_folder(&self, token: &str, name: &str, parent: &str) -> Result<String, SyncError> {
        if let Some(id) = self.find_file(token, name, parent, Some(FOLDER_MIME)).await? {
            return Ok(id);
        }
        let metadata = serde_json::json!({ "name": name, "mimeType": FOLDER_MIME, "parents": [parent] });
        let resp = self
            .http
            .post(format!("{DRIVE_FILES_URL}?fields=id"))
            .bearer_auth(token)
            .json(&metadata)
            .send()
            .await
            .map_err(network_err)?;
        self.set_online(true);
        let resp = ensure_success(resp).await?;
        let file: DriveFile = resp
            .json()
            .await
            .map_err(|e| SyncError::Transient(format!("Respuesta de Drive no válida: {e}")))?;
        Ok(file.id)
    }

    async fn ensure_folders(&self, token: &str) -> Result<Folders, SyncError> {
        let cached = (self.setting(KEY_FOLDER_ROOT), self.setting(KEY_FOLDER_MIDI), self.setting(KEY_FOLDER_MEDIA));
        if let (Some(root), Some(midi), Some(media)) = cached {
            return Ok(Folders { root, midi, media });
        }
        let root = match self.setting(KEY_FOLDER_ROOT) {
            Some(r) => r,
            None => self.find_or_create_folder(token, ROOT_FOLDER_NAME, "root").await?,
        };
        self.db.set_setting(KEY_FOLDER_ROOT, &root).map_err(SyncError::Local)?;
        let midi = self.find_or_create_folder(token, MIDI_FOLDER_NAME, &root).await?;
        self.db.set_setting(KEY_FOLDER_MIDI, &midi).map_err(SyncError::Local)?;
        let media = self.find_or_create_folder(token, MEDIA_FOLDER_NAME, &root).await?;
        self.db.set_setting(KEY_FOLDER_MEDIA, &media).map_err(SyncError::Local)?;
        Ok(Folders { root, midi, media })
    }

    fn clear_folder_cache(&self) {
        for key in [KEY_FOLDER_ROOT, KEY_FOLDER_MIDI, KEY_FOLDER_MEDIA] {
            let _ = self.db.delete_setting(key);
        }
    }

    /// Sube (POST) o actualiza (PATCH si `existing_id`) un fichero. Devuelve el id de Drive.
    async fn upload_file(
        &self,
        token: &str,
        local: &Path,
        name: &str,
        parent: &str,
        existing_id: Option<&str>,
    ) -> Result<String, SyncError> {
        let content = tokio::fs::read(local)
            .await
            .map_err(|e| SyncError::Local(format!("No se pudo leer {}: {e}", local.display())))?;
        let mime = mime_for_path(local);
        let boundary = format!("piano_tracker_{}", uuid::Uuid::new_v4().simple());

        if let Some(id) = existing_id {
            let metadata = serde_json::json!({ "name": name });
            let body = build_multipart_body(&boundary, &metadata, mime, &content);
            let resp = self
                .http
                .patch(format!("{DRIVE_UPLOAD_URL}/{id}?uploadType=multipart&fields=id"))
                .bearer_auth(token)
                .header(reqwest::header::CONTENT_TYPE, format!("multipart/related; boundary={boundary}"))
                .body(body)
                .send()
                .await
                .map_err(network_err)?;
            self.set_online(true);
            if resp.status().as_u16() != 404 {
                let resp = ensure_success(resp).await?;
                let file: DriveFile = resp
                    .json()
                    .await
                    .map_err(|e| SyncError::Transient(format!("Respuesta de Drive no válida: {e}")))?;
                return Ok(file.id);
            }
            // El fichero remoto ya no existe: se crea de nuevo.
        }

        let metadata = serde_json::json!({ "name": name, "parents": [parent] });
        let body = build_multipart_body(&boundary, &metadata, mime, &content);
        let resp = self
            .http
            .post(format!("{DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id"))
            .bearer_auth(token)
            .header(reqwest::header::CONTENT_TYPE, format!("multipart/related; boundary={boundary}"))
            .body(body)
            .send()
            .await
            .map_err(network_err)?;
        self.set_online(true);
        if resp.status().as_u16() == 404 {
            // La carpeta destino ya no existe en Drive: se recreará en el siguiente intento.
            self.clear_folder_cache();
            return Err(SyncError::Transient("La carpeta de Drive no existe; se volverá a crear".into()));
        }
        let resp = ensure_success(resp).await?;
        let file: DriveFile = resp
            .json()
            .await
            .map_err(|e| SyncError::Transient(format!("Respuesta de Drive no válida: {e}")))?;
        Ok(file.id)
    }

    async fn delete_remote(&self, token: &str, file_id: &str) -> Result<(), SyncError> {
        let resp = self
            .http
            .delete(format!("{DRIVE_FILES_URL}/{file_id}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(network_err)?;
        self.set_online(true);
        if resp.status().as_u16() == 404 {
            return Ok(());
        }
        ensure_success(resp).await.map(|_| ())
    }

    // ----------------------------- Cola -----------------------------

    async fn process_item(&self, token: &str, item: &SyncQueueItem) -> Result<(), SyncError> {
        let local = |r: Result<(), String>| r.map_err(SyncError::Local);
        if item.action == ACTION_DELETE {
            if let Some(file_id) = item.payload_path.as_deref().filter(|s| !s.is_empty()) {
                self.delete_remote(token, file_id).await?;
            }
            return local(self.db.complete_sync_item(item.id));
        }
        match item.entity_type.as_str() {
            ENTITY_DB_SNAPSHOT => self.upload_snapshot(token, item).await,
            ENTITY_MIDI_FRAGMENT | ENTITY_RAW_MIDI | ENTITY_MEDIA_IMAGE => self.upload_entity(token, item).await,
            other => {
                log::warn!("drive_sync: tipo de entidad desconocido en la cola: {other}");
                local(self.db.complete_sync_item(item.id))
            }
        }
    }

    async fn upload_entity(&self, token: &str, item: &SyncQueueItem) -> Result<(), SyncError> {
        let et = item.entity_type.as_str();
        let eid = item.entity_id.as_str();
        let path = item.payload_path.as_deref().filter(|p| !p.is_empty()).map(PathBuf::from);
        let exists = self.db.entity_exists(et, eid).map_err(SyncError::Local)?;
        let Some(path) = path.filter(|p| p.is_file() && exists) else {
            // Fichero o entidad ya eliminados localmente: nada que subir.
            return self.db.complete_sync_item(item.id).map_err(SyncError::Local);
        };
        let folders = self.ensure_folders(token).await?;
        let parent = if et == ENTITY_MEDIA_IMAGE { &folders.media } else { &folders.midi };
        let existing = self.db.get_drive_file_id(et, eid).map_err(SyncError::Local)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
            .unwrap_or_else(|| eid.to_string());
        let new_id = self.upload_file(token, &path, &name, parent, existing.as_deref()).await?;
        self.db.complete_sync_item(item.id).map_err(SyncError::Local)?;
        self.db.mark_entity_synced(et, eid, Some(&new_id)).map_err(SyncError::Local)?;

        // Si la entidad se borró durante la subida, el fichero recién creado quedaría huérfano.
        if !self.db.entity_exists(et, eid).map_err(SyncError::Local)? && existing.as_deref() != Some(new_id.as_str()) {
            if self.delete_remote(token, &new_id).await.is_err() {
                self.db
                    .enqueue_sync(et, eid, ACTION_DELETE, Some(&new_id))
                    .map_err(SyncError::Local)?;
            }
        }
        Ok(())
    }

    async fn upload_snapshot(&self, token: &str, item: &SyncQueueItem) -> Result<(), SyncError> {
        let folders = self.ensure_folders(token).await?;
        let mut existing = self
            .db
            .get_drive_file_id(ENTITY_DB_SNAPSHOT, SNAPSHOT_ENTITY_ID)
            .map_err(SyncError::Local)?;
        if existing.is_none() {
            existing = self.find_file(token, SNAPSHOT_FILE_NAME, &folders.root, None).await?;
        }
        let dest = self.paths.db_backup_file();
        // Copia consistente + retirada atómica del elemento de la cola.
        self.db.snapshot_for_sync(item.id, &dest).map_err(SyncError::Local)?;
        let id = self
            .upload_file(token, &dest, SNAPSHOT_FILE_NAME, &folders.root, existing.as_deref())
            .await?;
        self.db
            .mark_entity_synced(ENTITY_DB_SNAPSHOT, SNAPSHOT_ENTITY_ID, Some(&id))
            .map_err(SyncError::Local)
    }

    /// Registra el fallo de un elemento. Devuelve `true` si el ciclo debe detenerse.
    fn handle_item_error(&self, item: &SyncQueueItem, err: &SyncError) -> bool {
        let msg = err.message().to_string();
        let still_queued = matches!(self.db.get_sync_item(item.id), Ok(Some(_)));
        let is_snapshot = item.entity_type == ENTITY_DB_SNAPSHOT;
        let stop = match err {
            SyncError::Network(_) | SyncError::Transient(_) | SyncError::Unauthorized(_) => {
                if matches!(err, SyncError::Network(_)) {
                    self.set_online(false);
                }
                if matches!(err, SyncError::Unauthorized(_)) {
                    let _ = self.db.delete_setting(KEY_ACCESS_TOKEN);
                    let _ = self.db.delete_setting(KEY_TOKEN_EXPIRY);
                }
                if still_queued {
                    let _ = self.db.defer_sync_item(item.id, &msg);
                } else if is_snapshot {
                    let _ = self.db.requeue_snapshot((item.retry_count + 1).min(MAX_RETRIES - 1), &msg);
                }
                true
            }
            SyncError::Auth(_) => {
                if !still_queued && is_snapshot {
                    let _ = self.db.requeue_snapshot(item.retry_count, &msg);
                }
                true
            }
            SyncError::Permanent(_) | SyncError::Local(_) => {
                if still_queued {
                    let _ = self.db.fail_sync_item(item.id, &msg);
                } else if is_snapshot {
                    let _ = self.db.requeue_snapshot(item.retry_count + 1, &msg);
                }
                if item.retry_count + 1 >= MAX_RETRIES {
                    let _ = self.db.mark_entity_error(&item.entity_type, &item.entity_id);
                }
                false
            }
        };
        self.set_error(Some(msg));
        stop
    }

    /// Procesa la cola una vez (si hay credenciales y cuenta conectada) y devuelve el estado.
    pub async fn sync_now(self: &Arc<Self>) -> SyncStatusDto {
        let _cycle = self.cycle_lock.lock().await;
        if self.credentials().is_none() || self.setting(KEY_REFRESH_TOKEN).is_none() {
            return self.status();
        }
        let first_batch = match self.db.pending_sync_items(BATCH_SIZE) {
            Ok(items) => items,
            Err(e) => {
                self.set_error(Some(e));
                let status = self.status();
                (self.emitter)(status.clone());
                return status;
            }
        };
        if first_batch.is_empty() {
            return self.status();
        }

        self.rt().is_syncing = true;
        self.emit();

        let mut clean = true;
        let mut batch = first_batch;
        'cycle: for _ in 0..MAX_BATCHES_PER_CYCLE {
            let mut batch_failed = false;
            for item in &batch {
                let result = match self.access_token().await {
                    Ok(token) => self.process_item(&token, item).await,
                    Err(e) => Err(e),
                };
                if let Err(err) = result {
                    clean = false;
                    batch_failed = true;
                    if self.handle_item_error(item, &err) {
                        break 'cycle;
                    }
                }
            }
            if batch_failed {
                break;
            }
            batch = match self.db.pending_sync_items(BATCH_SIZE) {
                Ok(items) if !items.is_empty() => items,
                Ok(_) => break,
                Err(e) => {
                    clean = false;
                    self.set_error(Some(e));
                    break;
                }
            };
        }

        {
            let mut rt = self.rt();
            rt.is_syncing = false;
            if clean {
                rt.last_sync_at = Some(now_rfc3339());
                rt.last_error = None;
                rt.online = true;
            }
        }
        let status = self.status();
        (self.emitter)(status.clone());
        status
    }
}

// ---------------------------------------------------------------------------
// Auxiliares de E/S
// ---------------------------------------------------------------------------

fn open_browser(url: &str) {
    match std::process::Command::new("xdg-open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            // Recoge el proceso para no dejar zombis.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => log::warn!("drive_sync: no se pudo abrir el navegador ({e}); usa la URL mostrada"),
    }
}

async fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    text.lines().next().map(str::to_string).filter(|l| !l.is_empty())
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ACTION_UPLOAD, ENTITY_MIDI_FRAGMENT};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn make_sync() -> (Arc<DriveSync>, Arc<Database>, Arc<AtomicUsize>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&count);
        let emitter: SyncStatusEmitter = Arc::new(move |_s| {
            c.fetch_add(1, Ordering::SeqCst);
        });
        let sync = DriveSync::new(Arc::clone(&db), AppPaths::from_base(dir.path()), emitter);
        (sync, db, count, dir)
    }

    #[test]
    fn pkce_verifier_and_challenge() {
        let v = generate_code_verifier();
        assert!((43..=128).contains(&v.len()));
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
        assert_ne!(v, generate_code_verifier());
        // Vector de prueba del RFC 7636, apéndice B.
        assert_eq!(
            code_challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        // Determinista.
        assert_eq!(code_challenge_s256(&v), code_challenge_s256(&v));
    }

    #[test]
    fn auth_url_contains_loopback_and_scope() {
        let u = build_auth_url("my-client.apps.googleusercontent.com", "http://127.0.0.1:43123", "st4te", "chall");
        assert!(u.starts_with(AUTH_ENDPOINT));
        let parsed = url::Url::parse(&u).unwrap();
        let get = |k: &str| parsed.query_pairs().find(|(kk, _)| kk == k).map(|(_, v)| v.into_owned());
        assert_eq!(get("redirect_uri").as_deref(), Some("http://127.0.0.1:43123"));
        assert_eq!(get("scope").as_deref(), Some(DRIVE_SCOPE));
        assert_eq!(get("client_id").as_deref(), Some("my-client.apps.googleusercontent.com"));
        assert_eq!(get("response_type").as_deref(), Some("code"));
        assert_eq!(get("access_type").as_deref(), Some("offline"));
        assert_eq!(get("prompt").as_deref(), Some("consent"));
        assert_eq!(get("state").as_deref(), Some("st4te"));
        assert_eq!(get("code_challenge").as_deref(), Some("chall"));
        assert_eq!(get("code_challenge_method").as_deref(), Some("S256"));
        assert!(u.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A43123"));
    }

    #[test]
    fn parses_callback_request_line() {
        let p = parse_callback_request("GET /?code=4%2F0Abc-xyz&state=abc123&scope=x HTTP/1.1").unwrap();
        assert_eq!(p.code.as_deref(), Some("4/0Abc-xyz"));
        assert_eq!(p.state.as_deref(), Some("abc123"));
        assert!(p.error.is_none());

        let e = parse_callback_request("GET /?error=access_denied&state=abc123 HTTP/1.1").unwrap();
        assert_eq!(e.error.as_deref(), Some("access_denied"));
        assert!(e.code.is_none());

        assert!(parse_callback_request("GET /favicon.ico HTTP/1.1").is_none());
        assert!(parse_callback_request("POST /?code=x HTTP/1.1").is_none());
        assert!(parse_callback_request("").is_none());
    }

    #[test]
    fn multipart_body_layout() {
        let meta = serde_json::json!({ "name": "frag.mid", "parents": ["p1"] });
        let content = [0x4d, 0x54, 0x68, 0x64, 0x00, 0xff];
        let body = build_multipart_body("BOUNDARY", &meta, "audio/midi", &content);
        let mut expected = Vec::new();
        expected.extend_from_slice(b"--BOUNDARY\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n");
        expected.extend_from_slice(meta.to_string().as_bytes());
        expected.extend_from_slice(b"\r\n--BOUNDARY\r\nContent-Type: audio/midi\r\n\r\n");
        expected.extend_from_slice(&content);
        expected.extend_from_slice(b"\r\n--BOUNDARY--\r\n");
        assert_eq!(body, expected);
    }

    #[test]
    fn mime_types_by_extension() {
        assert_eq!(mime_for_path(Path::new("/a/frag_x.mid")), "audio/midi");
        assert_eq!(mime_for_path(Path::new("img.PNG")), "image/png");
        assert_eq!(mime_for_path(Path::new("img.jpeg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("img.jpg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("img.gif")), "image/gif");
        assert_eq!(mime_for_path(Path::new("img.webp")), "image/webp");
        assert_eq!(mime_for_path(Path::new("piano_tracker_backup.sqlite")), "application/x-sqlite3");
        assert_eq!(mime_for_path(Path::new("x.bin")), "application/octet-stream");
    }

    #[test]
    fn status_classification() {
        assert!(matches!(classify_status(401, ""), SyncError::Unauthorized(_)));
        assert!(matches!(classify_status(429, ""), SyncError::Transient(_)));
        assert!(matches!(classify_status(503, ""), SyncError::Transient(_)));
        assert!(matches!(classify_status(403, "userRateLimitExceeded"), SyncError::Transient(_)));
        assert!(matches!(classify_status(400, "bad"), SyncError::Permanent(_)));
        assert!(matches!(classify_status(403, "forbidden"), SyncError::Permanent(_)));
    }

    #[test]
    fn status_without_credentials() {
        let (sync, db, _count, _dir) = make_sync();
        let s = db.create_session("S", 100).unwrap();
        db.insert_fragment("f1", &s.id, "F", "", "/no/existe.mid", 100, 10).unwrap();
        let st = sync.status();
        assert!(!st.has_credentials);
        assert!(!st.connected);
        assert!(!st.is_syncing);
        assert_eq!(st.pending_count, 2); // DB_SNAPSHOT + MIDI_FRAGMENT
        assert_eq!(st.error_count, 0);
    }

    #[test]
    fn save_credentials_validates_and_clears_tokens() {
        let (sync, db, count, _dir) = make_sync();
        assert!(sync.save_credentials("  ", "x").is_err());
        assert!(sync.save_credentials("id", "").is_err());
        db.set_setting(KEY_REFRESH_TOKEN, "old").unwrap();
        db.set_setting(KEY_ACCESS_TOKEN, "old").unwrap();
        sync.save_credentials(" cid ", "secret").unwrap();
        assert_eq!(db.get_setting(KEY_CLIENT_ID).unwrap().as_deref(), Some("cid"));
        assert!(db.get_setting(KEY_REFRESH_TOKEN).unwrap().is_none());
        assert!(db.get_setting(KEY_ACCESS_TOKEN).unwrap().is_none());
        let st = sync.status();
        assert!(st.has_credentials);
        assert!(!st.connected);
        assert!(count.load(Ordering::SeqCst) >= 1);
    }

    #[tokio::test]
    async fn sync_now_without_credentials_leaves_queue_untouched() {
        let (sync, db, _count, _dir) = make_sync();
        let s = db.create_session("S", 100).unwrap();
        db.insert_fragment("f1", &s.id, "F", "", "/no/existe.mid", 100, 10).unwrap();
        db.enqueue_sync(ENTITY_MIDI_FRAGMENT, "zz", ACTION_UPLOAD, Some("/x.mid")).unwrap();
        let before = db.pending_sync_items(100).unwrap();

        let st = sync.sync_now().await;
        assert!(!st.has_credentials && !st.connected && !st.is_syncing);
        assert_eq!(st.pending_count, 3);
        assert_eq!(db.pending_sync_items(100).unwrap(), before);

        // Con credenciales pero sin cuenta conectada tampoco toca la cola.
        sync.save_credentials("cid", "secret").unwrap();
        let st = sync.sync_now().await;
        assert!(st.has_credentials && !st.connected);
        assert_eq!(db.pending_sync_items(100).unwrap(), before);
    }

    #[tokio::test]
    async fn start_auth_requires_credentials() {
        let (sync, _db, _count, _dir) = make_sync();
        let err = sync.start_auth().await.unwrap_err();
        assert!(err.contains("client_id"));
    }
}
