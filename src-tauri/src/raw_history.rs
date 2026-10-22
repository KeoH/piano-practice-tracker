//! Undo history of the raw takes.
//!
//! Before each trim (extract or discard) the raw take is copied to
//! `midi/history/<session>/<uuid>.mid` and recorded in `raw_history`; undoing renames the newest
//! snapshot back over the raw take. The database keeps [`RAW_HISTORY_LIMIT`] snapshots per session.
//! A new recording clears the history, because the snapshots don't contain what was recorded
//! after them.
//!
//! [`RAW_HISTORY_LIMIT`]: crate::db::RAW_HISTORY_LIMIT

use std::path::{Path, PathBuf};

use crate::models::UndoTrimResult;
use crate::vault::Vault;

/// What a trim did to the raw take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrimAction {
    /// A fragment was extracted (undoing deletes it).
    Extract,
    Discard,
}

impl TrimAction {
    fn as_str(self) -> &'static str {
        match self {
            TrimAction::Extract => "extract",
            TrimAction::Discard => "discard",
        }
    }
}

pub(crate) fn remove_file_quietly(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("Could not delete {}: {e}", path.display());
        }
    }
}

impl Vault {
    /// Copies the raw take to a new snapshot (tmp + rename) and returns its path.
    pub fn snapshot_raw(&self, session_id: &str, raw: &Path) -> Result<PathBuf, String> {
        let dest = self.paths.history_file(session_id);
        let dir = dest.parent().unwrap_or(&self.paths.history_dir);
        std::fs::create_dir_all(dir).map_err(|e| t!("backend.io.createDir", path = dir.display(), e = e))?;
        let tmp = dest.with_extension("mid.tmp");
        std::fs::copy(raw, &tmp)
            .map_err(|e| t!("backend.io.copy", from = raw.display(), to = tmp.display(), e = e))?;
        std::fs::rename(&tmp, &dest).map_err(|e| {
            remove_file_quietly(&tmp);
            t!("backend.io.write", path = dest.display(), e = e)
        })?;
        Ok(dest)
    }

    /// Records a snapshot taken before a trim that succeeded. A failure only loses the undo step,
    /// so it is logged instead of failing the trim.
    pub fn record_trim(
        &self,
        session_id: &str,
        snapshot: &Path,
        duration_ms: u64,
        action: TrimAction,
        fragment_id: Option<&str>,
    ) {
        match self.db.push_raw_history(session_id, &snapshot.to_string_lossy(), duration_ms, action.as_str(), fragment_id) {
            Ok(pruned) => pruned.iter().for_each(|p| remove_file_quietly(Path::new(p))),
            Err(e) => {
                log::error!("Could not record the undo step: {e}");
                remove_file_quietly(snapshot);
            }
        }
    }

    /// Puts the snapshot back over the raw take after a trim that failed halfway.
    pub fn restore_snapshot(&self, snapshot: &Path, raw: &Path) {
        if let Err(e) = std::fs::rename(snapshot, raw) {
            log::error!("Could not restore {} from {}: {e}", raw.display(), snapshot.display());
        }
    }

    /// Restores the newest snapshot of the session's raw take. If that trim extracted a fragment
    /// that still exists, the fragment and its file are deleted.
    pub fn undo_trim(&self, session_id: &str) -> Result<UndoTrimResult, String> {
        let entry = self.db.last_raw_history(session_id)?.ok_or_else(|| t!("backend.undo.empty"))?;
        let snapshot = PathBuf::from(&entry.file_path);
        if !snapshot.is_file() {
            // A broken step would block the older ones forever.
            self.db.delete_raw_history(&entry.id)?;
            return Err(t!("backend.undo.snapshotMissing", path = snapshot.display()));
        }
        let session = self.db.get_session(session_id)?;
        let raw = session
            .raw_midi_path
            .map(PathBuf::from)
            .unwrap_or_else(|| self.paths.raw_session_file(session_id));
        std::fs::rename(&snapshot, &raw).map_err(|e| t!("backend.io.write", path = raw.display(), e = e))?;
        self.db.delete_raw_history(&entry.id)?;
        let session = self.db.set_session_raw_midi(session_id, &raw.to_string_lossy(), entry.duration_ms)?;

        let mut removed_fragment_id = None;
        if entry.action == TrimAction::Extract.as_str() {
            if let Some(fragment_id) = entry.fragment_id {
                // It may have been deleted by hand since: the section is back in the take anyway.
                if let Ok(path) = self.db.delete_fragment(&fragment_id) {
                    remove_file_quietly(Path::new(&path));
                    removed_fragment_id = Some(fragment_id);
                }
            }
        }
        Ok(UndoTrimResult { session, removed_fragment_id })
    }

    /// Deletes every snapshot of the session (after a new recording, or with the session).
    pub fn clear_raw_history(&self, session_id: &str) -> Result<(), String> {
        for path in self.db.clear_raw_history(session_id)? {
            remove_file_quietly(Path::new(&path));
        }
        self.remove_history_dir(session_id);
        Ok(())
    }

    /// Removes the session's (empty) history folder.
    pub fn remove_history_dir(&self, session_id: &str) {
        let _ = std::fs::remove_dir(self.paths.history_dir.join(session_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::RAW_HISTORY_LIMIT;
    use crate::midi_slicer::{discard_range, extract_fragment_and_trim, write_smf, TimedMidiEvent};
    use crate::vault::{create_vault, open_vault, OpenOutcome};

    fn temp_vault(dir: &Path) -> Vault {
        let root = dir.join("v");
        create_vault(&root).unwrap();
        match open_vault(&root, false).unwrap() {
            OpenOutcome::Opened(v) => v,
            OpenOutcome::Locked(m) => panic!("{m}"),
        }
    }

    /// Session with a 10 s raw take: a note per second.
    fn session_with_raw(vault: &Vault) -> (String, PathBuf) {
        let s = vault.db.create_session("S", 120).unwrap();
        let raw = vault.paths.raw_session_file(&s.id);
        let mut events = Vec::new();
        for i in 0..10u64 {
            events.push(TimedMidiEvent::new(i * 1_000_000, vec![0x90, 60, 80]));
            events.push(TimedMidiEvent::new(i * 1_000_000 + 500_000, vec![0x80, 60, 0]));
        }
        write_smf(&raw, &events, 120).unwrap();
        vault.db.set_session_raw_midi(&s.id, &raw.to_string_lossy(), 10_000).unwrap();
        (s.id, raw)
    }

    #[test]
    fn undo_extract_restores_take_and_deletes_fragment() {
        let dir = tempfile::tempdir().unwrap();
        let vault = temp_vault(dir.path());
        let (sid, raw) = session_with_raw(&vault);
        let original = std::fs::read(&raw).unwrap();

        let snapshot = vault.snapshot_raw(&sid, &raw).unwrap();
        assert!(snapshot.starts_with(vault.paths.history_dir.join(&sid)));
        let dest = vault.paths.fragment_file("f1");
        let slice = extract_fragment_and_trim(&raw, 2000, 5000, &dest, 120).unwrap();
        vault.db.insert_fragment("f1", &sid, "F", "", &dest.to_string_lossy(), 120, slice.fragment_duration_ms).unwrap();
        vault.db.set_session_raw_midi(&sid, &raw.to_string_lossy(), slice.remaining_duration_ms).unwrap();
        vault.record_trim(&sid, &snapshot, 10_000, TrimAction::Extract, Some("f1"));
        assert_eq!(vault.db.get_session_detail(&sid).unwrap().undo_depth, 1);

        let result = vault.undo_trim(&sid).unwrap();
        assert_eq!(result.removed_fragment_id.as_deref(), Some("f1"));
        assert_eq!(result.session.raw_duration_ms, 10_000);
        assert_eq!(std::fs::read(&raw).unwrap(), original);
        assert!(!dest.exists() && !snapshot.exists());
        let detail = vault.db.get_session_detail(&sid).unwrap();
        assert!(detail.fragments.is_empty());
        assert_eq!(detail.undo_depth, 0);
        assert_eq!(vault.undo_trim(&sid).unwrap_err(), crate::i18n::tr("backend.undo.empty", &[]));
    }

    #[test]
    fn undo_is_a_stack_and_new_recording_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let vault = temp_vault(dir.path());
        let (sid, raw) = session_with_raw(&vault);
        let mut versions = vec![std::fs::read(&raw).unwrap()];
        let mut duration = 10_000;
        for _ in 0..3 {
            let snapshot = vault.snapshot_raw(&sid, &raw).unwrap();
            let remaining = discard_range(&raw, 0, 1000, 120).unwrap();
            vault.db.set_session_raw_midi(&sid, &raw.to_string_lossy(), remaining).unwrap();
            vault.record_trim(&sid, &snapshot, duration, TrimAction::Discard, None);
            duration = remaining;
            versions.push(std::fs::read(&raw).unwrap());
        }
        // Undo walks back one version at a time.
        for expected in versions.iter().rev().skip(1) {
            vault.undo_trim(&sid).unwrap();
            assert_eq!(&std::fs::read(&raw).unwrap(), expected);
        }
        assert_eq!(vault.db.get_session(&sid).unwrap().raw_duration_ms, 10_000);

        let snapshot = vault.snapshot_raw(&sid, &raw).unwrap();
        vault.record_trim(&sid, &snapshot, 10_000, TrimAction::Discard, None);
        vault.clear_raw_history(&sid).unwrap();
        assert!(!snapshot.exists());
        assert!(!vault.paths.history_dir.join(&sid).exists());
        assert_eq!(vault.db.get_session_detail(&sid).unwrap().undo_depth, 0);
    }

    #[test]
    fn old_snapshots_are_pruned_and_missing_ones_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let vault = temp_vault(dir.path());
        let (sid, raw) = session_with_raw(&vault);
        let snapshots: Vec<PathBuf> = (0..RAW_HISTORY_LIMIT + 1)
            .map(|_| {
                let s = vault.snapshot_raw(&sid, &raw).unwrap();
                vault.record_trim(&sid, &s, 10_000, TrimAction::Discard, None);
                s
            })
            .collect();
        assert!(!snapshots[0].exists());
        assert!(snapshots[1..].iter().all(|s| s.exists()));

        std::fs::remove_file(snapshots.last().unwrap()).unwrap();
        assert!(vault.undo_trim(&sid).is_err());
        // The broken step is dropped and the next one works.
        assert_eq!(vault.db.get_session_detail(&sid).unwrap().undo_depth, RAW_HISTORY_LIMIT as u32 - 1);
        vault.undo_trim(&sid).unwrap();
    }
}
