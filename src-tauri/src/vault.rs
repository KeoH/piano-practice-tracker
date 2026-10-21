//! Vaults: folders chosen by the user where all the data lives (database, MIDI and images),
//! Obsidian-style. The user decides where to put them (e.g. inside the Dropbox folder) and the
//! app does not sync anything on its own.
//!
//! - The machine's configuration (current vault, recent ones, SoundFont) lives outside the
//!   vault, in [`AppConfig`].
//! - While a vault is open there is a `.piano-tracker/lock` file with the host and the pid.
//!   If, when opening it, there is a lock from another computer (or from another live process on
//!   this one), the user is asked to confirm: opening the same database on two computers at once
//!   ends up in conflicting copies from the sync service.
//!
//! It does not import `tauri::`, so it can be tested without the app.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::models::{RecentVault, VaultInfo};
use crate::paths::{AppDirs, AppPaths, DB_FILE_NAME, VAULT_MARKER_DIR};

/// Maximum number of recent vaults remembered.
const MAX_RECENT: usize = 10;
/// Format of the `vault.json` marker.
const VAULT_FORMAT: u32 = 1;

// ---------------------------------------------------------------------------
// Machine configuration
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub current_vault: Option<String>,
    /// Most recent first.
    pub recent_vaults: Vec<String>,
    /// SoundFont chosen in Settings (machine-dependent, so it does not go in the vault).
    pub soundfont_path: Option<String>,
    /// UI language (`"en"`, `"es"`…); `None` follows the system language.
    pub language: Option<String>,
}

impl AppConfig {
    /// Reads the configuration; if it is missing or corrupt, returns the default one.
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                log::warn!("Invalid configuration in {}: {e}; using the default one", path.display());
                AppConfig::default()
            }),
            Err(_) => AppConfig::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| t!("backend.io.serializeConfig", e = e))?;
        write_atomic(path, text.as_bytes())
    }

    /// Marks `path` as the current vault and puts it first among the recent ones.
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
// Open vault
// ---------------------------------------------------------------------------

/// Open vault: paths and database. Releases the lock when dropped.
pub struct Vault {
    pub paths: AppPaths,
    pub db: Arc<Database>,
}

impl Vault {
    pub fn name(&self) -> String {
        folder_name(&self.paths.base)
    }

    /// Deletes the lock if it belongs to this process.
    pub fn release_lock(&self) {
        let lock = self.paths.lock_file();
        if read_lock(&lock).is_some_and(|l| l.host == hostname() && l.pid == std::process::id()) {
            if let Err(e) = std::fs::remove_file(&lock) {
                log::warn!("Could not delete {}: {e}", lock.display());
            }
        }
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        self.release_lock();
    }
}

/// Result of trying to open a vault.
pub enum OpenOutcome {
    Opened(Vault),
    /// It seems to be open somewhere else; the text explains where. It can be retried with `force`.
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

/// `gethostname(2)`: Linux has `/proc`, macOS doesn't.
fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for `buf.len()` bytes; the name is read up to the first NUL.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).trim().to_string())
        .filter(|s| ok && !s.is_empty())
        .unwrap_or_else(|| "this computer".to_string())
}

/// `kill(pid, 0)` sends nothing, it only checks: `EPERM` means it exists but belongs to someone else.
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    // pid 0 would address our own process group.
    // SAFETY: signal 0 performs only the existence and permission checks.
    pid > 0
        && (unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

fn read_lock(path: &Path) -> Option<LockInfo> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Canonical path if it exists (avoids duplicates in the recent list due to trailing `/` or `..`).
pub fn normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The folder is a vault: it has the marker or, like the previous version's folder, the
/// database itself.
pub fn is_vault(dir: &Path) -> bool {
    dir.join(VAULT_MARKER_DIR).is_dir() || dir.join(DB_FILE_NAME).is_file()
}

fn is_empty_dir(dir: &Path) -> Result<bool, String> {
    let mut entries = std::fs::read_dir(dir).map_err(|e| t!("backend.io.read", path = dir.display(), e = e))?;
    Ok(entries.next().is_none())
}

/// Checks that `dir` can hold a new vault: it does not exist or it is empty.
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

/// Creates the structure of a new vault in `dir` (which must not exist or must be empty).
pub fn create_vault(dir: &Path) -> Result<(), String> {
    check_new_vault_dir(dir)?;
    let paths = AppPaths::from_base(dir);
    paths.ensure_dirs()?;
    write_marker_if_missing(&paths)
}

/// Warning message if the vault has a lock from another computer or another live process.
fn foreign_lock_message(paths: &AppPaths) -> Option<String> {
    let lock = read_lock(&paths.lock_file())?;
    let me = hostname();
    if lock.host == me && (lock.pid == std::process::id() || !pid_alive(lock.pid)) {
        return None;
    }
    // The format comes from the translation: if it were malformed, `to_string` would panic.
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

/// Checks that `dir` is a vault that can be opened. Returns the foreign-lock warning (if there
/// is one and it is not forced) without changing anything.
pub fn precheck(dir: &Path, force: bool) -> Result<Option<String>, String> {
    if !dir.is_dir() {
        return Err(t!("backend.vault.missing", path = dir.display()));
    }
    if !is_vault(dir) {
        return Err(t!("backend.vault.notAVault", path = dir.display()));
    }
    Ok(if force { None } else { foreign_lock_message(&AppPaths::from_base(dir)) })
}

/// Opens the vault in `dir`: validates it, checks the lock, writes it and opens the database
/// (applying migrations). With `force` it ignores a foreign lock.
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

/// Conflicting copies of the database created by sync services
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

/// Information for the frontend.
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
// Importing the previous version's data
// ---------------------------------------------------------------------------

/// Moves a file or folder; if `rename` fails (e.g. across disks), copies and deletes.
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

/// Creates a vault in `dest` by moving into it the database, the MIDI files and the images from
/// the previous version's folder. Absolute paths are converted when it is opened (v2 migration).
pub fn import_legacy(legacy_dir: &Path, dest: &Path) -> Result<(), String> {
    let legacy_db = legacy_dir.join(DB_FILE_NAME);
    if !legacy_db.is_file() {
        return Err(t!("backend.legacy.noData", path = legacy_dir.display()));
    }
    if normalize(dest).starts_with(normalize(legacy_dir)) {
        return Err(t!("backend.legacy.destInside"));
    }
    check_new_vault_dir(dest)?;
    // Flushes the old WAL into the main file so a single consistent file is moved.
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
            OpenOutcome::Locked(msg) => panic!("locked: {msg}"),
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
        let v = dir.path().join("Café vault");
        create_vault(&v).unwrap();
        assert!(v.join(".piano-tracker/vault.json").is_file());
        assert!(v.join("midi/raw").is_dir() && v.join("midi/fragments").is_dir() && v.join("media").is_dir());
        assert!(create_vault(&v).unwrap_err().contains("already a vault"));

        let busy = dir.path().join("busy");
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::write(busy.join("x.txt"), b"x").unwrap();
        assert!(create_vault(&busy).unwrap_err().contains("is not empty"));
        assert!(create_vault(Path::new("relative")).is_err());

        let vault = opened(open_vault(&v, false).unwrap());
        assert!(v.join("piano_tracker.sqlite").is_file());
        assert!(v.join(".piano-tracker/lock").is_file());
        assert_eq!(vault.name(), "Café vault");
        // Reopening from the same process is not considered a foreign lock.
        assert!(matches!(open_vault(&v, false).unwrap(), OpenOutcome::Opened(_)));
    }

    #[test]
    fn not_a_vault_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let err = |d: &Path| open_vault(d, false).err().expect("should fail");
        assert!(err(dir.path()).contains("is not a Piano Tracker vault"));
        assert!(err(&dir.path().join("nope")).contains("does not exist"));
    }

    #[test]
    fn foreign_lock_asks_for_confirmation_and_drop_releases() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path().join("b");
        create_vault(&v).unwrap();
        let paths = AppPaths::from_base(&v);
        let other = LockInfo { host: "other-computer".into(), pid: 1, opened_at: "2026-10-15T08:00:00Z".into() };
        std::fs::write(paths.lock_file(), serde_json::to_string(&other).unwrap()).unwrap();
        match open_vault(&v, false).unwrap() {
            OpenOutcome::Locked(msg) => assert!(msg.contains("other-computer"), "{msg}"),
            OpenOutcome::Opened(_) => panic!("should ask for confirmation"),
        }
        let vault = opened(open_vault(&v, true).unwrap());
        assert_eq!(read_lock(&paths.lock_file()).unwrap().pid, std::process::id());
        drop(vault);
        assert!(!paths.lock_file().exists());

        // Orphan lock from this same computer (dead pid): ignored.
        let stale = LockInfo { host: hostname(), pid: u32::MAX - 1, opened_at: "x".into() };
        std::fs::write(paths.lock_file(), serde_json::to_string(&stale).unwrap()).unwrap();
        assert!(matches!(open_vault(&v, false).unwrap(), OpenOutcome::Opened(_)));
    }

    #[test]
    fn lock_identity_of_this_process() {
        assert_ne!(hostname(), "this computer");
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
    }

    #[test]
    fn detects_conflicted_copies_and_builds_info() {
        let dir = tempfile::tempdir().unwrap();
        let v = dir.path().join("b");
        create_vault(&v).unwrap();
        std::fs::write(v.join("piano_tracker (laptop's conflicted copy 2026-10-15).sqlite"), b"").unwrap();
        std::fs::write(v.join("piano_tracker.sync-conflict-20261015-101010-ABC.sqlite"), b"").unwrap();
        std::fs::write(v.join("piano_tracker_backup.sqlite"), b"").unwrap();
        let vault = opened(open_vault(&v, false).unwrap());
        assert_eq!(conflict_copies(&vault.paths).len(), 2);

        let dirs = AppDirs::new(dir.path().join("data"), dir.path().join("conf"));
        let mut config = AppConfig::default();
        config.set_current(&v.to_string_lossy());
        config.recent_vaults.push("/does/not/exist".into());
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
        // "Old" database (v1 schema): files with absolute paths under the data folder.
        {
            let conn = rusqlite::Connection::open(&old.db_file).unwrap();
            conn.execute_batch(crate::db::MIGRATION_V1).unwrap();
            conn.execute_batch("PRAGMA user_version = 1;").unwrap();
            let raw = old.raw_session_file("s1");
            std::fs::write(&raw, b"raw").unwrap();
            let img = old.media_dir.join("a.png");
            std::fs::write(&img, b"img").unwrap();
            conn.execute(
                "INSERT INTO sessions (id, title, session_date, bpm, raw_midi_path, raw_duration_ms, markdown_notes, \
                 updated_at) VALUES ('s1', 'Old', '2026-01-01', 90, ?1, 10, ?2, '2026-01-01T00:00:00Z')",
                rusqlite::params![raw.to_string_lossy(), format!("![a]({})", img.display())],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO session_media (id, session_id, local_path) VALUES ('m1', 's1', ?1)",
                rusqlite::params![img.to_string_lossy()],
            )
            .unwrap();
        }
        let dirs = AppDirs::new(&legacy, dir.path().join("conf"));
        assert!(dirs.legacy_db().is_some());

        let dest = dir.path().join("Dropbox").join("PianoTracker");
        assert!(import_legacy(&legacy, &legacy.join("inside")).is_err());
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
