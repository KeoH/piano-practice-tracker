//! Tauri IPC commands (the contract in section 5 of the specification).
//!
//! They are all `async` so they don't block the UI's main thread; the modules they wrap are
//! synchronous and fast, except MIDI analysis/slicing.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use base64::Engine as _;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::audio_engine::AudioEngine;
use crate::i18n;
use crate::midi_recorder::{self, MidiRecorder, MidiSink};
use crate::midi_slicer;
use crate::models::*;
use crate::paths::AppDirs;
use crate::soundfont;
use crate::vault::{self, AppConfig, OpenOutcome, Vault};

/// Maximum number of activity blocks returned to the frontend.
const ACTIVITY_BLOCKS: usize = 200;

pub struct AppState {
    /// App directories outside the vault (configuration and built-in SoundFont).
    pub dirs: AppDirs,
    pub config: Mutex<AppConfig>,
    /// Open vault. `None` until the user creates or opens one.
    pub vault: RwLock<Option<Arc<Vault>>>,
    pub recorder: MidiRecorder,
    pub audio: Arc<AudioEngine>,
    /// Session being recorded right now (if any).
    pub recording_session: Mutex<Option<String>>,
    pub soundfont: Arc<Mutex<SoundfontState>>,
}

/// Active SoundFont and whether a background load is in progress.
pub struct SoundfontState {
    pub current: PathBuf,
    pub loading: bool,
}

/// Loads `path` into the engine on a separate thread; when done it updates the shared state.
/// If it fails, the previous SoundFont is kept.
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
    /// Open vault, or an error if there is none.
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

    /// Saves the machine configuration; a failure is only logged.
    fn save_config(&self, config: &AppConfig) {
        if let Err(e) = config.save(&self.dirs.config_file) {
            log::error!("{e}");
        }
    }

    /// Releases the open vault (lock included). Fails if a recording is in progress.
    pub fn close_vault(&self) -> Result<(), String> {
        if self.recorder.is_recording() {
            return Err(t!("backend.stopRecordingToSwitchVault"));
        }
        let _ = self.audio.stop();
        let old = self.vault.write().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(old) = old {
            // Even if a command still uses it, the lock is released right away.
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
            log::warn!("Could not delete {}: {e}", path.display());
        }
    }
}

// ---------------------------------------------------------------------------
// MIDI devices and recording
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
    // An existing raw take is resumed, accumulating its duration.
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
// Slicing and playback
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
    // The player could be reading the raw take we are about to rewrite.
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
// Sessions, fragments and comments
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

/// Safe file name: only `[A-Za-z0-9._-]`, no paths, with an image extension.
fn sanitize_image_name(file_name: &str, bytes: &[u8]) -> String {
    let base = Path::new(file_name).file_name().and_then(|n| n.to_str()).unwrap_or("image");
    let mut clean: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    clean = clean.trim_matches('.').to_string();
    if clean.is_empty() {
        clean = "image".into();
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
    // Tolerates a `data:image/png;base64,` prefix in case the frontend sends it.
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
    // The Markdown stores the path relative to the vault, so it still works on another computer.
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
// SoundFont (synthesizer sound)
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

/// Loads the given SoundFont (can take a few seconds with large files) and remembers it.
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
// Vault
// ---------------------------------------------------------------------------

/// Opens the vault in `dir` and makes it current: closes the previous one, remembers it in the
/// configuration, adopts the SoundFont the previous version stored in the database and lets
/// the asset protocol serve its images.
pub fn activate_vault<R: Runtime>(app: &AppHandle<R>, state: &AppState, dir: &Path, force: bool) -> Result<VaultOpenResult, String> {
    let dir = vault::normalize(dir);
    if state.current_vault().is_some_and(|v| v.paths.base == dir) {
        return Ok(VaultOpenResult { info: state.vault_info(), opened: true, lock_warning: None });
    }
    if state.recorder.is_recording() {
        return Err(t!("backend.stopRecordingToSwitchVault"));
    }
    // Checked before closing the current one: if the new one is invalid or locked, it stays open.
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
        log::warn!("Could not allow access to the vault's images: {e}");
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

/// Creates an empty vault in `path` (a new or empty folder) and opens it.
#[tauri::command]
pub async fn create_vault<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, path: String) -> Result<VaultInfo, String> {
    let dir = PathBuf::from(path.trim());
    vault::create_vault(&dir)?;
    activate_vault(&app, &state, &dir, false).map(|r| r.info)
}

/// Opens an existing vault. If it seems to be open on another computer it returns
/// `opened = false` and the warning; the frontend can retry with `force = true`.
#[tauri::command]
pub async fn open_vault<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: String,
    force: bool,
) -> Result<VaultOpenResult, String> {
    activate_vault(&app, &state, Path::new(path.trim()), force)
}

/// Creates a vault in `path` with the previous version's data (moved into it) and opens it.
#[tauri::command]
pub async fn import_legacy_data<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, path: String) -> Result<VaultInfo, String> {
    if state.recorder.is_recording() {
        return Err(t!("backend.stopRecordingToImport"));
    }
    let dest = PathBuf::from(path.trim());
    let legacy = state.dirs.data_dir.clone();
    // The old database cannot be open while it is being moved.
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

/// Closes the current vault (to choose another one). The app goes back to the welcome screen.
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

/// Forgets a vault from the recent list (deletes nothing on disk).
#[tauri::command]
pub async fn forget_recent_vault(state: State<'_, AppState>, path: String) -> Result<VaultInfo, String> {
    {
        let mut config = state.config.lock().unwrap_or_else(|p| p.into_inner());
        config.recent_vaults.retain(|p| p != &path);
        state.save_config(&config);
    }
    Ok(state.vault_info())
}

/// Opens the vault folder in the file manager.
#[tauri::command]
pub async fn reveal_vault(state: State<'_, AppState>) -> Result<(), String> {
    let vault = state.vault()?;
    xdg_open(vault.paths.base.as_os_str()).map_err(|e| t!("backend.revealFailed", e = e))
}

/// Opens a path or URL with the desktop's default application.
fn xdg_open(arg: &OsStr) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(arg).spawn().map(|mut child| {
        // Reaps the process when it exits so no zombies are left.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    })
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

/// Read from `Cargo.toml` at compile time; release-please keeps its version up to date.
fn app_info() -> AppInfo {
    AppInfo {
        name: "Piano Practice Tracker".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        authors: env!("CARGO_PKG_AUTHORS")
            .split(':')
            .map(|a| a.split('<').next().unwrap_or(a).trim().to_string())
            .filter(|a| !a.is_empty())
            .collect(),
        license: env!("CARGO_PKG_LICENSE").into(),
        homepage: env!("CARGO_PKG_HOMEPAGE").into(),
        repository: env!("CARGO_PKG_REPOSITORY").into(),
        tauri_version: tauri::VERSION.into(),
    }
}

fn app_link_url(link: AppLink) -> String {
    let info = app_info();
    match link {
        AppLink::Homepage => info.homepage,
        AppLink::Repository => info.repository,
        AppLink::License => format!("{}/blob/main/LICENSE", info.repository),
    }
}

#[tauri::command]
pub async fn get_app_info() -> Result<AppInfo, String> {
    Ok(app_info())
}

/// Opens one of the app's links in the browser.
#[tauri::command]
pub async fn open_app_link(target: AppLink) -> Result<(), String> {
    xdg_open(OsStr::new(&app_link_url(target))).map_err(|e| t!("backend.openLinkFailed", e = e))
}

// ---------------------------------------------------------------------------
// Language
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

/// Changes the language of the backend messages and remembers it; `None` goes back to the system language.
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
    use super::*;
    use crate::midi_slicer::TimedMidiEvent;
    use crate::sf2_builder;
    use tauri::async_runtime::block_on;
    use tauri::test::{mock_app, MockRuntime};

    /// App state on temporary folders, with a headless audio engine and a vault already open.
    struct Fixture {
        app: tauri::App<MockRuntime>,
        tmp: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let dirs = AppDirs::new(tmp.path().join("data"), tmp.path().join("config"));
            dirs.ensure_dirs().unwrap();
            let sf2 = sf2_builder::ensure_soundfont(&dirs.sf2_file).unwrap();
            let audio = Arc::new(AudioEngine::new_headless(&sf2, Arc::new(|_| {})));
            let app = mock_app();
            app.manage(AppState {
                dirs,
                config: Mutex::new(AppConfig::default()),
                vault: RwLock::new(None),
                recorder: MidiRecorder::new(),
                audio,
                recording_session: Mutex::new(None),
                soundfont: Arc::new(Mutex::new(SoundfontState { current: sf2, loading: false })),
            });
            let fx = Fixture { app, tmp };
            block_on(create_vault(fx.handle(), fx.state(), fx.path("vault"))).unwrap();
            fx
        }

        fn state(&self) -> State<'_, AppState> {
            self.app.state::<AppState>()
        }

        fn handle(&self) -> AppHandle<MockRuntime> {
            self.app.handle().clone()
        }

        fn path(&self, name: &str) -> String {
            self.tmp.path().join(name).to_string_lossy().into_owned()
        }

        fn vault(&self) -> Arc<Vault> {
            self.state().vault().unwrap()
        }

        /// A session whose raw take has notes in [0, 10) s and [15, 25) s.
        fn session_with_take(&self) -> SessionDto {
            let detail = block_on(create_session(self.state(), "  Monday ".into(), 500)).unwrap();
            let id = detail.session.id;
            let vault = self.vault();
            let raw = vault.paths.raw_session_file(&id);
            let mut events = Vec::new();
            for ms in (0..10_000).chain(15_000..25_000).step_by(500) {
                let key = 60 + (ms / 500 % 12) as u8;
                events.push(TimedMidiEvent::new(ms * 1000, vec![0x90, key, 80]));
                events.push(TimedMidiEvent::new((ms + 500) * 1000, vec![0x80, key, 0]));
            }
            midi_slicer::write_smf(&raw, &events, 120).unwrap();
            vault.db.set_session_raw_midi(&id, &raw.to_string_lossy(), 25_000).unwrap()
        }

        fn add_fragment(&self, session_id: &str) -> FragmentDto {
            let req = ExtractFragmentReq {
                session_id: session_id.into(),
                start_ms: 0,
                end_ms: 5_000,
                title: "  ".into(),
                explanation: " First bars ".into(),
                piece_id: None,
                passage: String::new(),
            };
            block_on(extract_midi_fragment(self.state(), req)).unwrap().fragment
        }
    }

    fn composition_with(doc: CompositionDto, fragment: &FragmentDto) -> CompositionDto {
        let mut doc = doc;
        doc.tracks[0].clips.push(CompositionClipDto {
            id: String::new(),
            fragment_id: fragment.id.clone(),
            start_ms: 0,
            trim_start_ms: 0,
            length_ms: fragment.duration_ms,
            repeats: 2,
            transpose: 0,
            fragment_title: String::new(),
            fragment_file_path: String::new(),
            fragment_duration_ms: 0,
        });
        doc
    }

    #[test]
    fn app_info_comes_from_cargo_toml() {
        let info = app_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(!info.version.is_empty());
        assert_eq!(info.license, "MIT");
        assert_eq!(info.authors, ["Francisco Manzano"]);
        for link in [AppLink::Homepage, AppLink::Repository, AppLink::License] {
            assert!(app_link_url(link).starts_with("https://"), "{link:?}");
        }
        assert!(app_link_url(AppLink::License).ends_with("/blob/main/LICENSE"));
        assert_eq!(block_on(get_app_info()).unwrap(), info);
    }

    #[test]
    fn sanitizes_image_names() {
        let png = [0x89, b'P', b'N', b'G', 0, 0];
        assert_eq!(sanitize_image_name("../../etc/passwd", &png), "passwd.png");
        assert_eq!(sanitize_image_name("my photo.JPG", &[]), "my_photo.JPG");
        assert_eq!(sanitize_image_name("", &[0xFF, 0xD8, 0]), "image.jpg");
        assert_eq!(sanitize_image_name("...", &png), "image.png");
        assert_eq!(sanitize_image_name("anim", b"GIF89a"), "anim.gif");
        assert_eq!(sanitize_image_name("pic", b"RIFF\0\0\0\0WEBPVP8 "), "pic.webp");
        assert_eq!(sanitize_image_name("data.bin", b"??"), "data.bin.png");
    }

    #[test]
    fn adds_the_export_extension_and_checks_dates() {
        assert_eq!(with_extension("/out/take".into(), "wav"), PathBuf::from("/out/take.wav"));
        assert_eq!(with_extension("/out/take.WAV".into(), "wav"), PathBuf::from("/out/take.WAV"));
        assert_eq!(with_extension("/out/take.mid".into(), "wav"), PathBuf::from("/out/take.mid.wav"));
        assert_eq!(parse_iso_date("2026-10-22"), Ok("2026-10-22"));
        assert!(parse_iso_date("22/10/2026").is_err());
    }

    #[test]
    fn data_commands_need_an_open_vault() {
        let fx = Fixture::new();
        let info = block_on(close_vault(fx.state())).unwrap();
        assert_eq!(info.current, None);
        assert_eq!(block_on(get_sessions(fx.state())).unwrap_err(), t!("backend.noVault"));
        assert!(block_on(get_pieces(fx.state())).is_err());
        assert!(block_on(get_compositions(fx.state())).is_err());
        assert!(block_on(reveal_vault(fx.state())).is_err());
    }

    #[test]
    fn creates_opens_and_forgets_vaults() {
        let fx = Fixture::new();
        let first = fx.path("vault");
        let info = block_on(get_vault_info(fx.state())).unwrap();
        assert_eq!(info.current.as_deref(), Some(first.as_str()));
        assert!(fx.state().config.lock().unwrap().recent_vaults.contains(&first));
        assert!(fx.tmp.path().join("config/config.json").is_file());

        // Opening the vault that is already open changes nothing.
        let again = block_on(open_vault(fx.handle(), fx.state(), first.clone(), false)).unwrap();
        assert!(again.opened);

        // A second vault replaces the first one, which stays in the recent list.
        let second = fx.path("second");
        let info = block_on(create_vault(fx.handle(), fx.state(), second.clone())).unwrap();
        assert_eq!(info.current.as_deref(), Some(second.as_str()));
        assert!(block_on(create_vault(fx.handle(), fx.state(), second.clone())).is_err(), "not an empty folder");

        let back = block_on(open_vault(fx.handle(), fx.state(), format!(" {first} "), false)).unwrap();
        assert!(back.opened);
        assert_eq!(back.info.current.as_deref(), Some(first.as_str()));
        assert!(block_on(open_vault(fx.handle(), fx.state(), fx.path("missing"), false)).is_err());

        let info = block_on(forget_recent_vault(fx.state(), second.clone())).unwrap();
        assert!(info.recent.iter().all(|r| r.path != second));
    }

    #[test]
    fn imports_the_previous_version_data() {
        let fx = Fixture::new();
        // The old layout: a database (made here by a vault) in the app data folder.
        let legacy = fx.state().dirs.data_dir.clone();
        let old = vault::open_vault(&{
            let dir = fx.tmp.path().join("old");
            vault::create_vault(&dir).unwrap();
            dir
        }, true)
        .unwrap();
        let OpenOutcome::Opened(old) = old else { panic!("locked") };
        old.db.create_session("Old session", 90).unwrap();
        old.release_lock();
        drop(old);
        std::fs::copy(fx.tmp.path().join("old").join(crate::paths::DB_FILE_NAME), legacy.join(crate::paths::DB_FILE_NAME)).unwrap();

        let info = block_on(import_legacy_data(fx.handle(), fx.state(), fx.path("imported"))).unwrap();
        assert_eq!(info.current.as_deref(), Some(fx.path("imported").as_str()));
        let sessions = block_on(get_sessions(fx.state())).unwrap();
        assert_eq!(sessions.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), ["Old session"]);
    }

    #[test]
    fn session_lifecycle() {
        let fx = Fixture::new();
        let detail = block_on(create_session(fx.state(), "   ".into(), 10)).unwrap();
        assert_eq!(detail.session.title, t!("backend.defaults.sessionTitle"));
        assert_eq!(detail.session.bpm, 40);
        let id = detail.session.id.clone();

        block_on(update_session(fx.state(), id.clone(), " Scales ".into(), 300, "# Notes".into())).unwrap();
        let detail = block_on(get_session_detail(fx.state(), id.clone())).unwrap();
        assert_eq!((detail.session.title.as_str(), detail.session.bpm), ("Scales", 240));
        assert_eq!(detail.session.markdown_notes, "# Notes");
        assert_eq!(block_on(get_sessions(fx.state())).unwrap().len(), 1);

        // Images are stored in media/ and referenced relative to the vault.
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G', 1, 2, 3]);
        let rel = block_on(save_session_image(fx.state(), id.clone(), "chart.png".into(), format!("data:image/png;base64,{png}"))).unwrap();
        assert!(rel.starts_with("media/") && rel.ends_with("_chart.png"), "{rel}");
        assert!(fx.vault().paths.resolve(&rel).unwrap().is_file());
        assert!(block_on(save_session_image(fx.state(), id.clone(), "x.png".into(), "!!".into())).is_err());
        assert!(block_on(save_session_image(fx.state(), id.clone(), "x.png".into(), String::new())).is_err());
        assert!(block_on(save_session_image(fx.state(), "nope".into(), "x.png".into(), png)).is_err());

        block_on(delete_session(fx.state(), id.clone())).unwrap();
        assert!(block_on(get_sessions(fx.state())).unwrap().is_empty());
        assert!(!fx.vault().paths.resolve(&rel).unwrap().exists());
    }

    #[test]
    fn slices_the_raw_take_and_undoes_it() {
        let fx = Fixture::new();
        let session = fx.session_with_take();
        let raw = session.raw_midi_path.clone().unwrap();

        let activity = block_on(get_midi_activity(raw.clone())).unwrap();
        assert!(!activity.blocks.is_empty());
        let notes = block_on(get_midi_notes(raw.clone())).unwrap();
        assert!(!notes.notes.is_empty());
        let segments = block_on(suggest_midi_segments(raw.clone(), None)).unwrap();
        assert_eq!(segments.len(), 2, "{segments:?}");

        // Extract the first 5 s as a fragment.
        let fragment = fx.add_fragment(&session.id);
        assert_eq!(fragment.title, t!("backend.defaults.fragmentTitle"));
        assert_eq!(fragment.explanation, "First bars");
        assert!(Path::new(&fragment.file_path).is_file());
        let detail = block_on(get_session_detail(fx.state(), session.id.clone())).unwrap();
        assert_eq!(detail.session.raw_duration_ms, 20_000);
        assert_eq!(detail.undo_depth, 1);

        // Discard one range, then several at once.
        let bad = block_on(discard_midi_range(fx.state(), session.id.clone(), 2_000, 1_000));
        assert_eq!(bad.unwrap_err(), t!("backend.rangeEndBeforeStart"));
        let s = block_on(discard_midi_range(fx.state(), session.id.clone(), 0, 1_000)).unwrap();
        assert_eq!(s.raw_duration_ms, 19_000);
        assert!(block_on(discard_midi_ranges(fx.state(), session.id.clone(), vec![])).is_err());
        let ranges = vec![TimeRangeDto { start_ms: 0, end_ms: 500 }, TimeRangeDto { start_ms: 1_000, end_ms: 1_500 }];
        let s = block_on(discard_midi_ranges(fx.state(), session.id.clone(), ranges)).unwrap();
        assert_eq!(s.raw_duration_ms, 18_000);

        // Undo walks back: two discards, then the extract (which deletes its fragment).
        assert_eq!(block_on(undo_raw_trim(fx.state(), session.id.clone())).unwrap().session.raw_duration_ms, 19_000);
        assert_eq!(block_on(undo_raw_trim(fx.state(), session.id.clone())).unwrap().session.raw_duration_ms, 20_000);
        let undone = block_on(undo_raw_trim(fx.state(), session.id.clone())).unwrap();
        assert_eq!(undone.session.raw_duration_ms, 25_000);
        assert_eq!(undone.removed_fragment_id.as_deref(), Some(fragment.id.as_str()));
        assert!(block_on(undo_raw_trim(fx.state(), session.id.clone())).is_err());

        let bad = ExtractFragmentReq { session_id: session.id.clone(), start_ms: 5, end_ms: 5, title: String::new(), explanation: String::new(), piece_id: None, passage: String::new() };
        assert!(block_on(extract_midi_fragment(fx.state(), bad)).is_err());
    }

    #[test]
    fn refuses_to_slice_a_session_that_is_recording() {
        let fx = Fixture::new();
        let session = fx.session_with_take();
        fx.state().set_recording_session(Some(session.id.clone()));
        let busy = t!("backend.sessionIsRecording");
        assert_eq!(block_on(discard_midi_range(fx.state(), session.id.clone(), 0, 1_000)).unwrap_err(), busy);
        assert_eq!(block_on(undo_raw_trim(fx.state(), session.id.clone())).unwrap_err(), busy);
        assert_eq!(block_on(delete_session(fx.state(), session.id.clone())).unwrap_err(), busy);
        fx.state().set_recording_session(None);

        let empty = block_on(create_session(fx.state(), "Empty".into(), 90)).unwrap();
        assert_eq!(block_on(discard_midi_range(fx.state(), empty.session.id, 0, 1_000)).unwrap_err(), t!("backend.noRawTrack"));
    }

    #[test]
    fn fragments_and_comments() {
        let fx = Fixture::new();
        let session = fx.session_with_take();
        let fragment = fx.add_fragment(&session.id);

        block_on(update_fragment_meta(fx.state(), fragment.id.clone(), " Intro ".into(), "slow".into())).unwrap();
        assert!(block_on(add_timeline_comment(fx.state(), fragment.id.clone(), 100, "  ".into())).is_err());
        let comment = block_on(add_timeline_comment(fx.state(), fragment.id.clone(), 1_500, " Rushed ".into())).unwrap();
        assert_eq!((comment.content.as_str(), comment.timestamp_ms), ("Rushed", 1_500));
        let detail = block_on(get_session_detail(fx.state(), session.id.clone())).unwrap();
        assert_eq!(detail.fragments[0].title, "Intro");
        assert_eq!(detail.fragments[0].comments.len(), 1);

        block_on(delete_timeline_comment(fx.state(), comment.id)).unwrap();
        block_on(delete_fragment(fx.state(), fragment.id.clone())).unwrap();
        assert!(!Path::new(&fragment.file_path).exists());
        assert!(block_on(get_session_detail(fx.state(), session.id)).unwrap().fragments.is_empty());
    }

    #[test]
    fn repertoire() {
        let fx = Fixture::new();
        let session = fx.session_with_take();
        let fragment = fx.add_fragment(&session.id);

        let untitled = block_on(create_piece(fx.state(), " ".into(), " Anon ".into())).unwrap();
        assert_eq!(untitled.title, t!("backend.defaults.pieceTitle"));
        assert_eq!(untitled.composer, "Anon");
        let piece = block_on(create_piece(fx.state(), "Nocturne".into(), "Chopin".into())).unwrap();
        let updated = block_on(update_piece(fx.state(), piece.id.clone(), " Nocturne op. 9 ".into(), "Chopin".into(), "left hand".into(), false)).unwrap();
        assert_eq!(updated.title, "Nocturne op. 9");

        let filed = block_on(assign_fragment_piece(fx.state(), fragment.id.clone(), Some(piece.id.clone()), "Bars 1-4".into())).unwrap();
        assert_eq!((filed.piece_id.as_deref(), filed.passage.as_str()), (Some(piece.id.as_str()), "Bars 1-4"));
        let detail = block_on(get_piece_detail(fx.state(), piece.id.clone())).unwrap();
        assert_eq!(detail.takes.len(), 1);
        let pieces = block_on(get_pieces(fx.state())).unwrap();
        assert_eq!(pieces.iter().find(|p| p.piece.id == piece.id).unwrap().passages, ["Bars 1-4"]);

        // Without a piece the passage is dropped.
        let loose = block_on(assign_fragment_piece(fx.state(), fragment.id.clone(), Some(String::new()), "ignored".into())).unwrap();
        assert_eq!((loose.piece_id, loose.passage.as_str()), (None, ""));

        block_on(delete_piece(fx.state(), untitled.id)).unwrap();
        assert_eq!(block_on(get_pieces(fx.state())).unwrap().len(), 1);
    }

    #[test]
    fn compositions_play_and_export() {
        let fx = Fixture::new();
        let session = fx.session_with_take();
        let fragment = fx.add_fragment(&session.id);

        let empty = block_on(create_composition(fx.state(), "  ".into())).unwrap();
        assert_eq!(empty.title, t!("backend.defaults.compositionTitle"));
        assert_eq!(empty.tracks.len(), 1);
        let export_err = block_on(export_composition_midi(fx.state(), empty.id.clone(), fx.path("x.mid")));
        assert_eq!(export_err.unwrap_err(), t!("backend.export.emptyComposition"));

        let mut doc = composition_with(empty, &fragment);
        doc.title = String::new();
        let saved = block_on(save_composition(fx.state(), doc)).unwrap();
        assert_eq!(saved.title, t!("backend.defaults.compositionTitle"));
        assert_eq!(saved.tracks[0].clips[0].fragment_file_path, fragment.file_path);
        assert_eq!(block_on(get_composition(fx.state(), saved.id.clone())).unwrap().tracks[0].clips.len(), 1);
        assert_eq!(block_on(get_compositions(fx.state())).unwrap()[0].clip_count, 1);
        assert_eq!(block_on(get_library_fragments(fx.state())).unwrap().len(), 1);
        assert_eq!(block_on(count_composition_uses(fx.state(), vec![fragment.id.clone()], None)).unwrap(), 1);
        assert_eq!(block_on(count_composition_uses(fx.state(), vec![], Some(session.id.clone()))).unwrap(), 1);

        // Playing it, then saving a new version, keeps it loaded under its key.
        block_on(play_composition(fx.state(), saved.id.clone(), 0)).unwrap();
        let key = composition::playback_key(&saved.id);
        assert_eq!(fx.state().audio.active_key(), Some(key.clone()));
        let mix = vec![TrackMixDto { volume: 80, muted: false, solo: true }];
        block_on(set_composition_mix(fx.state(), saved.id.clone(), mix.clone())).unwrap();
        block_on(set_composition_mix(fx.state(), "other".into(), mix)).unwrap();
        let mut next = saved.clone();
        next.tracks[0].clips[0].transpose = 2;
        assert_eq!(block_on(save_composition(fx.state(), next)).unwrap().tracks[0].clips[0].transpose, 2);
        assert_eq!(fx.state().audio.active_key(), Some(key));

        let mid = block_on(export_composition_midi(fx.state(), saved.id.clone(), fx.path("song"))).unwrap();
        assert!(mid.ends_with("song.mid") && Path::new(&mid).is_file());
        let wav = block_on(export_composition_audio(fx.state(), saved.id.clone(), fx.path("song.wav"))).unwrap();
        assert!(std::fs::metadata(&wav).unwrap().len() > 44);

        block_on(delete_composition(fx.state(), saved.id.clone())).unwrap();
        assert!(block_on(get_compositions(fx.state())).unwrap().iter().all(|c| c.id != saved.id));
    }

    #[test]
    fn playback_commands() {
        let fx = Fixture::new();
        let session = fx.session_with_take();
        let raw = session.raw_midi_path.unwrap();

        block_on(play_midi_file(fx.state(), raw.clone(), 1_000)).unwrap();
        assert_eq!(fx.state().audio.active_key().as_deref(), Some(raw.as_str()));
        block_on(set_playback_loop(fx.state(), Some(2_000), Some(4_000))).unwrap();
        block_on(set_playback_loop(fx.state(), None, None)).unwrap();
        assert_eq!(block_on(set_playback_rate(fx.state(), 0.1)).unwrap(), fx.state().audio.playback_rate());
        block_on(seek_midi_playback(fx.state(), 3_000)).unwrap();
        block_on(pause_midi_playback(fx.state())).unwrap();
        block_on(stop_midi_playback(fx.state())).unwrap();
        assert!(block_on(play_midi_file(fx.state(), fx.path("missing.mid"), 0)).is_err());

        let wav = block_on(export_audio(fx.state(), raw, fx.path("take"))).unwrap();
        assert!(wav.ends_with("take.wav") && Path::new(&wav).is_file());

        block_on(preview_instrument(fx.state(), 200)).unwrap();
        assert_eq!(fx.state().audio.active_key(), Some(composition::preview_key(127)));
        assert_eq!(block_on(get_soundfont_programs(fx.state())).unwrap(), [0]);
    }

    #[test]
    fn practice_stats_and_goal() {
        let fx = Fixture::new();
        let session = fx.session_with_take();
        fx.vault().db.add_practice_entry(&session.id, 90_000).unwrap();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let stats = block_on(get_practice_stats(fx.state(), "2000-01-01".into(), today.clone())).unwrap();
        assert_eq!(stats.weekly_goal_minutes, 0);
        assert_eq!(stats.days.iter().map(|d| d.duration_ms).sum::<u64>(), 90_000);
        assert!(block_on(get_practice_stats(fx.state(), "yesterday".into(), today.clone())).is_err());

        assert_eq!(block_on(set_weekly_goal(fx.state(), 99_999)).unwrap(), MAX_WEEKLY_GOAL_MINUTES);
        assert_eq!(block_on(set_weekly_goal(fx.state(), 150)).unwrap(), 150);
        assert_eq!(block_on(get_practice_stats(fx.state(), today.clone(), today)).unwrap().weekly_goal_minutes, 150);
    }

    #[test]
    fn records_with_the_simulator() {
        let fx = Fixture::new();
        let session = block_on(create_session(fx.state(), "Live".into(), 120)).unwrap().session;
        assert!(!block_on(list_midi_ports()).unwrap().is_empty());
        assert_eq!(block_on(stop_recording(fx.state(), session.id.clone())).unwrap_err(), t!("backend.recorder.notRunning"));

        block_on(start_recording(fx.state(), session.id.clone(), midi_recorder::SIMULATOR_PORT_ID.into(), 400, true, false)).unwrap();
        let again = block_on(start_recording(fx.state(), session.id.clone(), midi_recorder::SIMULATOR_PORT_ID.into(), 120, false, false));
        assert_eq!(again.unwrap_err(), t!("backend.recorder.alreadyRunning"));
        block_on(update_live_recording_settings(fx.state(), 90, false, false)).unwrap();
        assert_eq!(block_on(stop_recording(fx.state(), "other".into())).unwrap_err(), t!("backend.recorder.otherSession"));
        assert!(fx.state().close_vault().is_err(), "a recording keeps the vault open");

        std::thread::sleep(std::time::Duration::from_millis(600));
        let recorded = block_on(stop_recording(fx.state(), session.id.clone())).unwrap();
        assert!(recorded.raw_duration_ms >= 500, "{}", recorded.raw_duration_ms);
        assert!(Path::new(recorded.raw_midi_path.as_deref().unwrap()).is_file());
        assert!(fx.state().recording_session().is_none());
    }

    #[test]
    fn soundfont_and_language_info() {
        let fx = Fixture::new();
        let info = block_on(get_soundfont_info(fx.state())).unwrap();
        assert!(info.candidates.iter().any(|c| c.is_builtin));
        assert!(!info.loading);

        assert_eq!(block_on(set_soundfont(fx.state(), fx.path("piano.sf3"))).unwrap_err(), t!("backend.soundfont.invalidFile"));
        let copy = fx.tmp.path().join("copy.sf2");
        std::fs::copy(&info.current_path, &copy).unwrap();
        let info = block_on(set_soundfont(fx.state(), copy.to_string_lossy().into_owned())).unwrap();
        assert_eq!(info.current_path, copy.to_string_lossy());
        assert_eq!(fx.state().config.lock().unwrap().soundfont_path.as_deref(), Some(info.current_path.as_str()));

        fx.state().soundfont.lock().unwrap().loading = true;
        assert_eq!(block_on(set_soundfont(fx.state(), info.current_path)).unwrap_err(), t!("backend.soundfont.busy"));

        let language = block_on(get_language(fx.state())).unwrap();
        assert_eq!(language.preference, None);
        assert!(!language.effective.is_empty() && !language.system.is_empty());
    }
}
