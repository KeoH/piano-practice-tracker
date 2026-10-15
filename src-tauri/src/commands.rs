//! Comandos IPC de Tauri (contrato de la sección 5 de la especificación).
//!
//! Todos son `async` para no bloquear el hilo principal de la UI; los módulos que
//! envuelven son síncronos y rápidos salvo el análisis/recorte MIDI y Drive.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use tauri::State;

use crate::audio_engine::AudioEngine;
use crate::db::Database;
use crate::drive_sync::DriveSync;
use crate::midi_recorder::{self, MidiRecorder, MidiSink};
use crate::midi_slicer;
use crate::models::*;
use crate::paths::AppPaths;
use crate::soundfont;

/// Máximo de bloques de actividad devueltos al frontend.
const ACTIVITY_BLOCKS: usize = 200;

pub struct AppState {
    pub paths: AppPaths,
    pub db: Arc<Database>,
    pub recorder: MidiRecorder,
    pub audio: Arc<AudioEngine>,
    pub sync: Arc<DriveSync>,
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
            return Err("La sesión se está grabando; detén la grabación primero".into());
        }
        Ok(())
    }

    fn raw_path_of(&self, session: &SessionDto) -> Result<PathBuf, String> {
        session
            .raw_midi_path
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .ok_or_else(|| "La sesión no tiene una pista bruta grabada".to_string())
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
    if state.recorder.is_recording() {
        return Err("Ya hay una grabación en curso".into());
    }
    let session = state.db.get_session(&session_id)?;
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
    if !state.recorder.is_recording() {
        return Err("No hay ninguna grabación en curso".into());
    }
    if let Some(active) = state.recording_session() {
        if active != session_id {
            return Err("La grabación en curso pertenece a otra sesión".into());
        }
    }
    let output = state.paths.raw_session_file(&session_id);
    let result = state.recorder.stop(&output);
    state.set_recording_session(None);
    state.audio.set_metronome(false, 120);
    state.audio.set_live_synth(false);

    let duration_ms = result?;
    let session = state.db.set_session_raw_midi(&session_id, &output.to_string_lossy(), duration_ms)?;
    state.sync.notify_change();
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
    .map_err(|e| format!("Error interno analizando MIDI: {e}"))?
}

#[tauri::command]
pub async fn extract_midi_fragment(
    state: State<'_, AppState>,
    req: ExtractFragmentReq,
) -> Result<FragmentCreatedResponse, String> {
    state.ensure_not_recording(&req.session_id)?;
    if req.end_ms <= req.start_ms {
        return Err("El final del rango debe ser posterior al inicio".into());
    }
    let session = state.db.get_session(&req.session_id)?;
    let raw = state.raw_path_of(&session)?;
    // El reproductor podría estar leyendo la pista bruta que vamos a reescribir.
    state.audio.stop()?;

    let fragment_id = uuid::Uuid::new_v4().to_string();
    let dest = state.paths.fragment_file(&fragment_id);
    let slice = {
        let (raw, dest) = (raw.clone(), dest.clone());
        let (start, end, bpm) = (req.start_ms, req.end_ms, session.bpm);
        tauri::async_runtime::spawn_blocking(move || midi_slicer::extract_fragment_and_trim(&raw, start, end, &dest, bpm))
            .await
            .map_err(|e| format!("Error interno recortando MIDI: {e}"))??
    };

    let title = if req.title.trim().is_empty() { "Fragmento sin título" } else { req.title.trim() };
    let fragment = match state.db.insert_fragment(
        &fragment_id,
        &req.session_id,
        title,
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
    let session = state
        .db
        .set_session_raw_midi(&req.session_id, &raw.to_string_lossy(), slice.remaining_duration_ms)?;
    state.sync.notify_change();
    Ok(FragmentCreatedResponse { fragment, session })
}

#[tauri::command]
pub async fn discard_midi_range(
    state: State<'_, AppState>,
    session_id: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<SessionDto, String> {
    state.ensure_not_recording(&session_id)?;
    if end_ms <= start_ms {
        return Err("El final del rango debe ser posterior al inicio".into());
    }
    let session = state.db.get_session(&session_id)?;
    let raw = state.raw_path_of(&session)?;
    state.audio.stop()?;

    let new_duration = {
        let (raw, bpm) = (raw.clone(), session.bpm);
        tauri::async_runtime::spawn_blocking(move || midi_slicer::discard_range(&raw, start_ms, end_ms, bpm))
            .await
            .map_err(|e| format!("Error interno recortando MIDI: {e}"))??
    };
    let session = state.db.set_session_raw_midi(&session_id, &raw.to_string_lossy(), new_duration)?;
    state.sync.notify_change();
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
    state.db.list_sessions()
}

#[tauri::command]
pub async fn get_session_detail(state: State<'_, AppState>, session_id: String) -> Result<SessionDetailDto, String> {
    state.db.get_session_detail(&session_id)
}

#[tauri::command]
pub async fn create_session(state: State<'_, AppState>, title: String, bpm: u32) -> Result<SessionDetailDto, String> {
    let title = if title.trim().is_empty() { "Sesión de práctica" } else { title.trim() };
    let session = state.db.create_session(title, bpm.clamp(40, 240))?;
    state.sync.notify_change();
    state.db.get_session_detail(&session.id)
}

#[tauri::command]
pub async fn update_session(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    bpm: u32,
    markdown_notes: String,
) -> Result<(), String> {
    state.db.update_session(&session_id, title.trim(), bpm.clamp(40, 240), &markdown_notes)?;
    state.sync.notify_change();
    Ok(())
}

#[tauri::command]
pub async fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.ensure_not_recording(&session_id)?;
    state.audio.stop()?;
    for path in state.db.delete_session(&session_id)? {
        remove_file_quietly(Path::new(&path));
    }
    state.sync.notify_change();
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
    // Tolera un prefijo `data:image/png;base64,` por si el frontend lo envía.
    let payload = base64_data.split_once(',').map(|(_, b)| b).unwrap_or(&base64_data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("Imagen en base64 inválida: {e}"))?;
    if bytes.is_empty() {
        return Err("La imagen está vacía".into());
    }
    state.db.get_session(&session_id)?;

    let short_id = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("{}_{}", &short_id[..8], sanitize_image_name(&file_name, &bytes));
    let dest = state.paths.media_dir.join(name);
    std::fs::write(&dest, &bytes).map_err(|e| format!("No se pudo guardar la imagen: {e}"))?;
    let dest_str = dest.to_string_lossy().to_string();
    if let Err(e) = state.db.insert_media(&session_id, &dest_str) {
        remove_file_quietly(&dest);
        return Err(e);
    }
    state.sync.notify_change();
    Ok(dest_str)
}

#[tauri::command]
pub async fn update_fragment_meta(
    state: State<'_, AppState>,
    fragment_id: String,
    title: String,
    explanation: String,
) -> Result<(), String> {
    state.db.update_fragment_meta(&fragment_id, title.trim(), &explanation)?;
    state.sync.notify_change();
    Ok(())
}

#[tauri::command]
pub async fn delete_fragment(state: State<'_, AppState>, fragment_id: String) -> Result<(), String> {
    state.audio.stop()?;
    let path = state.db.delete_fragment(&fragment_id)?;
    remove_file_quietly(Path::new(&path));
    state.sync.notify_change();
    Ok(())
}

#[tauri::command]
pub async fn add_timeline_comment(
    state: State<'_, AppState>,
    fragment_id: String,
    timestamp_ms: u64,
    content: String,
) -> Result<TimelineCommentDto, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("El comentario está vacío".into());
    }
    let comment = state.db.add_timeline_comment(&fragment_id, timestamp_ms, content)?;
    state.sync.notify_change();
    Ok(comment)
}

#[tauri::command]
pub async fn delete_timeline_comment(state: State<'_, AppState>, comment_id: String) -> Result<(), String> {
    state.db.delete_timeline_comment(&comment_id)?;
    state.sync.notify_change();
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
    SoundfontInfo { current_path: current, loading, candidates: soundfont::discover(&state.paths) }
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
        return Err("Selecciona un fichero SoundFont .sf2 existente (los .sf3 no son compatibles)".into());
    }
    {
        let mut s = state.soundfont.lock().unwrap_or_else(|p| p.into_inner());
        if s.loading {
            return Err("Ya se está cargando un SoundFont; espera unos segundos".into());
        }
        s.loading = true;
    }
    let audio = state.audio.clone();
    let target = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || audio.load_soundfont(&target))
        .await
        .map_err(|e| format!("Error interno cargando el SoundFont: {e}"))
        .and_then(|r| r);
    {
        let mut s = state.soundfont.lock().unwrap_or_else(|p| p.into_inner());
        s.loading = false;
        if result.is_ok() {
            s.current = path.clone();
        }
    }
    result?;
    state.db.set_setting(soundfont::SETTING_SOUNDFONT_PATH, &path.to_string_lossy())?;
    Ok(soundfont_info(&state))
}

// ---------------------------------------------------------------------------
// Sincronización con Google Drive
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn save_google_credentials(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Err("Introduce el Client ID y el Client Secret".into());
    }
    state.sync.save_credentials(client_id.trim(), client_secret.trim())
}

#[tauri::command]
pub async fn start_google_auth(state: State<'_, AppState>) -> Result<String, String> {
    state.sync.start_auth().await
}

#[tauri::command]
pub async fn get_sync_status(state: State<'_, AppState>) -> Result<SyncStatusDto, String> {
    Ok(state.sync.status())
}

#[tauri::command]
pub async fn trigger_sync_now(state: State<'_, AppState>) -> Result<SyncStatusDto, String> {
    Ok(state.sync.sync_now().await)
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
