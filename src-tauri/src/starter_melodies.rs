//! Starter melodies for the challenge mode: short public-domain tunes (right hand), from a warm-up
//! scale to the opening of Petzold's Minuet in G, so a new vault has something to play.
//!
//! They are added once per vault (`seed_once`, when it is opened) and can be added again from the
//! Challenges view (`add_missing`) if some were deleted. Each has a fixed id (`starter-<key>`), so
//! it is never added twice.

use chrono::{SecondsFormat, Utc};

use crate::challenge;
use crate::db::Database;
use crate::midi_slicer::{note_off_msg, write_smf, TimedMidiEvent};
use crate::models::{MelodyDto, MelodySource};
use crate::paths::AppPaths;

/// `app_settings` key: the starter melodies were already offered to this vault.
pub const SEEDED_SETTING: &str = "starter_melodies_seeded";
const VELOCITY: u8 = 80;
/// Fraction of each note's value that sounds (a light legato).
const ARTICULATION: f64 = 0.9;

// Keys (C4 = 60).
const G3: u8 = 55;
const C4: u8 = 60;
const D4: u8 = 62;
const E4: u8 = 64;
const F4: u8 = 65;
const FS4: u8 = 66;
const G4: u8 = 67;
const A4: u8 = 69;
const B4: u8 = 71;
const C5: u8 = 72;
const D5: u8 = 74;
const E5: u8 = 76;
const FS5: u8 = 78;
const G5: u8 = 79;

/// A melody as `(key, length in beats)`.
pub struct StarterMelody {
    /// Stable part of the id (`starter-<key>`).
    pub key: &'static str,
    /// `backend.starter.*` key of its title.
    pub title_key: &'static str,
    pub bpm: u32,
    pub notes: &'static [(u8, f64)],
}

pub const STARTERS: &[StarterMelody] = &[
    StarterMelody {
        key: "c-major-scale",
        title_key: "backend.starter.scale",
        bpm: 90,
        notes: &[
            (C4, 1.0), (D4, 1.0), (E4, 1.0), (F4, 1.0), (G4, 1.0), (A4, 1.0), (B4, 1.0), (C5, 1.0),
            (B4, 1.0), (A4, 1.0), (G4, 1.0), (F4, 1.0), (E4, 1.0), (D4, 1.0), (C4, 2.0),
        ],
    },
    StarterMelody {
        key: "twinkle",
        title_key: "backend.starter.twinkle",
        bpm: 100,
        notes: &[
            (C4, 1.0), (C4, 1.0), (G4, 1.0), (G4, 1.0), (A4, 1.0), (A4, 1.0), (G4, 2.0),
            (F4, 1.0), (F4, 1.0), (E4, 1.0), (E4, 1.0), (D4, 1.0), (D4, 1.0), (C4, 2.0),
            (G4, 1.0), (G4, 1.0), (F4, 1.0), (F4, 1.0), (E4, 1.0), (E4, 1.0), (D4, 2.0),
            (G4, 1.0), (G4, 1.0), (F4, 1.0), (F4, 1.0), (E4, 1.0), (E4, 1.0), (D4, 2.0),
            (C4, 1.0), (C4, 1.0), (G4, 1.0), (G4, 1.0), (A4, 1.0), (A4, 1.0), (G4, 2.0),
            (F4, 1.0), (F4, 1.0), (E4, 1.0), (E4, 1.0), (D4, 1.0), (D4, 1.0), (C4, 2.0),
        ],
    },
    StarterMelody {
        key: "frere-jacques",
        title_key: "backend.starter.frereJacques",
        bpm: 100,
        notes: &[
            (C4, 1.0), (D4, 1.0), (E4, 1.0), (C4, 1.0),
            (C4, 1.0), (D4, 1.0), (E4, 1.0), (C4, 1.0),
            (E4, 1.0), (F4, 1.0), (G4, 2.0),
            (E4, 1.0), (F4, 1.0), (G4, 2.0),
            (G4, 0.5), (A4, 0.5), (G4, 0.5), (F4, 0.5), (E4, 1.0), (C4, 1.0),
            (G4, 0.5), (A4, 0.5), (G4, 0.5), (F4, 0.5), (E4, 1.0), (C4, 1.0),
            (C4, 1.0), (G3, 1.0), (C4, 2.0),
            (C4, 1.0), (G3, 1.0), (C4, 2.0),
        ],
    },
    StarterMelody {
        key: "ode-to-joy",
        title_key: "backend.starter.odeToJoy",
        bpm: 100,
        notes: &[
            (E4, 1.0), (E4, 1.0), (F4, 1.0), (G4, 1.0), (G4, 1.0), (F4, 1.0), (E4, 1.0), (D4, 1.0),
            (C4, 1.0), (C4, 1.0), (D4, 1.0), (E4, 1.0), (E4, 1.5), (D4, 0.5), (D4, 2.0),
            (E4, 1.0), (E4, 1.0), (F4, 1.0), (G4, 1.0), (G4, 1.0), (F4, 1.0), (E4, 1.0), (D4, 1.0),
            (C4, 1.0), (C4, 1.0), (D4, 1.0), (E4, 1.0), (D4, 1.5), (C4, 0.5), (C4, 2.0),
            (D4, 1.0), (D4, 1.0), (E4, 1.0), (C4, 1.0),
            (D4, 1.0), (E4, 0.5), (F4, 0.5), (E4, 1.0), (C4, 1.0),
            (D4, 1.0), (E4, 0.5), (F4, 0.5), (E4, 1.0), (D4, 1.0),
            (C4, 1.0), (D4, 1.0), (G3, 2.0),
            (E4, 1.0), (E4, 1.0), (F4, 1.0), (G4, 1.0), (G4, 1.0), (F4, 1.0), (E4, 1.0), (D4, 1.0),
            (C4, 1.0), (C4, 1.0), (D4, 1.0), (E4, 1.0), (D4, 1.5), (C4, 0.5), (C4, 2.0),
        ],
    },
    StarterMelody {
        key: "minuet-in-g",
        title_key: "backend.starter.minuet",
        bpm: 100,
        notes: &[
            (D5, 1.0), (G4, 0.5), (A4, 0.5), (B4, 0.5), (C5, 0.5),
            (D5, 1.0), (G4, 1.0), (G4, 1.0),
            (E5, 1.0), (C5, 0.5), (D5, 0.5), (E5, 0.5), (FS5, 0.5),
            (G5, 1.0), (G4, 1.0), (G4, 1.0),
            (C5, 1.0), (D5, 0.5), (C5, 0.5), (B4, 0.5), (A4, 0.5),
            (B4, 1.0), (C5, 0.5), (B4, 0.5), (A4, 0.5), (G4, 0.5),
            (FS4, 1.0), (G4, 0.5), (A4, 0.5), (B4, 0.5), (G4, 0.5),
            (A4, 3.0),
        ],
    },
];

/// MIDI events of a starter melody (channel 0, the first note at 0).
pub fn starter_events(m: &StarterMelody) -> Vec<TimedMidiEvent> {
    let beat_us = 60_000_000.0 / m.bpm.max(1) as f64;
    let mut events = Vec::with_capacity(m.notes.len() * 2);
    let mut t = 0.0f64;
    for &(key, beats) in m.notes {
        let len = beats * beat_us;
        events.push(TimedMidiEvent::new(t.round() as u64, vec![0x90, key, VELOCITY]));
        events.push(TimedMidiEvent::new((t + len * ARTICULATION).round() as u64, note_off_msg(0, key)));
        t += len;
    }
    events.sort_by_key(|e| e.time_us);
    events
}

pub fn starter_id(m: &StarterMelody) -> String {
    format!("starter-{}", m.key)
}

/// Adds the starter melodies the vault does not have; returns the ones added.
pub fn add_missing(db: &Database, paths: &AppPaths) -> Result<Vec<MelodyDto>, String> {
    let mut added = Vec::new();
    for m in STARTERS {
        let id = starter_id(m);
        if db.get_melody(&id).is_ok() {
            continue;
        }
        let dest = paths.melody_file(&id);
        let events = starter_events(m);
        write_smf(&dest, &events, m.bpm)?;
        let notes = challenge::extract_notes(&events);
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let melody = MelodyDto {
            id,
            title: t!(m.title_key),
            source: MelodySource::Starter,
            source_fragment_id: None,
            file_path: dest.to_string_lossy().into_owned(),
            bpm: m.bpm,
            duration_ms: (notes.iter().map(|n| n.end_us).max().unwrap_or(0) + 500) / 1000,
            note_count: notes.len() as u32,
            created_at: now.clone(),
            updated_at: now,
        };
        match db.insert_melody(&melody) {
            Ok(m) => added.push(m),
            Err(e) => {
                let _ = std::fs::remove_file(&dest);
                return Err(e);
            }
        }
    }
    Ok(added)
}

/// Adds the starter melodies the first time a vault is opened with challenge mode; never again
/// afterwards, so the ones the user deletes do not come back on their own.
pub fn seed_once(db: &Database, paths: &AppPaths) -> Result<(), String> {
    if db.get_setting(SEEDED_SETTING)?.is_some() {
        return Ok(());
    }
    add_missing(db, paths)?;
    db.set_setting(SEEDED_SETTING, &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::challenge::{load_notes, score_attempt};
    use std::path::Path;

    fn vault() -> (tempfile::TempDir, Database, AppPaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_base(dir.path());
        let db = Database::open_in_memory(dir.path()).unwrap();
        (dir, db, paths)
    }

    #[test]
    fn melodies_are_well_formed() {
        assert_eq!(STARTERS.len(), 5);
        for m in STARTERS {
            assert!(!m.notes.is_empty(), "{}", m.key);
            assert!(m.notes.iter().all(|&(k, b)| (21..=108).contains(&k) && b > 0.0), "{}", m.key);
            let notes = challenge::extract_notes(&starter_events(m));
            assert_eq!(notes.len(), m.notes.len(), "{}", m.key);
            assert_eq!(notes[0].start_us, 0);
            // Monophonic: each note ends before the next one starts.
            assert!(notes.windows(2).all(|w| w[0].end_us <= w[1].start_us), "{}", m.key);
        }
        // Whole bars: 4/4 for all but the minuet, in 3/4.
        let beats = |key: &str| STARTERS.iter().find(|m| m.key == key).unwrap().notes.iter().map(|n| n.1).sum::<f64>();
        assert_eq!(beats("twinkle"), 48.0);
        assert_eq!(beats("frere-jacques"), 32.0);
        assert_eq!(beats("ode-to-joy"), 64.0);
        assert_eq!(beats("minuet-in-g"), 24.0);
    }

    #[test]
    fn seeds_once_and_can_add_the_missing_ones_again() {
        let (_dir, db, paths) = vault();
        seed_once(&db, &paths).unwrap();
        let list = db.list_melodies().unwrap();
        assert_eq!(list.len(), 5);
        assert!(list.iter().all(|s| s.melody.source == MelodySource::Starter && s.melody.id.starts_with("starter-")));
        assert!(list.iter().all(|s| Path::new(&s.melody.file_path).is_file()));

        // The file plays back as the same notes and a perfect run scores 1000.
        let ode = db.get_melody("starter-ode-to-joy").unwrap();
        assert_eq!(ode.bpm, 100);
        assert_eq!(ode.note_count, 62);
        let notes = load_notes(Path::new(&ode.file_path)).unwrap();
        assert_eq!(notes.len(), 62);
        let played: Vec<_> = notes.iter().map(|n| TimedMidiEvent::new(n.start_us, vec![0x90, n.key, 80])).collect();
        assert_eq!(score_attempt(&notes, &played, 100, 0).score, 1000);

        // Deleted ones do not come back by themselves…
        for p in db.delete_melody("starter-twinkle").unwrap() {
            std::fs::remove_file(p).unwrap();
        }
        seed_once(&db, &paths).unwrap();
        assert_eq!(db.list_melodies().unwrap().len(), 4);
        // …but can be added again, without duplicating the rest.
        let added = add_missing(&db, &paths).unwrap();
        assert_eq!(added.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["starter-twinkle"]);
        assert_eq!(db.list_melodies().unwrap().len(), 5);
        assert!(add_missing(&db, &paths).unwrap().is_empty());
    }
}
