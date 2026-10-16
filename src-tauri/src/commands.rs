//! Comandos IPC de Tauri (contrato de la sección 5 de la especificación).
//!
//! Todos son `async` para no bloquear el hilo principal de la UI; los módulos que
//! envuelven son síncronos y rápidos salvo el análisis/recorte MIDI.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use base64::Engine as _;
use tauri::{Manager, State};

use crate::audio_engine::AudioEngine;
use crate::i18n;
use crate::midi_recorder::{self, MidiRecorder, MidiSink};
use crate::midi_slicer;
use crate::models::*;
use crate::paths::AppDirs;
use crate::soundfont;
use crate::vault::{self, AppConfig, OpenOutcome, Vault};

/// Máximo de bloques de actividad devueltos al frontend.
const ACTIVITY_BLOCKS: usize = 200;

pub struct AppState {
    /// Directorios de la app ajenos a la bóveda (configuración y SoundFont integrado).
    pub dirs: AppDirs,
    pub config: Mutex<AppConfig>,
    /// Bóveda abierta. `None` hasta que el usuario crea o abre una.
    pub vault: RwLock<Option<Arc<Vault>>>,
    pub recorder: MidiRecorder,
    pub audio: Arc<AudioEngine>,
    /// Sesión que se está grabando ahora mismo (si hay alguna).
    pub recording_session: Mutex<Option<String>>,
    pub soundfont: Arc<Mutex<SoundfontState>>,
}

/// SoundFont activo y si hay una carga en segundo plano en curso.
pub struct SoundfontState {
    pub current: PathBuf,
    pub loading: bool,
}

/// Carga `path` en el motor en un hilo aparte; al terminar actualiza el estado compartido.
/// Si falla, se mantiene el SoundFont anterior.
pub fn load_soundfont_in_background(audio: Arc<AudioEngine>, state: Arc<Mutex<SoundfontState>>, path: PathBuf) {
    let previous = {
        let mut s = state.lock().unwrap_or_else(|p| p.into_inner());
        s.loading = true;
        std::mem::replace(&mut s.current, path.clone())
    };
    std::thread::spawn(move || {
        let result = audio.load_soundfont(&path);
        let mut s = state.lock().unwrap_or_else(|p| p.into_inner());
        s.loading = false;
        if let Err(e) = result {
            log::error!("{e}");
            s.current = previous;
        }
    });
}

impl AppState {
    /// Bóveda abierta, o error si no hay ninguna.
    pub fn vault(&self) -> Result<Arc<Vault>, String> {
        self.vault
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| t!("backend.noVault"))
    }

    fn current_vault(&self) -> Option<Arc<Vault>> {
        self.vault.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn vault_info(&self) -> VaultInfo {
        let config = self.config.lock().unwrap_or_else(|p| p.into_inner());
        vault::vault_info(&config, self.current_vault().as_deref(), &self.dirs)
    }

    /// Guarda la configuración del equipo; un fallo solo se registra.
    fn save_config(&self, config: &AppConfig) {
        if let Err(e) = config.save(&self.dirs.config_file) {
            log::error!("{e}");
        }
    }

    /// Libera la bóveda abierta (lock incluido). Falla si hay una grabación en curso.
    pub fn close_vault(&self) -> Result<(), String> {
        if self.recorder.is_recording() {
            return Err(t!("backend.stopRecordingToSwitchVault"));
        }
        let _ = self.audio.stop();
        let old = self.vault.write().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(old) = old {
            // Si algún comando aún la usa, el lock se libera igualmente ya.
            old.release_lock();
        }
        Ok(())
    }

    fn recording_session(&self) -> Option<String> {
        self.recording_session.lock().ok().and_then(|g| g.clone())
    }

    fn set_recording_session(&self, value: Option<String>) {
        if let Ok(mut g) = self.recording_session.lock() {
            *g = value;
        }
    }

    fn ensure_not_recording(&self, session_id: &str) -> Result<(), String> {
        if self.recording_session().as_deref() == Some(session_id) {
            return Err(t!("backend.sessionIsRecording"));
        }
        Ok(())
    }

    fn raw_path_of(&self, session: &SessionDto) -> Result<PathBuf, String> {
        session
            .raw_midi_path
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .ok_or_else(|| t!("backend.noRawTrack"))
    }
}

fn remove_file_quietly(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("No se pudo borrar {}: {e}", path.display());
        }
    }
}

// ---------------------------------------------------------------------------
// Dispositivos MIDI y grabación
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_midi_ports() -> Result<Vec<MidiPortInfo>, String> {
    Ok(midi_recorder::list_ports())
}

#[tauri::command]
pub async fn start_recording(
    state: State<'_, AppState>,
    session_id: String,
    port_id: String,
    bpm: u32,
    metronome_on: bool,
    live_synth_on: bool,
) -> Result<(), String> {
    let vault = state.vault()?;
    if state.recorder.is_recording() {
        return Err(t!("backend.recorder.alreadyRunning"));
    }
    let session = vault.db.get_session(&session_id)?;
    let bpm = bpm.clamp(40, 240);
    // La pista bruta existente se reanuda acumulando su duración.
    let resume_from = session.raw_midi_path.as_ref().map(PathBuf::from).filter(|p| p.exists());

    state.audio.stop()?;
    state.audio.set_live_synth(live_synth_on);
    state.audio.set_metronome(metronome_on, bpm);

    let audio = state.audio.clone();
    let sink: MidiSink = Arc::new(move |bytes: &[u8]| audio.send_live_midi(bytes));
    if let Err(e) = state.recorder.start(&port_id, bpm, resume_from.as_deref(), sink) {
        state.audio.set_metronome(false, bpm);
        state.audio.set_live_synth(false);
        return Err(e);
    }
    state.set_recording_session(Some(session_id));
    Ok(())
}

#[tauri::command]
pub async fn update_live_recording_settings(
    state: State<'_, AppState>,
    bpm: u32,
    metronome_on: bool,
    live_synth_on: bool,
) -> Result<(), String> {
    let bpm = bpm.clamp(40, 240);
    state.audio.set_metronome(metronome_on, bpm);
    state.audio.set_live_synth(live_synth_on);
    if state.recorder.is_recording() {
        state.recorder.set_bpm(bpm);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_recording(state: State<'_, AppState>, session_id: String) -> Result<SessionDto, String> {
    let vault = state.vault()?;
    if !state.recorder.is_recording() {
        return Err(t!("backend.recorder.notRunning"));
    }
    if let Some(active) = state.recording_session() {
        if active != session_id {
            return Err(t!("backend.recorder.otherSession"));
        }
    }
    let output = vault.paths.raw_session_file(&session_id);
    let result = state.recorder.stop(&output);
    state.set_recording_session(None);
    state.audio.set_metronome(false, 120);
    state.audio.set_live_synth(false);

    let duration_ms = result?;
    let session = vault.db.set_session_raw_midi(&session_id, &output.to_string_lossy(), duration_ms)?;
    Ok(session)
}

// ---------------------------------------------------------------------------
// Recorte y reproducción
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_midi_activity(file_path: String) -> Result<MidiActivityDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        midi_slicer::analyze_midi_activity(Path::new(&file_path), ACTIVITY_BLOCKS)
    })
    .await
    .map_err(|e| t!("backend.internal", e = e))?
}

#[tauri::command]
pub async fn extract_midi_fragment(
    state: State<'_, AppState>,
    req: ExtractFragmentReq,
) -> Result<FragmentCreatedResponse, String> {
    let vault = state.vault()?;
    state.ensure_not_recording(&req.session_id)?;
    if req.end_ms <= req.start_ms {
        return Err(t!("backend.rangeEndBeforeStart"));
    }
    let session = vault.db.get_session(&req.session_id)?;
    let raw = state.raw_path_of(&session)?;
    // El reproductor podría estar leyendo la pista bruta que vamos a reescribir.
    state.audio.stop()?;

    let fragment_id = uuid::Uuid::new_v4().to_string();
    let dest = vault.paths.fragment_file(&fragment_id);
    let slice = {
        let (raw, dest) = (raw.clone(), dest.clone());
        let (start, end, bpm) = (req.start_ms, req.end_ms, session.bpm);
        tauri::async_runtime::spawn_blocking(move || midi_slicer::extract_fragment_and_trim(&raw, start, end, &dest, bpm))
            .await
            .map_err(|e| t!("backend.internal", e = e))??
    };

    let title = if req.title.trim().is_empty() { t!("backend.defaults.fragmentTitle") } else { req.title.trim().to_string() };
    let fragment = match vault.db.insert_fragment(
        &fragment_id,
        &req.session_id,
        &title,
        req.explanation.trim(),
        &dest.to_string_lossy(),
        session.bpm,
        slice.fragment_duration_ms,
    ) {
        Ok(f) => f,
        Err(e) => {
            remove_file_quietly(&dest);
            return Err(e);
        }
    };
    let session = vault
        .db
        .set_session_raw_midi(&req.session_id, &raw.to_string_lossy(), slice.remaining_duration_ms)?;
    Ok(FragmentCreatedResponse { fragment, session })
}

#[tauri::command]
pub async fn discard_midi_range(
    state: State<'_, AppState>,
    session_id: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<SessionDto, String> {
    let vault = state.vault()?;
    state.ensure_not_recording(&session_id)?;
    if end_ms <= start_ms {
        return Err(t!("backend.rangeEndBeforeStart"));
    }
    let session = vault.db.get_session(&session_id)?;
    let raw = state.raw_path_of(&session)?;
    state.audio.stop()?;

    let new_duration = {
        let (raw, bpm) = (raw.clone(), session.bpm);
        tauri::async_runtime::spawn_blocking(move || midi_slicer::discard_range(&raw, start_ms, end_ms, bpm))
            .await
            .map_err(|e| t!("backend.internal", e = e))??
    };
    let session = vault.db.set_session_raw_midi(&session_id, &raw.to_string_lossy(), new_duration)?;
    Ok(session)
}

#[tauri::command]
pub async fn play_midi_file(state: State<'_, AppState>, file_path: String, start_ms: u64) -> Result<(), String> {
    state.audio.play_file(Path::new(&file_path), start_ms)
}

#[tauri::command]
pub async fn pause_midi_playback(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.pause()
}

#[tauri::command]
pub async fn seek_midi_playback(state: State<'_, AppState>, ms: u64) -> Result<(), String> {
    state.audio.seek(ms)
}

#[tauri::command]
pub async fn stop_midi_playback(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.stop()
}

// ---------------------------------------------------------------------------
// Sesiones, fragmentos y comentarios
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummaryDto>, String> {
    let vault = state.vault()?;
    vault.db.list_sessions()
}

#[tauri::command]
pub async fn get_session_detail(state: State<'_, AppState>, session_id: String) -> Result<SessionDetailDto, String> {
    let vault = state.vault()?;
    vault.db.get_session_detail(&session_id)
}

#[tauri::command]
pub async fn create_session(state: State<'_, AppState>, title: String, bpm: u32) -> Result<SessionDetailDto, String> {
    let vault = state.vault()?;
    let title = if title.trim().is_empty() { t!("backend.defaults.sessionTitle") } else { title.trim().to_string() };
    let session = vault.db.create_session(&title, bpm.clamp(40, 240))?;
    vault.db.get_session_detail(&session.id)
}

#[tauri::command]
pub async fn update_session(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    bpm: u32,
    markdown_notes: String,
) -> Result<(), String> {
    let vault = state.vault()?;
    vault.db.update_session(&session_id, title.trim(), bpm.clamp(40, 240), &markdown_notes)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let vault = state.vault()?;
    state.ensure_not_recording(&session_id)?;
    state.audio.stop()?;
    for path in vault.db.delete_session(&session_id)? {
        remove_file_quietly(Path::new(&path));
    }
    Ok(())
}

/// Nombre de fichero seguro: solo `[A-Za-z0-9._-]`, sin rutas, con extensión de imagen.
fn sanitize_image_name(file_name: &str, bytes: &[u8]) -> String {
    let base = Path::new(file_name).file_name().and_then(|n| n.to_str()).unwrap_or("imagen");
    let mut clean: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    clean = clean.trim_matches('.').to_string();
    if clean.is_empty() {
        clean = "imagen".into();
    }
    let has_ext = Path::new(&clean)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp"))
        .unwrap_or(false);
    if !has_ext {
        let ext = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
            "png"
        } else if bytes.starts_with(&[0xFF, 0xD8]) {
            "jpg"
        } else if bytes.starts_with(b"GIF8") {
            "gif"
        } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
            "webp"
        } else {
            "png"
        };
        clean = format!("{clean}.{ext}");
    }
    clean
}

#[tauri::command]
pub async fn save_session_image(
    state: State<'_, AppState>,
    session_id: String,
    file_name: String,
    base64_data: String,
) -> Result<String, String> {
    let vault = state.vault()?;
    // Tolera un prefijo `data:image/png;base64,` por si el frontend lo envía.
    let payload = base64_data.split_once(',').map(|(_, b)| b).unwrap_or(&base64_data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| t!("backend.image.invalidBase64", e = e))?;
    if bytes.is_empty() {
        return Err(t!("backend.image.empty"));
    }
    vault.db.get_session(&session_id)?;

    let short_id = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("{}_{}", &short_id[..8], sanitize_image_name(&file_name, &bytes));
    let dest = vault.paths.media_dir.join(name);
    std::fs::write(&dest, &bytes).map_err(|e| t!("backend.image.saveFailed", e = e))?;
    if let Err(e) = vault.db.insert_media(&session_id, &dest.to_string_lossy()) {
        remove_file_quietly(&dest);
        return Err(e);
    }
    // El Markdown guarda la ruta relativa a la bóveda, para que siga valiendo en otro equipo.
    vault
        .paths
        .to_relative(&dest)
        .ok_or_else(|| t!("backend.image.outsideVault", path = dest.display()))
}

#[tauri::command]
pub async fn update_fragment_meta(
    state: State<'_, AppState>,
    fragment_id: String,
    title: String,
    explanation: String,
) -> Result<(), String> {
    let vault = state.vault()?;
    vault.db.update_fragment_meta(&fragment_id, title.trim(), &explanation)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_fragment(state: State<'_, AppState>, fragment_id: String) -> Result<(), String> {
    let vault = state.vault()?;
    state.audio.stop()?;
    let path = vault.db.delete_fragment(&fragment_id)?;
    remove_file_quietly(Path::new(&path));
    Ok(())
}

#[tauri::command]
pub async fn add_timeline_comment(
    state: State<'_, AppState>,
    fragment_id: String,
    timestamp_ms: u64,
    content: String,
) -> Result<TimelineCommentDto, String> {
    let vault = state.vault()?;
    let content = content.trim();
    if content.is_empty() {
        return Err(t!("backend.commentEmpty"));
    }
    let comment = vault.db.add_timeline_comment(&fragment_id, timestamp_ms, content)?;
    Ok(comment)
}

#[tauri::command]
pub async fn delete_timeline_comment(state: State<'_, AppState>, comment_id: String) -> Result<(), String> {
    let vault = state.vault()?;
    vault.db.delete_timeline_comment(&comment_id)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// SoundFont (sonido del sintetizador)
// ---------------------------------------------------------------------------

fn soundfont_info(state: &AppState) -> SoundfontInfo {
    let (current, loading) = {
        let s = state.soundfont.lock().unwrap_or_else(|p| p.into_inner());
        (s.current.to_string_lossy().into_owned(), s.loading)
    };
    SoundfontInfo { current_path: current, loading, candidates: soundfont::discover(&state.dirs) }
}

#[tauri::command]
pub async fn get_soundfont_info(state: State<'_, AppState>) -> Result<SoundfontInfo, String> {
    Ok(soundfont_info(&state))
}

/// Carga el SoundFont indicado (puede tardar unos segundos con ficheros grandes) y lo recuerda.
#[tauri::command]
pub async fn set_soundfont(state: State<'_, AppState>, path: String) -> Result<SoundfontInfo, String> {
    let path = PathBuf::from(path.trim());
    let is_sf2 = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("sf2"));
    if !is_sf2 || !path.is_file() {
        return Err(t!("backend.soundfont.invalidFile"));
    }
    {
        let mut s = state.soundfont.lock().unwrap_or_else(|p| p.into_inner());
        if s.loading {
            return Err(t!("backend.soundfont.busy"));
        }
        s.loading = true;
    }
    let audio = state.audio.clone();
    let target = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || audio.load_soundfont(&target))
        .await
        .map_err(|e| t!("backend.internal", e = e))
        .and_then(|r| r);
    {
        let mut s = state.soundfont.lock().unwrap_or_else(|p| p.into_inner());
        s.loading = false;
        if result.is_ok() {
            s.current = path.clone();
        }
    }
    result?;
    {
        let mut config = state.config.lock().unwrap_or_else(|p| p.into_inner());
        config.soundfont_path = Some(path.to_string_lossy().into_owned());
        state.save_config(&config);
    }
    Ok(soundfont_info(&state))
}

// ---------------------------------------------------------------------------
// Bóveda
// ---------------------------------------------------------------------------

/// Abre la bóveda de `dir` y la hace actual: cierra la anterior, la recuerda en la configuración,
/// adopta el SoundFont que la versión anterior guardaba en la base de datos y permite al asset
/// protocol servir sus imágenes.
pub fn activate_vault(app: &tauri::AppHandle, state: &AppState, dir: &Path, force: bool) -> Result<VaultOpenResult, String> {
    let dir = vault::normalize(dir);
    if state.current_vault().is_some_and(|v| v.paths.base == dir) {
        return Ok(VaultOpenResult { info: state.vault_info(), opened: true, lock_warning: None });
    }
    if state.recorder.is_recording() {
        return Err(t!("backend.stopRecordingToSwitchVault"));
    }
    // Se comprueba antes de cerrar la actual: si la nueva no vale o está bloqueada, sigue abierta.
    if let Some(msg) = vault::precheck(&dir, force)? {
        return Ok(VaultOpenResult { info: state.vault_info(), opened: false, lock_warning: Some(msg) });
    }
    state.close_vault()?;
    let opened = match vault::open_vault(&dir, true)? {
        OpenOutcome::Opened(v) => v,
        OpenOutcome::Locked(msg) => {
            return Ok(VaultOpenResult { info: state.vault_info(), opened: false, lock_warning: Some(msg) })
        }
    };

    if let Err(e) = app.asset_protocol_scope().allow_directory(&opened.paths.base, true) {
        log::warn!("No se pudo permitir el acceso a las imágenes de la bóveda: {e}");
    }
    {
        let mut config = state.config.lock().unwrap_or_else(|p| p.into_inner());
        if let Ok(Some(sf)) = opened.db.get_setting(soundfont::LEGACY_SETTING_SOUNDFONT_PATH) {
            if config.soundfont_path.is_none() {
                config.soundfont_path = Some(sf);
            }
            let _ = opened.db.delete_setting(soundfont::LEGACY_SETTING_SOUNDFONT_PATH);
        }
        config.set_current(&dir.to_string_lossy());
        state.save_config(&config);
    }
    *state.vault.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(opened));
    Ok(VaultOpenResult { info: state.vault_info(), opened: true, lock_warning: None })
}

#[tauri::command]
pub async fn get_vault_info(state: State<'_, AppState>) -> Result<VaultInfo, String> {
    Ok(state.vault_info())
}

/// Crea una bóveda vacía en `path` (carpeta nueva o vacía) y la abre.
#[tauri::command]
pub async fn create_vault(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Result<VaultInfo, String> {
    let dir = PathBuf::from(path.trim());
    vault::create_vault(&dir)?;
    activate_vault(&app, &state, &dir, false).map(|r| r.info)
}

/// Abre una bóveda existente. Si parece abierta en otro equipo devuelve `opened = false` y el
/// aviso; el frontend puede reintentar con `force = true`.
#[tauri::command]
pub async fn open_vault(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    force: bool,
) -> Result<VaultOpenResult, String> {
    activate_vault(&app, &state, Path::new(path.trim()), force)
}

/// Crea una bóveda en `path` con los datos de la versión anterior (se mueven) y la abre.
#[tauri::command]
pub async fn import_legacy_data(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Result<VaultInfo, String> {
    if state.recorder.is_recording() {
        return Err(t!("backend.stopRecordingToImport"));
    }
    let dest = PathBuf::from(path.trim());
    let legacy = state.dirs.data_dir.clone();
    // La base de datos antigua no puede estar abierta mientras se mueve.
    if state.current_vault().is_some_and(|v| vault::normalize(&v.paths.base) == vault::normalize(&legacy)) {
        state.close_vault()?;
    }
    {
        let (legacy, dest) = (legacy.clone(), dest.clone());
        tauri::async_runtime::spawn_blocking(move || vault::import_legacy(&legacy, &dest))
            .await
            .map_err(|e| t!("backend.internal", e = e))??;
    }
    activate_vault(&app, &state, &dest, false).map(|r| r.info)
}

/// Cierra la bóveda actual (para elegir otra). La app vuelve a la pantalla de bienvenida.
#[tauri::command]
pub async fn close_vault(state: State<'_, AppState>) -> Result<VaultInfo, String> {
    state.close_vault()?;
    {
        let mut config = state.config.lock().unwrap_or_else(|p| p.into_inner());
        config.current_vault = None;
        state.save_config(&config);
    }
    Ok(state.vault_info())
}

/// Olvida una bóveda de la lista de recientes (no borra nada en disco).
#[tauri::command]
pub async fn forget_recent_vault(state: State<'_, AppState>, path: String) -> Result<VaultInfo, String> {
    {
        let mut config = state.config.lock().unwrap_or_else(|p| p.into_inner());
        config.recent_vaults.retain(|p| p != &path);
        state.save_config(&config);
    }
    Ok(state.vault_info())
}

/// Abre la carpeta de la bóveda en el gestor de archivos.
#[tauri::command]
pub async fn reveal_vault(state: State<'_, AppState>) -> Result<(), String> {
    let vault = state.vault()?;
    std::process::Command::new("xdg-open")
        .arg(&vault.paths.base)
        .spawn()
        .map(|mut child| {
            // Recoge el proceso al terminar para no dejar zombis.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        })
        .map_err(|e| t!("backend.revealFailed", e = e))
}

// ---------------------------------------------------------------------------
// Idioma
// ---------------------------------------------------------------------------

fn language_info(config: &AppConfig) -> LanguageInfo {
    LanguageInfo {
        preference: config.language.clone(),
        effective: i18n::current().to_string(),
        system: i18n::system_language().to_string(),
    }
}

#[tauri::command]
pub async fn get_language(state: State<'_, AppState>) -> Result<LanguageInfo, String> {
    Ok(language_info(&state.config.lock().unwrap_or_else(|p| p.into_inner())))
}

/// Cambia el idioma de los mensajes del backend y lo recuerda; `None` vuelve al del sistema.
#[tauri::command]
pub async fn set_language(state: State<'_, AppState>, language: Option<String>) -> Result<LanguageInfo, String> {
    let preference = language.as_deref().and_then(i18n::normalize).map(str::to_string);
    i18n::set_language(i18n::resolve(preference.as_deref()));
    let mut config = state.config.lock().unwrap_or_else(|p| p.into_inner());
    config.language = preference;
    state.save_config(&config);
    Ok(language_info(&config))
}

#[cfg(test)]
mod tests {
    use super::sanitize_image_name;

    #[test]
    fn sanitizes_image_names() {
        let png = [0x89, b'P', b'N', b'G', 0, 0];
        assert_eq!(sanitize_image_name("../../etc/passwd", &png), "passwd.png");
        assert_eq!(sanitize_image_name("mi foto.JPG", &[]), "mi_foto.JPG");
        assert_eq!(sanitize_image_name("", &[0xFF, 0xD8, 0]), "imagen.jpg");
        assert_eq!(sanitize_image_name("...", &png), "imagen.png");
    }
}
