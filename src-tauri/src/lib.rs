// First, so the `t!` macro is available in the other modules.
#[macro_use]
pub mod i18n;
pub mod audio_engine;
pub mod commands;
pub mod db;
pub mod midi_recorder;
pub mod midi_slicer;
pub mod models;
pub mod paths;
pub mod sf2_builder;
pub mod soundfont;
pub mod vault;

use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

use tauri::{Emitter, Manager};

use crate::audio_engine::{AudioEngine, ProgressEmitter};
use crate::commands::{AppState, SoundfontState};
use crate::midi_recorder::MidiRecorder;
use crate::models::PlaybackProgress;
use crate::paths::AppDirs;
use crate::vault::AppConfig;

pub const EVENT_PLAYBACK_PROGRESS: &str = "playback-progress";

/// Builds the application state: directories, SoundFont, audio and the last open vault.
fn init_state(app: &tauri::AppHandle) -> Result<AppState, String> {
    let dirs = AppDirs::default_location();
    dirs.ensure_dirs()?;

    // The SoundFont is generated locally if missing: the app never depends on downloads.
    let sf2 = match sf2_builder::ensure_soundfont(&dirs.sf2_file) {
        Ok(p) => p,
        Err(e) => {
            log::error!("Could not prepare the SoundFont: {e}");
            dirs.sf2_file.clone()
        }
    };

    let handle = app.clone();
    let progress: ProgressEmitter = Arc::new(move |p: PlaybackProgress| {
        let _ = handle.emit(EVENT_PLAYBACK_PROGRESS, p);
    });
    let audio = Arc::new(AudioEngine::new(&sf2, progress));
    if !audio.output_available() {
        log::warn!("No audio device: the engine runs in null output mode");
    }

    let config = AppConfig::load(&dirs.config_file);
    // Before reopening the vault, so its warnings already come out in the chosen language.
    i18n::set_language(i18n::resolve(config.language.as_deref()));
    let last_vault = config.current_vault.clone();
    let state = AppState {
        dirs,
        config: Mutex::new(config),
        vault: RwLock::new(None),
        recorder: MidiRecorder::new(),
        audio: audio.clone(),
        recording_session: Mutex::new(None),
        soundfont: Arc::new(Mutex::new(SoundfontState { current: sf2.clone(), loading: false })),
    };

    // Reopens the last vault. If it is not available or seems open on another computer, the app
    // starts without a vault and the frontend shows the welcome screen.
    if let Some(last) = last_vault {
        match commands::activate_vault(app, &state, Path::new(&last), false) {
            Ok(r) if r.opened => {}
            Ok(r) => log::warn!("{}", r.lock_warning.unwrap_or_default()),
            Err(e) => log::warn!("Could not open the last vault: {e}"),
        }
    }

    // The engine starts instantly with the built-in piano; the preferred SoundFont (e.g. the
    // system's FluidR3_GM.sf2, with real piano samples) loads in the background.
    let saved = state.config.lock().unwrap_or_else(|p| p.into_inner()).soundfont_path.clone();
    let preferred = soundfont::preferred(&state.dirs, saved.as_deref());
    if preferred != sf2 {
        commands::load_soundfont_in_background(audio, state.soundfont.clone(), preferred);
    }

    Ok(state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            commands::get_soundfont_info,
            commands::set_soundfont,
            commands::get_vault_info,
            commands::create_vault,
            commands::open_vault,
            commands::import_legacy_data,
            commands::close_vault,
            commands::forget_recent_vault,
            commands::reveal_vault,
            commands::get_language,
            commands::set_language,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // On exit the vault lock is released so another computer can open it without a warning.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Some(v) = state.vault.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
                        v.release_lock();
                    }
                }
            }
        });
}
