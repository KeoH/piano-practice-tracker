pub mod audio_engine;
pub mod commands;
pub mod db;
pub mod drive_sync;
pub mod midi_recorder;
pub mod midi_slicer;
pub mod models;
pub mod paths;
pub mod sf2_builder;
pub mod soundfont;

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

use crate::audio_engine::{AudioEngine, ProgressEmitter};
use crate::commands::{AppState, SoundfontState};
use crate::db::Database;
use crate::drive_sync::{DriveSync, SyncStatusEmitter};
use crate::midi_recorder::MidiRecorder;
use crate::models::{PlaybackProgress, SyncStatusDto};
use crate::paths::AppPaths;

pub const EVENT_PLAYBACK_PROGRESS: &str = "playback-progress";
pub const EVENT_SYNC_STATUS: &str = "sync-status";

/// Construye el estado de la aplicación: directorios, SoundFont, SQLite, audio y sync.
fn init_state(app: &tauri::AppHandle) -> Result<AppState, String> {
    let paths = AppPaths::default_location();
    paths.ensure_dirs()?;

    // El SoundFont se genera localmente si falta: la app nunca depende de descargas.
    let sf2 = match sf2_builder::ensure_soundfont(&paths.sf2_file) {
        Ok(p) => p,
        Err(e) => {
            log::error!("No se pudo preparar el SoundFont: {e}");
            paths.sf2_file.clone()
        }
    };

    let db = Arc::new(Database::open(&paths.db_file)?);

    let handle = app.clone();
    let progress: ProgressEmitter = Arc::new(move |p: PlaybackProgress| {
        let _ = handle.emit(EVENT_PLAYBACK_PROGRESS, p);
    });
    let audio = Arc::new(AudioEngine::new(&sf2, progress));
    if !audio.output_available() {
        log::warn!("Sin dispositivo de audio: el motor funciona en modo salida nula");
    }

    let handle = app.clone();
    let sync_emitter: SyncStatusEmitter = Arc::new(move |s: SyncStatusDto| {
        let _ = handle.emit(EVENT_SYNC_STATUS, s);
    });
    let sync = DriveSync::new(db.clone(), paths.clone(), sync_emitter);
    tauri::async_runtime::spawn(sync.clone().run_worker());

    // El motor arranca al instante con el piano integrado; el SoundFont preferido (p. ej.
    // FluidR3_GM.sf2 del sistema, con muestras reales de piano) se carga en segundo plano.
    let saved = db.get_setting(soundfont::SETTING_SOUNDFONT_PATH).ok().flatten();
    let preferred = soundfont::preferred(&paths, saved.as_deref());
    let soundfont_state = Arc::new(Mutex::new(SoundfontState { current: sf2.clone(), loading: false }));
    if preferred != sf2 {
        commands::load_soundfont_in_background(audio.clone(), soundfont_state.clone(), preferred);
    }

    Ok(AppState {
        paths,
        db,
        recorder: MidiRecorder::new(),
        audio,
        sync,
        recording_session: Mutex::new(None),
        soundfont: soundfont_state,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(if cfg!(debug_assertions) { log::LevelFilter::Info } else { log::LevelFilter::Warn })
                .build(),
        )
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_midi_ports,
            commands::start_recording,
            commands::update_live_recording_settings,
            commands::stop_recording,
            commands::get_midi_activity,
            commands::extract_midi_fragment,
            commands::discard_midi_range,
            commands::play_midi_file,
            commands::pause_midi_playback,
            commands::seek_midi_playback,
            commands::stop_midi_playback,
            commands::get_sessions,
            commands::get_session_detail,
            commands::create_session,
            commands::update_session,
            commands::delete_session,
            commands::save_session_image,
            commands::update_fragment_meta,
            commands::delete_fragment,
            commands::add_timeline_comment,
            commands::delete_timeline_comment,
            commands::save_google_credentials,
            commands::start_google_auth,
            commands::get_sync_status,
            commands::trigger_sync_now,
            commands::get_soundfont_info,
            commands::set_soundfont,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
