//! Bóvedas: carpetas elegidas por el usuario donde viven todos los datos (base de datos, MIDI e
//! imágenes), al estilo de Obsidian. El usuario decide dónde ponerlas (p. ej. dentro de la
//! carpeta de Dropbox) y la app no sincroniza nada por su cuenta.
//!
//! - La configuración del equipo (bóveda actual, recientes, SoundFont) va fuera de la bóveda,
//!   en [`AppConfig`].
//! - Mientras una bóveda está abierta hay un fichero `.piano-tracker/lock` con el equipo y el pid.
//!   Si al abrirla hay un lock de otro equipo (o de otro proceso vivo en este), se pide
//!   confirmación: abrir la misma base de datos en dos equipos a la vez acaba en copias en
//!   conflicto del servicio de sincronización.
//!
//! No importa `tauri::`, para poder testearlo sin app.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::models::{RecentVault, VaultInfo};
use crate::paths::{AppDirs, AppPaths, DB_FILE_NAME, VAULT_MARKER_DIR};

/// Máximo de bóvedas recientes recordadas.
const MAX_RECENT: usize = 10;
/// Formato del marcador `vault.json`.
const VAULT_FORMAT: u32 = 1;

// ---------------------------------------------------------------------------
// Configuración del equipo
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub current_vault: Option<String>,
    /// Más recientes primero.
    pub recent_vaults: Vec<String>,
    /// SoundFont elegido en Ajustes (depende del equipo, por eso no va en la bóveda).
    pub soundfont_path: Option<String>,
    /// Idioma de la interfaz (`"en"`, `"es"`…); `None` sigue al del sistema.
    pub language: Option<String>,
}

impl AppConfig {
    /// Lee la configuración; si falta o está dañada, devuelve la de por defecto.
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                log::warn!("Configuración no válida en {}: {e}; se usa la de por defecto", path.display());
                AppConfig::default()
            }),
            Err(_) => AppConfig::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| t!("backend.io.serializeConfig", e = e))?;
        write_atomic(path, text.as_bytes())
    }

    /// Marca `path` como bóveda actual y la pone la primera de las recientes.
    pub fn set_current(&mut self, path: &str) {
        self.current_vault = Some(path.to_string());
        self.recent_vaults.retain(|p| p != path);
        self.recent_vaults.insert(0, path.to_string());
        self.recent_vaults.truncate(MAX_RECENT);
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| t!("backend.io.createDir", path = parent.display(), e = e))?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| t!("backend.io.write", path = tmp.display(), e = e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        t!("backend.io.save", path = path.display(), e = e)
    })
}

// ---------------------------------------------------------------------------
// Bóveda abierta
// ---------------------------------------------------------------------------

/// Bóveda abierta: rutas y base de datos. Al soltarse libera el lock.
pub struct Vault {
    pub paths: AppPaths,
    pub db: Arc<Database>,
}

impl Vault {
    pub fn name(&self) -> String {
        folder_name(&self.paths.base)
    }

    /// Borra el lock si es de este proceso.
    pub fn release_lock(&self) {
        let lock = self.paths.lock_file();
        if read_lock(&lock).is_some_and(|l| l.host == hostname() && l.pid == std::process::id()) {
            if let Err(e) = std::fs::remove_file(&lock) {
                log::warn!("No se pudo borrar {}: {e}", lock.display());
            }
        }
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        self.release_lock();
    }
}

/// Resultado de intentar abrir una bóveda.
pub enum OpenOutcome {
    Opened(Vault),
    /// Parece abierta en otro sitio; el texto explica dónde. Se puede reintentar con `force`.
    Locked(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LockInfo {
    host: String,
    pid: u32,
    opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultMarker {
    format: u32,
    created_at: String,
}

fn hostname() -> String {
    ["/proc/sys/kernel/hostname", "/etc/hostname"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "este equipo".to_string())
}

fn pid_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

fn read_lock(path: &Path) -> Option<LockInfo> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Ruta canónica si existe (evita duplicados en recientes por `/` finales o `..`).
pub fn normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// La carpeta es una bóveda: tiene el marcador o, como la carpeta de la versión anterior,
/// directamente la base de datos.
pub fn is_vault(dir: &Path) -> bool {
    dir.join(VAULT_MARKER_DIR).is_dir() || dir.join(DB_FILE_NAME).is_file()
}

fn is_empty_dir(dir: &Path) -> Result<bool, String> {
    let mut entries = std::fs::read_dir(dir).map_err(|e| t!("backend.io.read", path = dir.display(), e = e))?;
    Ok(entries.next().is_none())
}

/// Comprueba que `dir` sirve para una bóveda nueva: no existe o está vacía.
fn check_new_vault_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err(t!("backend.vault.pathNotAbsolute"));
    }
    if dir.exists() {
        if !dir.is_dir() {
            return Err(t!("backend.vault.notAFolder", path = dir.display()));
        }
        if is_vault(dir) {
            return Err(t!("backend.vault.alreadyVault", path = dir.display()));
        }
        if !is_empty_dir(dir)? {
            return Err(t!("backend.vault.notEmpty", path = dir.display()));
        }
    }
    Ok(())
}

fn write_marker_if_missing(paths: &AppPaths) -> Result<(), String> {
    let file = paths.vault_file();
    if file.exists() {
        return Ok(());
    }
    let marker = VaultMarker { format: VAULT_FORMAT, created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true) };
    let text = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    write_atomic(&file, text.as_bytes())
}

/// Crea la estructura de una bóveda nueva en `dir` (que no debe existir o estar vacía).
pub fn create_vault(dir: &Path) -> Result<(), String> {
    check_new_vault_dir(dir)?;
    let paths = AppPaths::from_base(dir);
    paths.ensure_dirs()?;
    write_marker_if_missing(&paths)
}

/// Mensaje de aviso si la bóveda tiene un lock de otro equipo o de otro proceso vivo.
fn foreign_lock_message(paths: &AppPaths) -> Option<String> {
    let lock = read_lock(&paths.lock_file())?;
    let me = hostname();
    if lock.host == me && (lock.pid == std::process::id() || !pid_alive(lock.pid)) {
        return None;
    }
    // El formato viene de la traducción: si estuviese mal escrito, `to_string` entraría en pánico.
    let date_format = t!("backend.vault.lockDateFormat");
    let when = DateTime::parse_from_rfc3339(&lock.opened_at)
        .ok()
        .and_then(|d| {
            let mut out = String::new();
            write!(out, "{}", d.with_timezone(&Local).format(&date_format)).ok().map(|_| out)
        })
        .unwrap_or(lock.opened_at);
    let place = if lock.host == me {
        t!("backend.vault.lockPlaceThisComputer")
    } else {
        t!("backend.vault.lockPlaceOtherComputer", host = lock.host)
    };
    Some(t!("backend.vault.lockWarning", place = place, when = when))
}

/// Comprueba que `dir` es una bóveda que se puede abrir. Devuelve el aviso de lock ajeno
/// (si lo hay y no se fuerza) sin modificar nada.
pub fn precheck(dir: &Path, force: bool) -> Result<Option<String>, String> {
    if !dir.is_dir() {
        return Err(t!("backend.vault.missing", path = dir.display()));
    }
    if !is_vault(dir) {
        return Err(t!("backend.vault.notAVault", path = dir.display()));
    }
    Ok(if force { None } else { foreign_lock_message(&AppPaths::from_base(dir)) })
}

/// Abre la bóveda de `dir`: valida, comprueba el lock, lo escribe y abre la base de datos
/// (aplicando migraciones). Con `force` ignora un lock ajeno.
pub fn open_vault(dir: &Path, force: bool) -> Result<OpenOutcome, String> {
    if let Some(msg) = precheck(dir, force)? {
        return Ok(OpenOutcome::Locked(msg));
    }
    let paths = AppPaths::from_base(dir);
    paths.ensure_dirs()?;
    write_marker_if_missing(&paths)?;
    let lock = LockInfo {
        host: hostname(),
        pid: std::process::id(),
        opened_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
    };
    write_atomic(&paths.lock_file(), serde_json::to_string(&lock).map_err(|e| e.to_string())?.as_bytes())?;
    let db = match Database::open(&paths.db_file, &paths.base) {
        Ok(db) => db,
        Err(e) => {
            let _ = std::fs::remove_file(paths.lock_file());
            return Err(e);
        }
    };
    Ok(OpenOutcome::Opened(Vault { db: Arc::new(db), paths }))
}

/// Copias en conflicto de la base de datos creadas por servicios de sincronización
/// (Dropbox: `piano_tracker (… conflicted copy …).sqlite`; Syncthing: `….sync-conflict-….sqlite`).
pub fn conflict_copies(paths: &AppPaths) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(&paths.base) else { return Vec::new() };
    let mut out: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|name| {
            let lower = name.to_lowercase();
            name != DB_FILE_NAME && lower.starts_with("piano_tracker") && lower.contains("conflict")
        })
        .collect();
    out.sort();
    out
}

/// Información para el frontend.
pub fn vault_info(config: &AppConfig, current: Option<&Vault>, dirs: &AppDirs) -> VaultInfo {
    let recent = config
        .recent_vaults
        .iter()
        .map(|p| {
            let path = Path::new(p);
            RecentVault { path: p.clone(), name: folder_name(path), available: path.is_dir() && is_vault(path) }
        })
        .collect();
    let in_legacy = current.is_some_and(|v| normalize(&v.paths.base) == normalize(&dirs.data_dir));
    let legacy_data_path = dirs
        .legacy_db()
        .filter(|_| !in_legacy)
        .map(|_| dirs.data_dir.to_string_lossy().into_owned());
    let warnings = current
        .map(|v| {
            conflict_copies(&v.paths)
                .into_iter()
                .map(|name| t!("backend.vault.conflictCopy", name = name, db = DB_FILE_NAME))
                .collect()
        })
        .unwrap_or_default();
    VaultInfo {
        current: current.map(|v| v.paths.base.to_string_lossy().into_owned()),
        name: current.map(Vault::name),
        recent,
        legacy_data_path,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Importar los datos de la versión anterior
// ---------------------------------------------------------------------------

/// Mueve un fichero o carpeta; si `rename` falla (p. ej. entre discos), copia y borra.
fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_recursive(from, to)?;
    let removed = if from.is_dir() { std::fs::remove_dir_all(from) } else { std::fs::remove_file(from) };
    removed.map_err(|e| t!("backend.io.movedButNotRemoved", path = from.display(), e = e))
}

fn copy_recursive(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        std::fs::create_dir_all(to).map_err(|e| t!("backend.io.createDir", path = to.display(), e = e))?;
        let entries = std::fs::read_dir(from).map_err(|e| t!("backend.io.read", path = from.display(), e = e))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| t!("backend.io.copy", from = from.display(), to = to.display(), e = e))
    }
}

/// Crea una bóveda en `dest` moviendo a ella la base de datos, los MIDI y las imágenes de la
/// carpeta de la versión anterior. Las rutas absolutas se convierten al abrirla (migración v2).
pub fn import_legacy(legacy_dir: &Path, dest: &Path) -> Result<(), String> {
    let legacy_db = legacy_dir.join(DB_FILE_NAME);
    if !legacy_db.is_file() {
        return Err(t!("backend.legacy.noData", path = legacy_dir.display()));
    }
    if normalize(dest).starts_with(normalize(legacy_dir)) {
        return Err(t!("backend.legacy.destInside"));
    }
    check_new_vault_dir(dest)?;
    // Vuelca el WAL antiguo en el fichero principal para mover un único fichero coherente.
    {
        let conn = rusqlite::Connection::open(&legacy_db)
            .map_err(|e| t!("backend.io.open", path = legacy_db.display(), e = e))?;
        conn.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get::<_, String>(0))
            .map_err(|e| t!("backend.legacy.prepareFailed", path = legacy_db.display(), e = e))?;
    }
    std::fs::create_dir_all(dest).map_err(|e| t!("backend.io.createDir", path = dest.display(), e = e))?;
    move_path(&legacy_db, &dest.join(DB_FILE_NAME))?;
    for sub in ["midi", "media"] {
        let from = legacy_dir.join(sub);
        if from.exists() {
            move_path(&from, &dest.join(sub))?;
        }
    }
    let paths = AppPaths::from_base(dest);
    paths.ensure_dirs()?;
    write_marker_if_missing(&paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened(outcome: OpenOutcome) -> Vault {
        match outcome {
            OpenOutcome::Opened(v) => v,
            OpenOutcome::Locked(msg) => panic!("bloqueada: {msg}"),
        }
    }

    #[test]
    fn config_roundtrip_and_recents() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("conf").join("config.json");
        assert_eq!(AppConfig::load(&file), AppConfig::default());
        let mut c = AppConfig::default();
        for i in 0..12 {
            c.set_current(&format!("/v{i}"));
        }
        c.set_current("/v5");
        assert_eq!(c.current_vault.as_deref(), Some("/v5"));
        assert_eq!(c.recent_vaults.len(), MAX_RECENT);
        assert_eq!(c.recent_vaults[0], "/v5");
        assert_eq!(c.recent_vaults.iter().filter(|p| *p == "/v5").count(), 1);
        c.soundfont_path = Some("/x.sf2".into());
        c.save(&file).unwrap();
        assert_eq!(AppConfig::load(&file), c);
        std::fs::write(&file, "{ roto").unwrap();
        assert_eq!(AppConfig::load(&file), AppConfig::default());
    }

    #[test]
    fn create_requires_empty_folder_and_opens() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path().join("Mi bóveda");
        create_vault(&v).unwrap();
        assert!(v.join(".piano-tracker/vault.json").is_file());
        assert!(v.join("midi/raw").is_dir() && v.join("midi/fragments").is_dir() && v.join("media").is_dir());
        assert!(create_vault(&v).unwrap_err().contains("already a vault"));

        let busy = dir.path().join("ocupada");
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::write(busy.join("x.txt"), b"x").unwrap();
        assert!(create_vault(&busy).unwrap_err().contains("is not empty"));
        assert!(create_vault(Path::new("relativa")).is_err());

        let vault = opened(open_vault(&v, false).unwrap());
        assert!(v.join("piano_tracker.sqlite").is_file());
        assert!(v.join(".piano-tracker/lock").is_file());
        assert_eq!(vault.name(), "Mi bóveda");
        // Reabrir desde el mismo proceso no se considera un lock ajeno.
        assert!(matches!(open_vault(&v, false).unwrap(), OpenOutcome::Opened(_)));
    }

    #[test]
    fn not_a_vault_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let err = |d: &Path| open_vault(d, false).err().expect("debería fallar");
        assert!(err(dir.path()).contains("is not a Piano Tracker vault"));
        assert!(err(&dir.path().join("nope")).contains("does not exist"));
    }

    #[test]
    fn foreign_lock_asks_for_confirmation_and_drop_releases() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path().join("b");
        create_vault(&v).unwrap();
        let paths = AppPaths::from_base(&v);
        let other = LockInfo { host: "otro-equipo".into(), pid: 1, opened_at: "2026-10-15T08:00:00Z".into() };
        std::fs::write(paths.lock_file(), serde_json::to_string(&other).unwrap()).unwrap();
        match open_vault(&v, false).unwrap() {
            OpenOutcome::Locked(msg) => assert!(msg.contains("otro-equipo"), "{msg}"),
            OpenOutcome::Opened(_) => panic!("debería pedir confirmación"),
        }
        let vault = opened(open_vault(&v, true).unwrap());
        assert_eq!(read_lock(&paths.lock_file()).unwrap().pid, std::process::id());
        drop(vault);
        assert!(!paths.lock_file().exists());

        // Lock huérfano de este mismo equipo (pid muerto): se ignora.
        let stale = LockInfo { host: hostname(), pid: u32::MAX - 1, opened_at: "x".into() };
        std::fs::write(paths.lock_file(), serde_json::to_string(&stale).unwrap()).unwrap();
        assert!(matches!(open_vault(&v, false).unwrap(), OpenOutcome::Opened(_)));
    }

    #[test]
    fn detects_conflicted_copies_and_builds_info() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path().join("b");
        create_vault(&v).unwrap();
        std::fs::write(v.join("piano_tracker (portátil's conflicted copy 2026-10-15).sqlite"), b"").unwrap();
        std::fs::write(v.join("piano_tracker.sync-conflict-20261015-101010-ABC.sqlite"), b"").unwrap();
        std::fs::write(v.join("piano_tracker_backup.sqlite"), b"").unwrap();
        let vault = opened(open_vault(&v, false).unwrap());
        assert_eq!(conflict_copies(&vault.paths).len(), 2);

        let dirs = AppDirs::new(dir.path().join("data"), dir.path().join("conf"));
        let mut config = AppConfig::default();
        config.set_current(&v.to_string_lossy());
        config.recent_vaults.push("/no/existe".into());
        let info = vault_info(&config, Some(&vault), &dirs);
        assert_eq!(info.current.as_deref(), Some(v.to_string_lossy().as_ref()));
        assert_eq!(info.name.as_deref(), Some("b"));
        assert_eq!(info.warnings.len(), 2);
        assert!(info.recent[0].available && !info.recent[1].available);
        assert_eq!(info.legacy_data_path, None);
    }

    #[test]
    fn imports_legacy_data_with_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("data");
        let old = AppPaths::from_base(&legacy);
        old.ensure_dirs().unwrap();
        // Base de datos "antigua": ficheros con rutas absolutas bajo la carpeta de datos.
        {
            let db = Database::open(&old.db_file, Path::new("/otra-raiz")).unwrap();
            let s = db.create_session("Vieja", 90).unwrap();
            let raw = old.raw_session_file(&s.id);
            std::fs::write(&raw, b"raw").unwrap();
            db.set_session_raw_midi(&s.id, &raw.to_string_lossy(), 10).unwrap();
            let img = old.media_dir.join("a.png");
            std::fs::write(&img, b"img").unwrap();
            db.insert_media(&s.id, &img.to_string_lossy()).unwrap();
            db.update_session(&s.id, "Vieja", 90, &format!("![a]({})", img.display())).unwrap();
            // Simula el esquema v1: rutas absolutas y versión 1 (la migración v2 las reescribe).
            let conn = rusqlite::Connection::open(&old.db_file).unwrap();
            conn.execute_batch("PRAGMA user_version = 1; ALTER TABLE sessions ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'PENDING'; \
                 ALTER TABLE midi_fragments ADD COLUMN drive_file_id TEXT; ALTER TABLE midi_fragments ADD COLUMN sync_status TEXT; \
                 ALTER TABLE session_media ADD COLUMN drive_file_id TEXT; ALTER TABLE session_media ADD COLUMN sync_status TEXT; \
                 CREATE TABLE sync_queue (id INTEGER PRIMARY KEY);")
                .unwrap();
        }
        let dirs = AppDirs::new(&legacy, dir.path().join("conf"));
        assert!(dirs.legacy_db().is_some());

        let dest = dir.path().join("Dropbox").join("PianoTracker");
        assert!(import_legacy(&legacy, &legacy.join("dentro")).is_err());
        import_legacy(&legacy, &dest).unwrap();
        assert!(dirs.legacy_db().is_none());
        assert!(!legacy.join("midi").exists() && !legacy.join("media").exists());

        let vault = opened(open_vault(&dest, false).unwrap());
        let list = vault.db.list_sessions().unwrap();
        let d = vault.db.get_session_detail(&list[0].id).unwrap();
        let raw = PathBuf::from(d.session.raw_midi_path.unwrap());
        assert!(raw.starts_with(&dest) && raw.is_file(), "{}", raw.display());
        assert_eq!(std::fs::read(&d.media[0].local_path).unwrap(), b"img");
        assert_eq!(d.session.markdown_notes, "![a](media/a.png)");
    }
}
