//! Rutas de la aplicación.
//!
//! - [`AppPaths`]: estructura de una bóveda (carpeta elegida por el usuario donde viven la base de
//!   datos, las pistas MIDI y las imágenes). En la base de datos las rutas se guardan relativas a
//!   la raíz de la bóveda, para que pueda moverse o sincronizarse entre equipos.
//! - [`AppDirs`]: lo que depende del equipo y no de la bóveda (configuración y SoundFont integrado).

use std::path::{Component, Path, PathBuf};

/// Carpeta que marca un directorio como bóveda.
pub const VAULT_MARKER_DIR: &str = ".piano-tracker";
/// Nombre de la base de datos dentro de la bóveda.
pub const DB_FILE_NAME: &str = "piano_tracker.sqlite";

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub base: PathBuf,
    pub db_file: PathBuf,
    pub raw_dir: PathBuf,
    pub fragments_dir: PathBuf,
    pub media_dir: PathBuf,
}

impl AppPaths {
    pub fn from_base(base: impl AsRef<Path>) -> Self {
        let base = base.as_ref().to_path_buf();
        AppPaths {
            db_file: base.join(DB_FILE_NAME),
            raw_dir: base.join("midi").join("raw"),
            fragments_dir: base.join("midi").join("fragments"),
            media_dir: base.join("media"),
            base,
        }
    }

    pub fn ensure_dirs(&self) -> Result<(), String> {
        for dir in [&self.base, &self.raw_dir, &self.fragments_dir, &self.media_dir, &self.marker_dir()] {
            std::fs::create_dir_all(dir).map_err(|e| t!("backend.io.createDir", path = dir.display(), e = e))?;
        }
        Ok(())
    }

    pub fn raw_session_file(&self, session_id: &str) -> PathBuf {
        self.raw_dir.join(format!("raw_session_{session_id}.mid"))
    }

    pub fn fragment_file(&self, fragment_id: &str) -> PathBuf {
        self.fragments_dir.join(format!("frag_{fragment_id}.mid"))
    }

    pub fn marker_dir(&self) -> PathBuf {
        self.base.join(VAULT_MARKER_DIR)
    }

    pub fn vault_file(&self) -> PathBuf {
        self.marker_dir().join("vault.json")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.marker_dir().join("lock")
    }

    /// Ruta relativa a la bóveda (con `/`) si `path` está dentro de ella.
    pub fn to_relative(&self, path: &Path) -> Option<String> {
        relative_to(&self.base, path)
    }

    /// Resuelve una ruta relativa a la bóveda. Rechaza rutas absolutas y componentes `..`.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        let p = Path::new(rel);
        if rel.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
            return Err(t!("backend.vault.invalidRelativePath", path = rel));
        }
        Ok(self.base.join(p))
    }
}

/// `path` relativa a `base` (separada por `/`), o `None` si no está dentro.
pub fn relative_to(base: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    let parts: Option<Vec<&str>> = rel
        .components()
        .map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    let parts = parts?;
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

/// Directorios de la aplicación que no forman parte de ninguna bóveda.
#[derive(Debug, Clone)]
pub struct AppDirs {
    /// `$XDG_DATA_HOME/piano-tracker`: aquí vivían los datos antes de las bóvedas.
    pub data_dir: PathBuf,
    pub assets_dir: PathBuf,
    /// Piano sintético generado por `sf2_builder` (regenerable).
    pub sf2_file: PathBuf,
    /// `$XDG_CONFIG_HOME/piano-tracker/config.json`: bóveda actual, recientes y SoundFont.
    pub config_file: PathBuf,
}

impl AppDirs {
    pub fn new(data_dir: impl AsRef<Path>, config_dir: impl AsRef<Path>) -> Self {
        let data_dir = data_dir.as_ref().to_path_buf();
        let assets_dir = data_dir.join("assets");
        AppDirs {
            sf2_file: assets_dir.join("default_piano.sf2"),
            assets_dir,
            config_file: config_dir.as_ref().join("config.json"),
            data_dir,
        }
    }

    /// Ubicaciones XDG (`~/.local/share/piano-tracker` y `~/.config/piano-tracker`).
    pub fn default_location() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let xdg = |var: &str, fallback: &[&str]| {
            std::env::var_os(var)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .or_else(|| home.as_ref().map(|h| fallback.iter().fold(h.clone(), |acc, s| acc.join(s))))
                .unwrap_or_else(std::env::temp_dir)
                .join("piano-tracker")
        };
        Self::new(xdg("XDG_DATA_HOME", &[".local", "share"]), xdg("XDG_CONFIG_HOME", &[".config"]))
    }

    pub fn ensure_dirs(&self) -> Result<(), String> {
        let config_dir = self.config_file.parent().map(Path::to_path_buf).unwrap_or_default();
        for dir in [&self.data_dir, &self.assets_dir, &config_dir] {
            std::fs::create_dir_all(dir).map_err(|e| t!("backend.io.createDir", path = dir.display(), e = e))?;
        }
        Ok(())
    }

    /// Base de datos de la versión anterior (sin bóvedas), si existe.
    pub fn legacy_db(&self) -> Option<PathBuf> {
        Some(self.data_dir.join(DB_FILE_NAME)).filter(|p| p.is_file())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_expected_layout() {
        let dir = tempfile::tempdir().unwrap();
        let p = AppPaths::from_base(dir.path());
        p.ensure_dirs().unwrap();
        assert!(p.raw_dir.is_dir() && p.fragments_dir.is_dir() && p.media_dir.is_dir() && p.marker_dir().is_dir());
        assert!(p.raw_session_file("abc").ends_with("midi/raw/raw_session_abc.mid"));
        assert!(p.fragment_file("x").ends_with("midi/fragments/frag_x.mid"));
    }

    #[test]
    fn relative_and_resolve() {
        let p = AppPaths::from_base("/v/Mi bóveda");
        assert_eq!(p.to_relative(&p.fragment_file("a")).as_deref(), Some("midi/fragments/frag_a.mid"));
        assert_eq!(p.to_relative(Path::new("/otra/x.mid")), None);
        assert_eq!(p.to_relative(Path::new("/v/Mi bóveda")), None);
        assert_eq!(p.resolve("media/x.png").unwrap(), PathBuf::from("/v/Mi bóveda/media/x.png"));
        assert!(p.resolve("../fuera.png").is_err());
        assert!(p.resolve("media/../../x").is_err());
        assert!(p.resolve("/etc/passwd").is_err());
        assert!(p.resolve("").is_err());
    }

    #[test]
    fn app_dirs_layout() {
        let d = AppDirs::new("/data/pt", "/conf/pt");
        assert_eq!(d.sf2_file, PathBuf::from("/data/pt/assets/default_piano.sf2"));
        assert_eq!(d.config_file, PathBuf::from("/conf/pt/config.json"));
    }
}
