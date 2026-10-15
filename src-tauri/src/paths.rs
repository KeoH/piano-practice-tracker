//! Rutas locales gestionadas por la aplicación (`~/.local/share/piano-tracker/`).

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub base: PathBuf,
    pub db_file: PathBuf,
    pub raw_dir: PathBuf,
    pub fragments_dir: PathBuf,
    pub media_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub sf2_file: PathBuf,
}

impl AppPaths {
    pub fn from_base(base: impl AsRef<Path>) -> Self {
        let base = base.as_ref().to_path_buf();
        let assets_dir = base.join("assets");
        AppPaths {
            db_file: base.join("piano_tracker.sqlite"),
            raw_dir: base.join("midi").join("raw"),
            fragments_dir: base.join("midi").join("fragments"),
            media_dir: base.join("media"),
            sf2_file: assets_dir.join("default_piano.sf2"),
            assets_dir,
            base,
        }
    }

    /// `$XDG_DATA_HOME/piano-tracker` o `~/.local/share/piano-tracker`.
    pub fn default_location() -> Self {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
            .unwrap_or_else(std::env::temp_dir);
        Self::from_base(data_home.join("piano-tracker"))
    }

    pub fn ensure_dirs(&self) -> Result<(), String> {
        for dir in [&self.base, &self.raw_dir, &self.fragments_dir, &self.media_dir, &self.assets_dir] {
            std::fs::create_dir_all(dir).map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
        }
        Ok(())
    }

    pub fn raw_session_file(&self, session_id: &str) -> PathBuf {
        self.raw_dir.join(format!("raw_session_{session_id}.mid"))
    }

    pub fn fragment_file(&self, fragment_id: &str) -> PathBuf {
        self.fragments_dir.join(format!("frag_{fragment_id}.mid"))
    }

    pub fn db_backup_file(&self) -> PathBuf {
        self.base.join("piano_tracker_backup.sqlite")
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
        assert!(p.raw_dir.is_dir() && p.fragments_dir.is_dir() && p.media_dir.is_dir() && p.assets_dir.is_dir());
        assert!(p.raw_session_file("abc").ends_with("midi/raw/raw_session_abc.mid"));
        assert!(p.fragment_file("x").ends_with("midi/fragments/frag_x.mid"));
    }
}
