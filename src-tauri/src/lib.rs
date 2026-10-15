// Primero, para que la macro `t!` esté disponible en el resto de módulos.
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

/// Construye el estado de la aplicación: directorios, SoundFont, audio y la última bóveda abierta.
fn init_state(app: &tauri::AppHandle) -> Result<AppState, String> {
    let dirs = AppDirs::default_location();
    dirs.ensure_dirs()?;

    // El SoundFont se genera localmente si falta: la app nunca depende de descargas.
    let sf2 = match sf2_builder::ensure_soundfont(&dirs.sf2_file) {
        Ok(p) => p,
        Err(e) => {
            log::error!("No se pudo preparar el SoundFont: {e}");
            dirs.sf2_file.clone()
        }
    };

    let handle = app.clone();
    let progress: ProgressEmitter = Arc::new(move |p: PlaybackProgress| {
        let _ = handle.emit(EVENT_PLAYBACK_PROGRESS, p);
    });
    let audio = Arc::new(AudioEngine::new(&sf2, progress));
    if !audio.output_available() {
        log::warn!("Sin dispositivo de audio: el motor funciona en modo salida nula");
    }

    let config = AppConfig::load(&dirs.config_file);
    // Antes de reabrir la bóveda, para que sus avisos salgan ya en el idioma elegido.
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

    // Reabre la última bóveda. Si no está disponible o parece abierta en otro equipo, la app
    // arranca sin bóveda y el frontend muestra la pantalla de bienvenida.
    if let Some(last) = last_vault {
        match commands::activate_vault(app, &state, Path::new(&last), false) {
            Ok(r) if r.opened => {}
            Ok(r) => log::warn!("{}", r.lock_warning.unwrap_or_default()),
            Err(e) => log::warn!("No se pudo abrir la última bóveda: {e}"),
        }
    }

    // El motor arranca al instante con el piano integrado; el SoundFont preferido (p. ej.
    // FluidR3_GM.sf2 del sistema, con muestras reales de piano) se carga en segundo plano.
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
            // Al salir se libera el lock de la bóveda para que otro equipo pueda abrirla sin aviso.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Some(v) = state.vault.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
                        v.release_lock();
                    }
                }
            }
        });
}
