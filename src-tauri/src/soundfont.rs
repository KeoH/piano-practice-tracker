//! Descubrimiento y elección del SoundFont usado por el sintetizador.
//!
//! Orden de preferencia: el elegido por el usuario (`AppConfig::soundfont_path`), un SoundFont
//! General MIDI del sistema con muestras reales de piano (p. ej. `FluidR3_GM.sf2` del paquete
//! `fluid-soundfont-gm`) y, como último recurso, el piano sintético generado por `sf2_builder`.
//! Solo se admiten `.sf2`: `rustysynth` no lee `.sf3` (muestras comprimidas en Ogg Vorbis).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::models::SoundfontCandidate;
use crate::paths::AppDirs;

/// Clave de `app_settings` donde la versión anterior guardaba el SoundFont elegido. Al abrir una
/// bóveda antigua se traslada a la configuración del equipo.
pub const LEGACY_SETTING_SOUNDFONT_PATH: &str = "soundfont_path";

/// Ficheros del sistema preferidos, de mejor a peor calidad de piano.
const PREFERRED_SYSTEM_NAMES: &[&str] = &["FluidR3_GM.sf2", "default-GM.sf2", "MuseScore_General.sf2", "TimGM6mb.sf2"];

fn system_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/sounds/sf2"),
        PathBuf::from("/usr/share/soundfonts"),
        PathBuf::from("/usr/local/share/soundfonts"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/soundfonts"));
    }
    dirs
}

fn is_sf2(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("sf2"))
}

fn candidate(path: &Path, builtin: &Path) -> Option<SoundfontCandidate> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let is_builtin = path == builtin;
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    Some(SoundfontCandidate {
        path: path.to_string_lossy().into_owned(),
        name: if is_builtin { t!("backend.soundfont.builtinName") } else { file_name },
        size_bytes: meta.len(),
        is_builtin,
    })
}

/// SoundFonts `.sf2` disponibles: los de la carpeta `assets` de la app y los del sistema.
/// Los enlaces simbólicos que apuntan al mismo fichero se listan una sola vez.
pub fn discover(paths: &AppDirs) -> Vec<SoundfontCandidate> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut dirs = vec![paths.assets_dir.clone()];
    dirs.extend(system_dirs());
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| is_sf2(p)).collect();
        files.sort();
        for path in files {
            let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !seen.insert(key) {
                continue;
            }
            if let Some(c) = candidate(&path, &paths.sf2_file) {
                out.push(c);
            }
        }
    }
    out
}

/// SoundFont a cargar: `saved` si sigue existiendo, si no el mejor del sistema y si no el integrado.
pub fn preferred(paths: &AppDirs, saved: Option<&str>) -> PathBuf {
    if let Some(saved) = saved.map(PathBuf::from).filter(|p| p.is_file() && is_sf2(p)) {
        return saved;
    }
    for name in PREFERRED_SYSTEM_NAMES {
        for dir in system_dirs() {
            let path = dir.join(name);
            if path.is_file() {
                return path;
            }
        }
    }
    discover(paths)
        .into_iter()
        .find(|c| !c.is_builtin)
        .map(|c| PathBuf::from(c.path))
        .unwrap_or_else(|| paths.sf2_file.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_soundfont_wins_and_builtin_is_listed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppDirs::new(dir.path(), dir.path().join("conf"));
        paths.ensure_dirs().unwrap();
        crate::sf2_builder::ensure_soundfont(&paths.sf2_file).unwrap();
        let custom = paths.assets_dir.join("mi_piano.sf2");
        std::fs::copy(&paths.sf2_file, &custom).unwrap();

        let list = discover(&paths);
        assert!(list.iter().any(|c| c.is_builtin && c.name == crate::i18n::tr_in("en", "backend.soundfont.builtinName", &[])));
        assert!(list.iter().any(|c| !c.is_builtin && c.name == "mi_piano.sf2"));
        assert_eq!(preferred(&paths, Some(&custom.to_string_lossy())), custom);
    }

    /// Requiere `fluid-soundfont-gm` instalado: `cargo test --lib -- --ignored system_fluidr3`.
    #[test]
    #[ignore]
    fn system_fluidr3_is_preferred_and_renders_piano() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppDirs::new(dir.path(), dir.path().join("conf"));
        paths.ensure_dirs().unwrap();
        let chosen = preferred(&paths, None);
        assert!(chosen.to_string_lossy().contains("FluidR3_GM"), "elegido: {}", chosen.display());

        let engine = crate::audio_engine::AudioEngine::new_headless(&paths.sf2_file, std::sync::Arc::new(|_| {}));
        let t0 = std::time::Instant::now();
        engine.load_soundfont(&chosen).unwrap();
        eprintln!("carga de {}: {:?}", chosen.display(), t0.elapsed());
        engine.set_live_synth(true);
        engine.send_live_midi(&[0x90, 60, 100]);
        let out = engine.render_offline(44_100 / 2);
        let peak = out.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.01, "pico {peak}");
    }

    #[test]
    fn missing_or_non_sf2_saved_path_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppDirs::new(dir.path(), dir.path().join("conf"));
        paths.ensure_dirs().unwrap();
        let p = preferred(&paths, Some("/no/existe.sf2"));
        assert_ne!(p, PathBuf::from("/no/existe.sf2"));
        let txt = dir.path().join("x.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert_ne!(preferred(&paths, Some(&txt.to_string_lossy())), txt);
    }
}
