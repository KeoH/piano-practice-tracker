//! SQLite persistence inside the vault.
//!
//! - Schema versioned with `PRAGMA user_version`.
//!   - v1: original schema from SPECIFICATIONS.md §3.1 (with Google Drive columns and queue).
//!   - v2: no Drive sync, and paths relative to the vault.
//!   - v3: repertoire (`pieces`, `piece_id` / `passage` on fragments), practice log and the undo
//!     history of the raw takes.
//!   - v4: compositions (`compositions`, `composition_tracks`, `composition_clips`).
//!   - v5: challenge mode (`melodies` and `challenge_attempts`).
//! - File paths (`raw_midi_path`, `file_path`, `local_path`, `played_midi_path`) are stored **relative to the vault
//!   root** and the public API returns them absolute. That way the vault can be moved or synced
//!   between computers (Dropbox, Syncthing…) without breaking references.
//! - `journal_mode = DELETE`: at rest the database is a single file, with no `-wal`/`-shm`,
//!   which keeps a sync service from uploading a half-written state.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use chrono::{Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::{
    AttemptDetails, AttemptDto, AttemptSummaryDto, CompositionClipDto, CompositionDto, CompositionSummaryDto,
    CompositionTrackDto, FragmentDto, LibraryFragmentDto, MelodyDto, MelodySource, MelodySummaryDto, PieceDetailDto,
    PieceDto, PieceSummaryDto, PieceTakeDto, PracticeDayDto, SessionDetailDto, SessionDto, SessionMediaDto,
    SessionSummaryDto, TimelineCommentDto,
};
use crate::paths::relative_to;

const SCHEMA_VERSION: i64 = 5;
/// Trims of a raw take that can be undone; older snapshots are deleted.
pub const RAW_HISTORY_LIMIT: usize = 10;
/// Tracks of a composition: one MIDI channel each, skipping channel 10 (GM percussion).
pub const COMPOSITION_MAX_TRACKS: usize = 15;
/// Times a clip can be played back to back.
pub const CLIP_MAX_REPEATS: u32 = 16;
/// Transposition of a clip, in semitones either way.
pub const CLIP_MAX_TRANSPOSE: i32 = 24;

/// Also used by tests elsewhere to build a database from the previous version.
pub(crate) const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    session_date TEXT NOT NULL,
    bpm INTEGER NOT NULL DEFAULT 120,
    raw_midi_path TEXT,
    raw_duration_ms INTEGER NOT NULL DEFAULT 0,
    markdown_notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING'
);

CREATE TABLE IF NOT EXISTS midi_fragments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    explanation TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL,
    bpm INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    drive_file_id TEXT,
    created_at TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS timeline_comments (
    id TEXT PRIMARY KEY,
    fragment_id TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (fragment_id) REFERENCES midi_fragments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_media (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    local_path TEXT NOT NULL,
    drive_file_id TEXT,
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_path TEXT,
    created_at TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fragments_session ON midi_fragments(session_id);
CREATE INDEX IF NOT EXISTS idx_comments_fragment ON timeline_comments(fragment_id);
CREATE INDEX IF NOT EXISTS idx_media_session ON session_media(session_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_entity ON sync_queue(entity_type, entity_id);
"#;

/// v2: Google Drive removed (queue, statuses and remote ids). Paths are rewritten separately.
const MIGRATION_V2: &str = r#"
DROP INDEX IF EXISTS idx_sync_queue_entity;
DROP TABLE IF EXISTS sync_queue;
ALTER TABLE sessions DROP COLUMN sync_status;
ALTER TABLE midi_fragments DROP COLUMN drive_file_id;
ALTER TABLE midi_fragments DROP COLUMN sync_status;
ALTER TABLE session_media DROP COLUMN drive_file_id;
ALTER TABLE session_media DROP COLUMN sync_status;
DELETE FROM app_settings WHERE key LIKE 'google\_%' ESCAPE '\' OR key LIKE 'drive\_%' ESCAPE '\';
"#;

/// v3: repertoire, practice log and undo history of the raw takes.
const MIGRATION_V3: &str = r#"
CREATE TABLE IF NOT EXISTS pieces (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    composer TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
ALTER TABLE midi_fragments ADD COLUMN piece_id TEXT REFERENCES pieces(id) ON DELETE SET NULL;
ALTER TABLE midi_fragments ADD COLUMN passage TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_fragments_piece ON midi_fragments(piece_id);

CREATE TABLE IF NOT EXISTS practice_log (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    practiced_on TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_practice_day ON practice_log(practiced_on);

CREATE TABLE IF NOT EXISTS raw_history (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    action TEXT NOT NULL,
    fragment_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_session ON raw_history(session_id, created_at);

-- Backfill: what each existing session kept (raw take + fragments) counts as practised on its
-- date. Sections discarded before v3 are lost.
INSERT INTO practice_log (id, session_id, practiced_on, duration_ms, recorded_at)
SELECT lower(hex(randomblob(16))), id, session_date, total, updated_at FROM (
    SELECT s.id, s.session_date, s.updated_at,
           s.raw_duration_ms + COALESCE((SELECT SUM(f.duration_ms) FROM midi_fragments f WHERE f.session_id = s.id), 0) AS total
    FROM sessions s
) WHERE total > 0;
"#;

/// v4: compositions. A clip points to a fragment (its MIDI is never copied) and disappears with it.
const MIGRATION_V4: &str = r#"
CREATE TABLE IF NOT EXISTS compositions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS composition_tracks (
    id TEXT PRIMARY KEY,
    composition_id TEXT NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    program INTEGER NOT NULL DEFAULT 0,
    volume INTEGER NOT NULL DEFAULT 100,
    muted INTEGER NOT NULL DEFAULT 0,
    solo INTEGER NOT NULL DEFAULT 0,
    sustain INTEGER NOT NULL DEFAULT 1,
    color INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_composition ON composition_tracks(composition_id, order_index);
CREATE TABLE IF NOT EXISTS composition_clips (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES composition_tracks(id) ON DELETE CASCADE,
    fragment_id TEXT NOT NULL REFERENCES midi_fragments(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    trim_start_ms INTEGER NOT NULL DEFAULT 0,
    length_ms INTEGER NOT NULL,
    repeats INTEGER NOT NULL DEFAULT 1,
    transpose INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clips_track ON composition_clips(track_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_clips_fragment ON composition_clips(fragment_id);
"#;

/// v5: challenge mode. A melody is a frozen copy of its MIDI, so it has no foreign key to the
/// fragment it came from.
const MIGRATION_V5: &str = r#"
CREATE TABLE IF NOT EXISTS melodies (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    source_fragment_id TEXT,
    file_path TEXT NOT NULL,
    bpm INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    note_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_attempts (
    id TEXT PRIMARY KEY,
    melody_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tempo_pct INTEGER NOT NULL,
    bpm INTEGER NOT NULL,
    completed INTEGER NOT NULL,
    score INTEGER NOT NULL,
    accuracy REAL NOT NULL,
    hits INTEGER NOT NULL,
    perfect INTEGER NOT NULL,
    misses INTEGER NOT NULL,
    wrong INTEGER NOT NULL,
    extra INTEGER NOT NULL,
    mean_offset_ms INTEGER NOT NULL,
    mean_abs_offset_ms INTEGER NOT NULL,
    latency_comp_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    played_midi_path TEXT,
    details_json TEXT NOT NULL,
    FOREIGN KEY (melody_id) REFERENCES melodies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attempts_melody ON challenge_attempts(melody_id, created_at);
"#;

/// Vault sub-paths that identify each file type when converting old paths.
const RAW_MARKER: &str = "/midi/raw/";
const FRAGMENT_MARKER: &str = "/midi/fragments/";
const MEDIA_MARKER: &str = "/media/";

const SESSION_COLS: &str =
    "id, title, session_date, bpm, raw_midi_path, raw_duration_ms, markdown_notes, updated_at";
const FRAGMENT_COLS: &str =
    "id, session_id, title, explanation, file_path, bpm, duration_ms, order_index, created_at, piece_id, passage";
/// `FRAGMENT_COLS` qualified with the `f` alias, for joins.
const FRAGMENT_COLS_F: &str = "f.id, f.session_id, f.title, f.explanation, f.file_path, f.bpm, f.duration_ms, \
     f.order_index, f.created_at, f.piece_id, f.passage";
const PIECE_COLS: &str = "id, title, composer, notes, archived, created_at, updated_at";
const PIECE_COLS_P: &str = "p.id, p.title, p.composer, p.notes, p.archived, p.created_at, p.updated_at";
const COMMENT_COLS: &str = "id, fragment_id, timestamp_ms, content, created_at";
const MEDIA_COLS: &str = "id, session_id, local_path";

/// Completed attempts per melody in `MelodySummaryDto.recent_accuracy`.
const RECENT_ACCURACY: usize = 12;
/// Accuracy from which a tempo counts as mastered.
const MASTERED_ACCURACY: f64 = 0.9;
const MELODY_COLS: &str =
    "id, title, source, source_fragment_id, file_path, bpm, duration_ms, note_count, created_at, updated_at";
const ATTEMPT_COLS: &str = "id, melody_id, created_at, tempo_pct, bpm, completed, score, accuracy, hits, perfect, \
     misses, wrong, extra, mean_offset_ms, mean_abs_offset_ms, latency_comp_ms, duration_ms, played_midi_path, details_json";

fn db_err(e: rusqlite::Error) -> String {
    t!("backend.db.error", e = e)
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn to_u64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

fn to_u32(v: i64) -> u32 {
    if v < 0 {
        0
    } else {
        u32::try_from(v).unwrap_or(u32::MAX)
    }
}

fn to_i64(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

fn map_session(r: &Row) -> rusqlite::Result<SessionDto> {
    Ok(SessionDto {
        id: r.get(0)?,
        title: r.get(1)?,
        session_date: r.get(2)?,
        bpm: to_u32(r.get(3)?),
        raw_midi_path: r.get(4)?,
        raw_duration_ms: to_u64(r.get(5)?),
        markdown_notes: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

fn map_fragment(r: &Row) -> rusqlite::Result<FragmentDto> {
    Ok(FragmentDto {
        id: r.get(0)?,
        session_id: r.get(1)?,
        title: r.get(2)?,
        explanation: r.get(3)?,
        file_path: r.get(4)?,
        bpm: to_u32(r.get(5)?),
        duration_ms: to_u64(r.get(6)?),
        order_index: r.get(7)?,
        created_at: r.get(8)?,
        piece_id: r.get(9)?,
        passage: r.get(10)?,
        comments: Vec::new(),
    })
}

fn map_piece(r: &Row) -> rusqlite::Result<PieceDto> {
    Ok(PieceDto {
        id: r.get(0)?,
        title: r.get(1)?,
        composer: r.get(2)?,
        notes: r.get(3)?,
        archived: r.get::<_, i64>(4)? != 0,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

fn map_history(r: &Row) -> rusqlite::Result<RawHistoryEntry> {
    Ok(RawHistoryEntry {
        id: r.get(0)?,
        session_id: r.get(1)?,
        file_path: r.get(2)?,
        duration_ms: to_u64(r.get(3)?),
        action: r.get(4)?,
        fragment_id: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const HISTORY_COLS: &str = "id, session_id, file_path, duration_ms, action, fragment_id, created_at";

fn map_comment(r: &Row) -> rusqlite::Result<TimelineCommentDto> {
    Ok(TimelineCommentDto {
        id: r.get(0)?,
        fragment_id: r.get(1)?,
        timestamp_ms: to_u64(r.get(2)?),
        content: r.get(3)?,
        created_at: r.get(4)?,
    })
}

fn map_media(r: &Row) -> rusqlite::Result<SessionMediaDto> {
    Ok(SessionMediaDto { id: r.get(0)?, session_id: r.get(1)?, local_path: r.get(2)? })
}

// ---------------------------------------------------------------------------
// Internal functions over a connection (so they can be composed in transactions)
// ---------------------------------------------------------------------------

fn fetch_session(conn: &Connection, session_id: &str) -> Result<SessionDto, String> {
    conn.query_row(
        &format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1"),
        params![session_id],
        map_session,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| t!("backend.db.sessionMissing", id = session_id))
}

fn fetch_comments(conn: &Connection, fragment_id: &str) -> Result<Vec<TimelineCommentDto>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COMMENT_COLS} FROM timeline_comments WHERE fragment_id = ?1 \
             ORDER BY timestamp_ms ASC, created_at ASC"
        ))
        .map_err(db_err)?;
    let rows = stmt.query_map(params![fragment_id], map_comment).map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

fn map_melody(r: &Row) -> rusqlite::Result<MelodyDto> {
    Ok(MelodyDto {
        id: r.get(0)?,
        title: r.get(1)?,
        source: MelodySource::parse(&r.get::<_, String>(2)?),
        source_fragment_id: r.get(3)?,
        file_path: r.get(4)?,
        bpm: to_u32(r.get(5)?),
        duration_ms: to_u64(r.get(6)?),
        note_count: to_u32(r.get(7)?),
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

fn map_attempt(r: &Row) -> rusqlite::Result<AttemptDto> {
    let details: String = r.get(18)?;
    Ok(AttemptDto {
        summary: AttemptSummaryDto {
            id: r.get(0)?,
            melody_id: r.get(1)?,
            created_at: r.get(2)?,
            tempo_pct: to_u32(r.get(3)?),
            bpm: to_u32(r.get(4)?),
            completed: r.get::<_, i64>(5)? != 0,
            score: to_u32(r.get(6)?),
            accuracy: r.get(7)?,
            hits: to_u32(r.get(8)?),
            perfect: to_u32(r.get(9)?),
            misses: to_u32(r.get(10)?),
            wrong: to_u32(r.get(11)?),
            extra: to_u32(r.get(12)?),
            mean_offset_ms: r.get::<_, i64>(13)?.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
            mean_abs_offset_ms: to_u32(r.get(14)?),
            latency_comp_ms: to_u32(r.get(15)?),
            duration_ms: to_u64(r.get(16)?),
        },
        played_midi_path: r.get(17)?,
        // A detail that cannot be read (written by a newer version) leaves the totals usable.
        details: serde_json::from_str(&details).unwrap_or_else(|e| {
            log::warn!("Unreadable attempt details: {e}");
            AttemptDetails::default()
        }),
    })
}

fn fetch_fragment(conn: &Connection, fragment_id: &str) -> Result<FragmentDto, String> {
    let mut frag = conn
        .query_row(
            &format!("SELECT {FRAGMENT_COLS} FROM midi_fragments WHERE id = ?1"),
            params![fragment_id],
            map_fragment,
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| t!("backend.db.fragmentMissing", id = fragment_id))?;
    frag.comments = fetch_comments(conn, fragment_id)?;
    Ok(frag)
}

fn fetch_piece(conn: &Connection, piece_id: &str) -> Result<PieceDto, String> {
    conn.query_row(&format!("SELECT {PIECE_COLS} FROM pieces WHERE id = ?1"), params![piece_id], map_piece)
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| t!("backend.db.pieceMissing", id = piece_id))
}

fn to_u8(v: i64) -> u8 {
    u8::try_from(v.clamp(0, i64::from(u8::MAX))).unwrap_or(0)
}

/// Clip columns with the fragment they point to (`c` = clip, `f` = fragment).
const CLIP_COLS_C: &str = "c.id, c.fragment_id, c.start_ms, c.trim_start_ms, c.length_ms, c.repeats, c.transpose, \
     f.title, f.file_path, f.duration_ms";

fn map_clip(r: &Row) -> rusqlite::Result<CompositionClipDto> {
    Ok(CompositionClipDto {
        id: r.get(0)?,
        fragment_id: r.get(1)?,
        start_ms: to_u64(r.get(2)?),
        trim_start_ms: to_u64(r.get(3)?),
        length_ms: to_u64(r.get(4)?),
        repeats: to_u32(r.get(5)?),
        transpose: r.get(6)?,
        fragment_title: r.get(7)?,
        fragment_file_path: r.get(8)?,
        fragment_duration_ms: to_u64(r.get(9)?),
    })
}

fn map_track(r: &Row) -> rusqlite::Result<CompositionTrackDto> {
    Ok(CompositionTrackDto {
        id: r.get(0)?,
        name: r.get(1)?,
        program: to_u8(r.get(2)?),
        volume: to_u8(r.get(3)?),
        muted: r.get::<_, i64>(4)? != 0,
        solo: r.get::<_, i64>(5)? != 0,
        sustain: r.get::<_, i64>(6)? != 0,
        color: to_u8(r.get(7)?),
        clips: Vec::new(),
    })
}

/// End of the clip on the timeline, repeats included.
pub fn clip_end_ms(clip: &CompositionClipDto) -> u64 {
    clip.start_ms.saturating_add(clip.length_ms.saturating_mul(u64::from(clip.repeats)))
}

/// The composition with its tracks and clips (paths as stored).
fn fetch_composition(conn: &Connection, composition_id: &str) -> Result<CompositionDto, String> {
    let (title, created_at, updated_at) = conn
        .query_row(
            "SELECT title, created_at, updated_at FROM compositions WHERE id = ?1",
            params![composition_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| t!("backend.composition.missing", id = composition_id))?;
    let mut tracks = {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, program, volume, muted, solo, sustain, color FROM composition_tracks \
                 WHERE composition_id = ?1 ORDER BY order_index ASC",
            )
            .map_err(db_err)?;
        let rows = stmt.query_map(params![composition_id], map_track).map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
    };
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CLIP_COLS_C} FROM composition_clips c JOIN midi_fragments f ON f.id = c.fragment_id \
             WHERE c.track_id = ?1 ORDER BY c.start_ms ASC"
        ))
        .map_err(db_err)?;
    for track in &mut tracks {
        let rows = stmt.query_map(params![track.id], map_clip).map_err(db_err)?;
        track.clips = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    }
    Ok(CompositionDto { id: composition_id.to_string(), title, created_at, updated_at, tracks })
}

/// Checks a composition before saving it: track limit, instrument and volume ranges, clips inside
/// their fragment and no overlapping clips on a track.
fn validate_composition(conn: &Connection, doc: &CompositionDto) -> Result<(), String> {
    if doc.tracks.len() > COMPOSITION_MAX_TRACKS {
        return Err(t!("backend.composition.tooManyTracks", max = COMPOSITION_MAX_TRACKS));
    }
    for track in &doc.tracks {
        if track.program > 127 {
            return Err(t!("backend.composition.program", program = track.program));
        }
        if track.volume > 127 {
            return Err(t!("backend.composition.volume", volume = track.volume));
        }
        let mut spans: Vec<(u64, u64)> = Vec::with_capacity(track.clips.len());
        for clip in &track.clips {
            let (title, duration_ms): (String, i64) = conn
                .query_row(
                    "SELECT title, duration_ms FROM midi_fragments WHERE id = ?1",
                    params![clip.fragment_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(db_err)?
                .ok_or_else(|| t!("backend.db.fragmentMissing", id = clip.fragment_id))?;
            if clip.length_ms == 0 {
                return Err(t!("backend.composition.emptyClip", fragment = title));
            }
            if clip.trim_start_ms.saturating_add(clip.length_ms) > to_u64(duration_ms) {
                return Err(t!("backend.composition.clipOutside", fragment = title));
            }
            if !(1..=CLIP_MAX_REPEATS).contains(&clip.repeats) {
                return Err(t!("backend.composition.repeats", max = CLIP_MAX_REPEATS));
            }
            if clip.transpose.abs() > CLIP_MAX_TRANSPOSE {
                return Err(t!("backend.composition.transpose", max = CLIP_MAX_TRANSPOSE));
            }
            spans.push((clip.start_ms, clip_end_ms(clip)));
        }
        spans.sort_unstable();
        if spans.windows(2).any(|w| w[1].0 < w[0].1) {
            return Err(t!("backend.composition.overlap", track = track.name));
        }
    }
    Ok(())
}

/// The id sent by the frontend, or a new one if it is empty.
fn id_or_new(id: &str) -> String {
    if id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        id.to_string()
    }
}

fn history_depth(conn: &Connection, session_id: &str) -> Result<u32, String> {
    conn.query_row("SELECT COUNT(*) FROM raw_history WHERE session_id = ?1", params![session_id], |r| r.get(0))
        .map(to_u32)
        .map_err(db_err)
}

fn touch_session(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute("UPDATE sessions SET updated_at = ?1 WHERE id = ?2", params![now_rfc3339(), session_id])
        .map_err(db_err)?;
    Ok(())
}

fn fragment_session_id(conn: &Connection, fragment_id: &str) -> Result<String, String> {
    conn.query_row("SELECT session_id FROM midi_fragments WHERE id = ?1", params![fragment_id], |r| r.get(0))
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| t!("backend.db.fragmentMissing", id = fragment_id))
}

fn fetch_melody(conn: &Connection, melody_id: &str) -> Result<MelodyDto, String> {
    conn.query_row(&format!("SELECT {MELODY_COLS} FROM melodies WHERE id = ?1"), params![melody_id], map_melody)
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| t!("backend.db.melodyMissing", id = melody_id))
}

fn fetch_attempt(conn: &Connection, attempt_id: &str) -> Result<AttemptDto, String> {
    conn.query_row(
        &format!("SELECT {ATTEMPT_COLS} FROM challenge_attempts WHERE id = ?1"),
        params![attempt_id],
        map_attempt,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| t!("backend.db.attemptMissing", id = attempt_id))
}

fn backup_in(conn: &Connection, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| t!("backend.io.createDir", path = parent.display(), e = e))?;
        }
    }
    let mut tmp_name = dest.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    if tmp.exists() {
        std::fs::remove_file(&tmp)
            .map_err(|e| t!("backend.db.removeTemp", path = tmp.display(), e = e))?;
    }
    let tmp_str = tmp
        .to_str()
        .ok_or_else(|| t!("backend.db.invalidBackupPath", path = tmp.display()))?;
    conn.execute("VACUUM INTO ?1", params![tmp_str])
        .map_err(|e| t!("backend.db.backupFailed", e = e))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        t!("backend.db.backupMoveFailed", path = dest.display(), e = e)
    })
}

/// Converts an absolute path from the previous version into one relative to the vault, looking
/// for the sub-path that identifies its type (`/midi/raw/`, …). Returns `(relative, old_base)`.
fn legacy_to_relative(path: &str, marker: &str) -> Option<(String, String)> {
    if !path.starts_with('/') {
        return None;
    }
    let idx = path.rfind(marker)?;
    Some((path[idx + 1..].to_string(), path[..idx].to_string()))
}

/// Data step of the v2 migration: absolute → relative paths, in the Markdown too.
/// `extra_bases` are directories where the data may have lived (the vault's current root).
fn rewrite_paths_to_relative(conn: &Connection, extra_bases: &[String]) -> Result<(), String> {
    let mut bases: BTreeSet<String> = extra_bases.iter().filter(|b| b.len() > 1).cloned().collect();
    for (table, col, marker) in [
        ("sessions", "raw_midi_path", RAW_MARKER),
        ("midi_fragments", "file_path", FRAGMENT_MARKER),
        ("session_media", "local_path", MEDIA_MARKER),
    ] {
        let rows: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(&format!("SELECT id, {col} FROM {table} WHERE {col} LIKE '/%'"))
                .map_err(db_err)?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
        for (id, path) in rows {
            if let Some((rel, base)) = legacy_to_relative(&path, marker) {
                conn.execute(&format!("UPDATE {table} SET {col} = ?1 WHERE id = ?2"), params![rel, id])
                    .map_err(db_err)?;
                bases.insert(base);
            }
        }
    }

    // Markdown images carried the absolute path: the base prefix is stripped.
    // Longest bases first, in case one contains another.
    let mut prefixes: Vec<String> = bases.into_iter().map(|b| format!("{}/", b.trim_end_matches('/'))).collect();
    prefixes.sort_by_key(|p| std::cmp::Reverse(p.len()));
    let notes: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, markdown_notes FROM sessions").map_err(db_err)?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
    };
    for (id, md) in notes {
        let mut out = md.clone();
        for p in &prefixes {
            out = out.replace(&format!("{p}media/"), "media/");
        }
        if out != md {
            conn.execute("UPDATE sessions SET markdown_notes = ?1 WHERE id = ?2", params![out, id])
                .map_err(db_err)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Snapshot of a raw take taken before a trim (`raw_history`).
#[derive(Debug, Clone, PartialEq)]
pub struct RawHistoryEntry {
    pub id: String,
    pub session_id: String,
    /// Absolute path of the snapshot.
    pub file_path: String,
    /// Duration of the raw take when the snapshot was taken.
    pub duration_ms: u64,
    /// `"extract"` or `"discard"`.
    pub action: String,
    /// Fragment created by the trim (only for `"extract"`).
    pub fragment_id: Option<String>,
    pub created_at: String,
}

/// SQLite database shareable between threads (`Arc<Database>`).
pub struct Database {
    conn: Mutex<Connection>,
    /// Vault root: stored relative paths are resolved against it.
    root: PathBuf,
}

impl Database {
    /// Opens (or creates) the file, enables foreign keys, sets `journal_mode = DELETE` and applies
    /// migrations. `root` is the vault root.
    pub fn open(path: &Path, root: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| t!("backend.io.createDir", path = parent.display(), e = e))?;
            }
        }
        let conn = Connection::open(path)
            .map_err(|e| t!("backend.db.openFailed", path = path.display(), e = e))?;
        // If it was in WAL mode (previous version), this change checkpoints and removes -wal/-shm.
        let mode: String = conn
            .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
            .map_err(|e| t!("backend.db.prepareFailed", path = path.display(), e = e))?;
        if !mode.eq_ignore_ascii_case("delete") {
            log::warn!("The database is still in journal mode '{mode}'");
        }
        Self::init(conn, root)
    }

    /// In-memory database (tests). Relative paths are resolved against `root`.
    pub fn open_in_memory(root: &Path) -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(db_err)?;
        Self::init(conn, root)
    }

    fn init(mut conn: Connection, root: &Path) -> Result<Self, String> {
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(db_err)?;
        Self::migrate(&mut conn, root)?;
        Ok(Database { conn: Mutex::new(conn), root: root.to_path_buf() })
    }

    fn migrate(conn: &mut Connection, root: &Path) -> Result<(), String> {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err)?;
        if version > SCHEMA_VERSION {
            return Err(t!("backend.db.newerSchema", version = version, supported = SCHEMA_VERSION));
        }
        if version < 1 {
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute_batch(MIGRATION_V1)
                .map_err(|e| t!("backend.db.migrationFailed", version = 1, e = e))?;
            tx.execute_batch("PRAGMA user_version = 1;").map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        if version < 2 {
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute_batch(MIGRATION_V2)
                .map_err(|e| t!("backend.db.migrationFailed", version = 2, e = e))?;
            rewrite_paths_to_relative(&tx, &[root.to_string_lossy().into_owned()])
                .map_err(|e| t!("backend.db.migrationFailed", version = 2, e = e))?;
            tx.execute_batch("PRAGMA user_version = 2;").map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        if version < 3 {
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute_batch(MIGRATION_V3)
                .map_err(|e| t!("backend.db.migrationFailed", version = 3, e = e))?;
            tx.execute_batch("PRAGMA user_version = 3;").map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        if version < 4 {
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute_batch(MIGRATION_V4)
                .map_err(|e| t!("backend.db.migrationFailed", version = 4, e = e))?;
            tx.execute_batch("PRAGMA user_version = 4;").map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        if version < 5 {
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute_batch(MIGRATION_V5)
                .map_err(|e| t!("backend.db.migrationFailed", version = 5, e = e))?;
            tx.execute_batch("PRAGMA user_version = 5;").map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| t!("backend.db.poisoned"))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Path to store: relative to the vault if it is inside it; otherwise unchanged.
    fn store_path(&self, path: &str) -> String {
        relative_to(&self.root, Path::new(path)).unwrap_or_else(|| path.to_string())
    }

    /// Absolute path for a stored path.
    fn load_path(&self, stored: String) -> String {
        if stored.is_empty() || Path::new(&stored).is_absolute() {
            stored
        } else {
            self.root.join(&stored).to_string_lossy().into_owned()
        }
    }

    fn fix_session(&self, mut s: SessionDto) -> SessionDto {
        s.raw_midi_path = s.raw_midi_path.map(|p| self.load_path(p));
        s
    }

    fn fix_fragment(&self, mut f: FragmentDto) -> FragmentDto {
        f.file_path = self.load_path(f.file_path);
        f
    }

    fn fix_melody(&self, mut m: MelodyDto) -> MelodyDto {
        m.file_path = self.load_path(m.file_path);
        m
    }

    fn fix_attempt(&self, mut a: AttemptDto) -> AttemptDto {
        a.played_midi_path = a.played_midi_path.map(|p| self.load_path(p));
        a
    }

    fn fix_media(&self, mut m: SessionMediaDto) -> SessionMediaDto {
        m.local_path = self.load_path(m.local_path);
        m
    }

    fn fix_composition(&self, mut c: CompositionDto) -> CompositionDto {
        for clip in c.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()) {
            clip.fragment_file_path = self.load_path(std::mem::take(&mut clip.fragment_file_path));
        }
        c
    }

    // ----------------------------- Sessions -----------------------------

    pub fn create_session(&self, title: &str, bpm: u32) -> Result<SessionDto, String> {
        let conn = self.lock()?;
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO sessions (id, title, session_date, bpm, raw_midi_path, raw_duration_ms, \
             markdown_notes, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, 0, '', ?5)",
            params![id, title, today(), i64::from(bpm), now_rfc3339()],
        )
        .map_err(db_err)?;
        fetch_session(&conn, &id).map(|s| self.fix_session(s))
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionSummaryDto>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.title, s.session_date, s.bpm, s.raw_duration_ms, \
                 (SELECT COUNT(*) FROM midi_fragments f WHERE f.session_id = s.id), \
                 s.updated_at \
                 FROM sessions s ORDER BY s.session_date DESC, s.updated_at DESC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SessionSummaryDto {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    session_date: r.get(2)?,
                    bpm: to_u32(r.get(3)?),
                    raw_duration_ms: to_u64(r.get(4)?),
                    fragment_count: to_u32(r.get(5)?),
                    updated_at: r.get(6)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
    }

    pub fn get_session(&self, session_id: &str) -> Result<SessionDto, String> {
        let conn = self.lock()?;
        fetch_session(&conn, session_id).map(|s| self.fix_session(s))
    }

    pub fn get_session_detail(&self, session_id: &str) -> Result<SessionDetailDto, String> {
        let conn = self.lock()?;
        let session = self.fix_session(fetch_session(&conn, session_id)?);

        let mut fragments = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {FRAGMENT_COLS} FROM midi_fragments WHERE session_id = ?1 \
                     ORDER BY order_index ASC, created_at ASC"
                ))
                .map_err(db_err)?;
            let rows = stmt.query_map(params![session_id], map_fragment).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };

        let comments = {
            let mut stmt = conn
                .prepare(
                    "SELECT c.id, c.fragment_id, c.timestamp_ms, c.content, c.created_at \
                     FROM timeline_comments c JOIN midi_fragments f ON f.id = c.fragment_id \
                     WHERE f.session_id = ?1 ORDER BY c.timestamp_ms ASC, c.created_at ASC",
                )
                .map_err(db_err)?;
            let rows = stmt.query_map(params![session_id], map_comment).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
        for comment in comments {
            if let Some(frag) = fragments.iter_mut().find(|f| f.id == comment.fragment_id) {
                frag.comments.push(comment);
            }
        }
        let fragments = fragments.into_iter().map(|f| self.fix_fragment(f)).collect();

        let media = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {MEDIA_COLS} FROM session_media WHERE session_id = ?1 ORDER BY rowid ASC"
                ))
                .map_err(db_err)?;
            let rows = stmt.query_map(params![session_id], map_media).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
        let media = media.into_iter().map(|m| self.fix_media(m)).collect();
        let undo_depth = history_depth(&conn, session_id)?;
        let undo_fragment_id: Option<String> = conn
            .query_row(
                "SELECT fragment_id FROM raw_history WHERE session_id = ?1 \
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![session_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .flatten();

        Ok(SessionDetailDto { session, fragments, media, undo_depth, undo_fragment_id })
    }

    pub fn update_session(&self, session_id: &str, title: &str, bpm: u32, markdown_notes: &str) -> Result<(), String> {
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE sessions SET title = ?1, bpm = ?2, markdown_notes = ?3, updated_at = ?4 WHERE id = ?5",
                params![title, i64::from(bpm), markdown_notes, now_rfc3339(), session_id],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(t!("backend.db.sessionMissing", id = session_id));
        }
        Ok(())
    }

    pub fn set_session_raw_midi(&self, session_id: &str, raw_path: &str, duration_ms: u64) -> Result<SessionDto, String> {
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE sessions SET raw_midi_path = ?1, raw_duration_ms = ?2, updated_at = ?3 WHERE id = ?4",
                params![self.store_path(raw_path), to_i64(duration_ms), now_rfc3339(), session_id],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(t!("backend.db.sessionMissing", id = session_id));
        }
        fetch_session(&conn, session_id).map(|s| self.fix_session(s))
    }

    /// Deletes the session in cascade and returns the absolute paths for the caller to delete.
    pub fn delete_session(&self, session_id: &str) -> Result<Vec<String>, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let session = fetch_session(&tx, session_id)?;
        let mut paths = Vec::new();
        if let Some(raw) = session.raw_midi_path.filter(|p| !p.is_empty()) {
            paths.push(raw);
        }
        for sql in [
            "SELECT file_path FROM midi_fragments WHERE session_id = ?1",
            "SELECT local_path FROM session_media WHERE session_id = ?1",
            "SELECT file_path FROM raw_history WHERE session_id = ?1",
        ] {
            let mut stmt = tx.prepare(sql).map_err(db_err)?;
            let rows = stmt.query_map(params![session_id], |r| r.get::<_, String>(0)).map_err(db_err)?;
            paths.extend(rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?);
        }
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(paths.into_iter().map(|p| self.load_path(p)).collect())
    }

    // ----------------------------- Fragments -----------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn insert_fragment(
        &self,
        fragment_id: &str,
        session_id: &str,
        title: &str,
        explanation: &str,
        file_path: &str,
        bpm: u32,
        duration_ms: u64,
    ) -> Result<FragmentDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        fetch_session(&tx, session_id)?;
        let order_index: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(order_index), -1) + 1 FROM midi_fragments WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        tx.execute(
            "INSERT INTO midi_fragments (id, session_id, title, explanation, file_path, bpm, duration_ms, \
             order_index, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                fragment_id,
                session_id,
                title,
                explanation,
                self.store_path(file_path),
                i64::from(bpm),
                to_i64(duration_ms),
                order_index,
                now_rfc3339()
            ],
        )
        .map_err(db_err)?;
        touch_session(&tx, session_id)?;
        let frag = fetch_fragment(&tx, fragment_id)?;
        tx.commit().map_err(db_err)?;
        Ok(self.fix_fragment(frag))
    }

    pub fn get_fragment(&self, fragment_id: &str) -> Result<FragmentDto, String> {
        let conn = self.lock()?;
        fetch_fragment(&conn, fragment_id).map(|f| self.fix_fragment(f))
    }

    pub fn update_fragment_meta(&self, fragment_id: &str, title: &str, explanation: &str) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let session_id = fragment_session_id(&tx, fragment_id)?;
        tx.execute(
            "UPDATE midi_fragments SET title = ?1, explanation = ?2 WHERE id = ?3",
            params![title, explanation, fragment_id],
        )
        .map_err(db_err)?;
        touch_session(&tx, &session_id)?;
        tx.commit().map_err(db_err)
    }

    /// Deletes the fragment and returns its absolute path so the caller can delete the file.
    pub fn delete_fragment(&self, fragment_id: &str) -> Result<String, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let frag = fetch_fragment(&tx, fragment_id)?;
        tx.execute("DELETE FROM midi_fragments WHERE id = ?1", params![fragment_id]).map_err(db_err)?;
        touch_session(&tx, &frag.session_id)?;
        tx.commit().map_err(db_err)?;
        Ok(self.load_path(frag.file_path))
    }

    /// Files the fragment under a piece (or takes it out with `None`) and sets its passage.
    pub fn set_fragment_piece(&self, fragment_id: &str, piece_id: Option<&str>, passage: &str) -> Result<FragmentDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let session_id = fragment_session_id(&tx, fragment_id)?;
        if let Some(pid) = piece_id {
            fetch_piece(&tx, pid)?;
            tx.execute("UPDATE pieces SET updated_at = ?1 WHERE id = ?2", params![now_rfc3339(), pid])
                .map_err(db_err)?;
        }
        tx.execute(
            "UPDATE midi_fragments SET piece_id = ?1, passage = ?2 WHERE id = ?3",
            params![piece_id, passage.trim(), fragment_id],
        )
        .map_err(db_err)?;
        touch_session(&tx, &session_id)?;
        let frag = fetch_fragment(&tx, fragment_id)?;
        tx.commit().map_err(db_err)?;
        Ok(self.fix_fragment(frag))
    }

    // ----------------------------- Raw take history (undo) -----------------------------

    /// Records a snapshot of the raw take taken before a trim. Keeps the newest
    /// [`RAW_HISTORY_LIMIT`] entries of the session and returns the absolute paths of the pruned
    /// snapshots so the caller can delete them.
    pub fn push_raw_history(
        &self,
        session_id: &str,
        file_path: &str,
        duration_ms: u64,
        action: &str,
        fragment_id: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        fetch_session(&tx, session_id)?;
        tx.execute(
            &format!("INSERT INTO raw_history ({HISTORY_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"),
            params![
                uuid::Uuid::new_v4().to_string(),
                session_id,
                self.store_path(file_path),
                to_i64(duration_ms),
                action,
                fragment_id,
                now_rfc3339()
            ],
        )
        .map_err(db_err)?;
        let pruned: Vec<(String, String)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, file_path FROM raw_history WHERE session_id = ?1 \
                     ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?2",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![session_id, RAW_HISTORY_LIMIT as i64], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
        for (id, _) in &pruned {
            tx.execute("DELETE FROM raw_history WHERE id = ?1", params![id]).map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(pruned.into_iter().map(|(_, p)| self.load_path(p)).collect())
    }

    /// Newest snapshot of the session's raw take (with an absolute path), if any.
    pub fn last_raw_history(&self, session_id: &str) -> Result<Option<RawHistoryEntry>, String> {
        let conn = self.lock()?;
        let entry = conn
            .query_row(
                &format!(
                    "SELECT {HISTORY_COLS} FROM raw_history WHERE session_id = ?1 \
                     ORDER BY created_at DESC, rowid DESC LIMIT 1"
                ),
                params![session_id],
                map_history,
            )
            .optional()
            .map_err(db_err)?;
        Ok(entry.map(|mut e| {
            e.file_path = self.load_path(e.file_path);
            e
        }))
    }

    /// Deletes the whole history of the session and returns the snapshots' absolute paths.
    pub fn clear_raw_history(&self, session_id: &str) -> Result<Vec<String>, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let paths = {
            let mut stmt = tx.prepare("SELECT file_path FROM raw_history WHERE session_id = ?1").map_err(db_err)?;
            let rows = stmt.query_map(params![session_id], |r| r.get::<_, String>(0)).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
        tx.execute("DELETE FROM raw_history WHERE session_id = ?1", params![session_id]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(paths.into_iter().map(|p| self.load_path(p)).collect())
    }

    pub fn delete_raw_history(&self, entry_id: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM raw_history WHERE id = ?1", params![entry_id]).map_err(db_err)?;
        Ok(())
    }

    // ----------------------------- Practice log -----------------------------

    /// Records `duration_ms` of practice today (local date) for the session.
    pub fn add_practice_entry(&self, session_id: &str, duration_ms: u64) -> Result<(), String> {
        if duration_ms == 0 {
            return Ok(());
        }
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO practice_log (id, session_id, practiced_on, duration_ms, recorded_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![uuid::Uuid::new_v4().to_string(), session_id, today(), to_i64(duration_ms), now_rfc3339()],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Practice per day in `[from, to]` (ISO dates, inclusive), only the days with practice.
    pub fn practice_days(&self, from: &str, to: &str) -> Result<Vec<PracticeDayDto>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT practiced_on, SUM(duration_ms), COUNT(DISTINCT session_id) FROM practice_log \
                 WHERE practiced_on >= ?1 AND practiced_on <= ?2 GROUP BY practiced_on ORDER BY practiced_on",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![from, to], |r| {
                Ok(PracticeDayDto { date: r.get(0)?, duration_ms: to_u64(r.get(1)?), sessions: to_u32(r.get(2)?) })
            })
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
    }

    // ----------------------------- Pieces -----------------------------

    pub fn create_piece(&self, title: &str, composer: &str) -> Result<PieceDto, String> {
        let conn = self.lock()?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_rfc3339();
        conn.execute(
            &format!("INSERT INTO pieces ({PIECE_COLS}) VALUES (?1, ?2, ?3, '', 0, ?4, ?4)"),
            params![id, title, composer, now],
        )
        .map_err(db_err)?;
        fetch_piece(&conn, &id)
    }

    pub fn update_piece(&self, piece_id: &str, title: &str, composer: &str, notes: &str, archived: bool) -> Result<PieceDto, String> {
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE pieces SET title = ?1, composer = ?2, notes = ?3, archived = ?4, updated_at = ?5 WHERE id = ?6",
                params![title, composer, notes, i64::from(archived), now_rfc3339(), piece_id],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(t!("backend.db.pieceMissing", id = piece_id));
        }
        fetch_piece(&conn, piece_id)
    }

    /// Deletes the piece; its fragments stay in their sessions without a piece.
    pub fn delete_piece(&self, piece_id: &str) -> Result<(), String> {
        let conn = self.lock()?;
        let changed = conn.execute("DELETE FROM pieces WHERE id = ?1", params![piece_id]).map_err(db_err)?;
        if changed == 0 {
            return Err(t!("backend.db.pieceMissing", id = piece_id));
        }
        Ok(())
    }

    /// Active pieces first, most recently practised first, then by title.
    pub fn list_pieces(&self) -> Result<Vec<PieceSummaryDto>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PIECE_COLS_P}, COUNT(f.id), MAX(s.session_date) FROM pieces p \
                 LEFT JOIN midi_fragments f ON f.piece_id = p.id \
                 LEFT JOIN sessions s ON s.id = f.session_id \
                 GROUP BY p.id \
                 ORDER BY p.archived ASC, COALESCE(MAX(s.session_date), '') DESC, p.title COLLATE NOCASE ASC"
            ))
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PieceSummaryDto {
                    piece: map_piece(r)?,
                    take_count: to_u32(r.get(7)?),
                    last_practiced: r.get(8)?,
                    passages: Vec::new(),
                })
            })
            .map_err(db_err)?;
        let mut pieces = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
        let mut stmt = conn
            .prepare(
                "SELECT piece_id, passage FROM midi_fragments WHERE piece_id IS NOT NULL AND passage <> '' \
                 GROUP BY piece_id, passage ORDER BY passage COLLATE NOCASE",
            )
            .map_err(db_err)?;
        let passages = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(db_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_err)?;
        for (piece_id, passage) in passages {
            if let Some(p) = pieces.iter_mut().find(|p| p.piece.id == piece_id) {
                p.passages.push(passage);
            }
        }
        Ok(pieces)
    }

    pub fn get_piece_detail(&self, piece_id: &str) -> Result<PieceDetailDto, String> {
        let conn = self.lock()?;
        let piece = fetch_piece(&conn, piece_id)?;
        let takes = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {FRAGMENT_COLS_F}, s.title, s.session_date FROM midi_fragments f \
                     JOIN sessions s ON s.id = f.session_id WHERE f.piece_id = ?1 \
                     ORDER BY f.passage COLLATE NOCASE ASC, s.session_date ASC, f.created_at ASC"
                ))
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![piece_id], |r| {
                    Ok(PieceTakeDto { fragment: map_fragment(r)?, session_title: r.get(11)?, session_date: r.get(12)? })
                })
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
        let takes = takes
            .into_iter()
            .map(|mut t| {
                t.fragment.comments = fetch_comments(&conn, &t.fragment.id)?;
                t.fragment = self.fix_fragment(t.fragment);
                Ok(t)
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(PieceDetailDto { piece, takes })
    }

    // ----------------------------- Compositions -----------------------------

    /// Most recently edited first.
    pub fn list_compositions(&self) -> Result<Vec<CompositionSummaryDto>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.title, c.updated_at, \
                 (SELECT COUNT(*) FROM composition_tracks t WHERE t.composition_id = c.id), \
                 (SELECT COUNT(*) FROM composition_clips k JOIN composition_tracks t ON t.id = k.track_id \
                  WHERE t.composition_id = c.id), \
                 (SELECT COALESCE(MAX(k.start_ms + k.length_ms * k.repeats), 0) FROM composition_clips k \
                  JOIN composition_tracks t ON t.id = k.track_id WHERE t.composition_id = c.id) \
                 FROM compositions c ORDER BY c.updated_at DESC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CompositionSummaryDto {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    updated_at: r.get(2)?,
                    track_count: to_u32(r.get(3)?),
                    clip_count: to_u32(r.get(4)?),
                    duration_ms: to_u64(r.get(5)?),
                })
            })
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
    }

    /// New composition with one empty piano track named `track_name`.
    pub fn create_composition(&self, title: &str, track_name: &str) -> Result<CompositionDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_rfc3339();
        tx.execute(
            "INSERT INTO compositions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, title, now],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO composition_tracks (id, composition_id, name, order_index) VALUES (?1, ?2, ?3, 0)",
            params![uuid::Uuid::new_v4().to_string(), id, track_name],
        )
        .map_err(db_err)?;
        let created = fetch_composition(&tx, &id)?;
        tx.commit().map_err(db_err)?;
        Ok(self.fix_composition(created))
    }

    pub fn get_composition(&self, composition_id: &str) -> Result<CompositionDto, String> {
        let conn = self.lock()?;
        fetch_composition(&conn, composition_id).map(|c| self.fix_composition(c))
    }

    /// Replaces the title, tracks and clips with `doc` in one transaction (the vector order is the
    /// track order). Empty track or clip ids get a new one; the clips' `fragment_*` fields are ignored.
    pub fn save_composition(&self, doc: &CompositionDto) -> Result<CompositionDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let changed = tx
            .execute(
                "UPDATE compositions SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![doc.title.trim(), now_rfc3339(), doc.id],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(t!("backend.composition.missing", id = doc.id));
        }
        validate_composition(&tx, doc)?;
        tx.execute("DELETE FROM composition_tracks WHERE composition_id = ?1", params![doc.id])
            .map_err(db_err)?;
        for (i, track) in doc.tracks.iter().enumerate() {
            let track_id = id_or_new(&track.id);
            tx.execute(
                "INSERT INTO composition_tracks (id, composition_id, name, program, volume, muted, solo, sustain, \
                 color, order_index) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    track_id,
                    doc.id,
                    track.name.trim(),
                    i64::from(track.program),
                    i64::from(track.volume),
                    i64::from(track.muted),
                    i64::from(track.solo),
                    i64::from(track.sustain),
                    i64::from(track.color),
                    i as i64
                ],
            )
            .map_err(db_err)?;
            for clip in &track.clips {
                tx.execute(
                    "INSERT INTO composition_clips (id, track_id, fragment_id, start_ms, trim_start_ms, length_ms, \
                     repeats, transpose) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        id_or_new(&clip.id),
                        track_id,
                        clip.fragment_id,
                        to_i64(clip.start_ms),
                        to_i64(clip.trim_start_ms),
                        to_i64(clip.length_ms),
                        i64::from(clip.repeats),
                        i64::from(clip.transpose)
                    ],
                )
                .map_err(db_err)?;
            }
        }
        let saved = fetch_composition(&tx, &doc.id)?;
        tx.commit().map_err(db_err)?;
        Ok(self.fix_composition(saved))
    }

    pub fn delete_composition(&self, composition_id: &str) -> Result<(), String> {
        let conn = self.lock()?;
        let changed = conn
            .execute("DELETE FROM compositions WHERE id = ?1", params![composition_id])
            .map_err(db_err)?;
        if changed == 0 {
            return Err(t!("backend.composition.missing", id = composition_id));
        }
        Ok(())
    }

    /// Every fragment of the vault for the composer's library, newest session first.
    pub fn list_library_fragments(&self) -> Result<Vec<LibraryFragmentDto>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT f.id, f.title, f.file_path, f.duration_ms, f.session_id, s.title, s.session_date, \
                 f.piece_id, p.title, f.passage, f.created_at FROM midi_fragments f \
                 JOIN sessions s ON s.id = f.session_id LEFT JOIN pieces p ON p.id = f.piece_id \
                 ORDER BY s.session_date DESC, f.created_at DESC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(LibraryFragmentDto {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    file_path: r.get(2)?,
                    duration_ms: to_u64(r.get(3)?),
                    session_id: r.get(4)?,
                    session_title: r.get(5)?,
                    session_date: r.get(6)?,
                    piece_id: r.get(7)?,
                    piece_title: r.get(8)?,
                    passage: r.get(9)?,
                    created_at: r.get(10)?,
                })
            })
            .map_err(db_err)?;
        let items = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
        Ok(items
            .into_iter()
            .map(|mut f| {
                f.file_path = self.load_path(f.file_path);
                f
            })
            .collect())
    }

    /// Compositions with a clip of one of `fragment_ids` or of a fragment of `session_id`: what
    /// deleting them would change.
    pub fn count_compositions_using(&self, fragment_ids: &[String], session_id: Option<&str>) -> Result<u32, String> {
        let conn = self.lock()?;
        let mut conds: Vec<String> = Vec::new();
        let mut args: Vec<&str> = Vec::new();
        if !fragment_ids.is_empty() {
            conds.push(format!("k.fragment_id IN ({})", vec!["?"; fragment_ids.len()].join(", ")));
            args.extend(fragment_ids.iter().map(String::as_str));
        }
        if let Some(sid) = session_id {
            conds.push("k.fragment_id IN (SELECT id FROM midi_fragments WHERE session_id = ?)".into());
            args.push(sid);
        }
        if conds.is_empty() {
            return Ok(0);
        }
        let sql = format!(
            "SELECT COUNT(DISTINCT t.composition_id) FROM composition_clips k \
             JOIN composition_tracks t ON t.id = k.track_id WHERE {}",
            conds.join(" OR ")
        );
        conn.query_row(&sql, rusqlite::params_from_iter(args), |r| r.get(0)).map(to_u32).map_err(db_err)
    }

    // ----------------------------- Comments -----------------------------

    pub fn add_timeline_comment(&self, fragment_id: &str, timestamp_ms: u64, content: &str) -> Result<TimelineCommentDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let session_id = fragment_session_id(&tx, fragment_id)?;
        let comment = TimelineCommentDto {
            id: uuid::Uuid::new_v4().to_string(),
            fragment_id: fragment_id.to_string(),
            timestamp_ms,
            content: content.to_string(),
            created_at: now_rfc3339(),
        };
        tx.execute(
            "INSERT INTO timeline_comments (id, fragment_id, timestamp_ms, content, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![comment.id, comment.fragment_id, to_i64(timestamp_ms), comment.content, comment.created_at],
        )
        .map_err(db_err)?;
        touch_session(&tx, &session_id)?;
        tx.commit().map_err(db_err)?;
        Ok(comment)
    }

    pub fn delete_timeline_comment(&self, comment_id: &str) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let session_id: Option<String> = tx
            .query_row(
                "SELECT f.session_id FROM timeline_comments c JOIN midi_fragments f ON f.id = c.fragment_id \
                 WHERE c.id = ?1",
                params![comment_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let session_id = session_id.ok_or_else(|| t!("backend.db.commentMissing", id = comment_id))?;
        tx.execute("DELETE FROM timeline_comments WHERE id = ?1", params![comment_id]).map_err(db_err)?;
        touch_session(&tx, &session_id)?;
        tx.commit().map_err(db_err)
    }

    // ----------------------------- Media -----------------------------

    pub fn insert_media(&self, session_id: &str, local_path: &str) -> Result<SessionMediaDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        fetch_session(&tx, session_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO session_media (id, session_id, local_path) VALUES (?1, ?2, ?3)",
            params![id, session_id, self.store_path(local_path)],
        )
        .map_err(db_err)?;
        touch_session(&tx, session_id)?;
        tx.commit().map_err(db_err)?;
        Ok(SessionMediaDto { id, session_id: session_id.to_string(), local_path: local_path.to_string() })
    }

    // ----------------------------- Melodies -----------------------------

    /// Inserts a melody (`file_path` absolute) and returns it.
    pub fn insert_melody(&self, m: &MelodyDto) -> Result<MelodyDto, String> {
        let conn = self.lock()?;
        conn.execute(
            &format!("INSERT INTO melodies ({MELODY_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"),
            params![
                m.id,
                m.title,
                m.source.as_str(),
                m.source_fragment_id,
                self.store_path(&m.file_path),
                i64::from(m.bpm),
                to_i64(m.duration_ms),
                i64::from(m.note_count),
                m.created_at,
                m.updated_at
            ],
        )
        .map_err(db_err)?;
        fetch_melody(&conn, &m.id).map(|m| self.fix_melody(m))
    }

    /// Most recently played (or created) first.
    pub fn list_melodies(&self) -> Result<Vec<MelodySummaryDto>, String> {
        let conn = self.lock()?;
        let cols = MELODY_COLS.split(", ").map(|c| format!("m.{c}")).collect::<Vec<_>>().join(", ");
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {cols}, COUNT(a.id), MAX(CASE WHEN a.completed = 1 THEN a.score END), MAX(a.created_at) \
                 FROM melodies m LEFT JOIN challenge_attempts a ON a.melody_id = m.id \
                 GROUP BY m.id ORDER BY COALESCE(MAX(a.created_at), m.updated_at) DESC"
            ))
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(MelodySummaryDto {
                    melody: map_melody(r)?,
                    attempt_count: to_u32(r.get(10)?),
                    best_score: r.get::<_, Option<i64>>(11)?.map(to_u32),
                    last_attempt_at: r.get(12)?,
                    recent_accuracy: Vec::new(),
                    mastered_tempo_pct: None,
                })
            })
            .map_err(db_err)?;
        let mut list = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;

        let mut stmt = conn
            .prepare(
                "SELECT melody_id, accuracy, tempo_pct FROM challenge_attempts WHERE completed = 1 \
                 ORDER BY created_at ASC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, to_u32(r.get(2)?))))
            .map_err(db_err)?;
        let mut by_melody: std::collections::HashMap<String, Vec<(f64, u32)>> = std::collections::HashMap::new();
        for row in rows {
            let (id, accuracy, tempo) = row.map_err(db_err)?;
            by_melody.entry(id).or_default().push((accuracy, tempo));
        }
        for s in &mut list {
            s.melody.file_path = self.load_path(std::mem::take(&mut s.melody.file_path));
            if let Some(attempts) = by_melody.get(&s.melody.id) {
                let from = attempts.len().saturating_sub(RECENT_ACCURACY);
                s.recent_accuracy = attempts[from..].iter().map(|a| a.0).collect();
                s.mastered_tempo_pct = attempts.iter().filter(|a| a.0 >= MASTERED_ACCURACY).map(|a| a.1).max();
            }
        }
        Ok(list)
    }

    pub fn get_melody(&self, melody_id: &str) -> Result<MelodyDto, String> {
        let conn = self.lock()?;
        fetch_melody(&conn, melody_id).map(|m| self.fix_melody(m))
    }

    pub fn rename_melody(&self, melody_id: &str, title: &str) -> Result<MelodyDto, String> {
        let conn = self.lock()?;
        let changed = conn
            .execute(
                "UPDATE melodies SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![title, now_rfc3339(), melody_id],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(t!("backend.db.melodyMissing", id = melody_id));
        }
        fetch_melody(&conn, melody_id).map(|m| self.fix_melody(m))
    }

    /// Deletes the melody and its attempts; returns the absolute paths of their files.
    pub fn delete_melody(&self, melody_id: &str) -> Result<Vec<String>, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let melody = fetch_melody(&tx, melody_id)?;
        let mut paths = vec![melody.file_path];
        {
            let mut stmt = tx
                .prepare("SELECT played_midi_path FROM challenge_attempts WHERE melody_id = ?1 AND played_midi_path IS NOT NULL")
                .map_err(db_err)?;
            let rows = stmt.query_map(params![melody_id], |r| r.get::<_, String>(0)).map_err(db_err)?;
            paths.extend(rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?);
        }
        tx.execute("DELETE FROM melodies WHERE id = ?1", params![melody_id]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(paths.into_iter().map(|p| self.load_path(p)).collect())
    }

    // ----------------------------- Attempts -----------------------------

    /// Inserts an attempt (`played_midi_path` absolute) and returns it.
    pub fn insert_attempt(&self, a: &AttemptDto) -> Result<AttemptDto, String> {
        let s = &a.summary;
        let details = serde_json::to_string(&a.details).map_err(|e| t!("backend.internal", e = e))?;
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        fetch_melody(&tx, &s.melody_id)?;
        tx.execute(
            &format!(
                "INSERT INTO challenge_attempts ({ATTEMPT_COLS}) VALUES \
                 (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)"
            ),
            params![
                s.id,
                s.melody_id,
                s.created_at,
                i64::from(s.tempo_pct),
                i64::from(s.bpm),
                s.completed as i64,
                i64::from(s.score),
                s.accuracy,
                i64::from(s.hits),
                i64::from(s.perfect),
                i64::from(s.misses),
                i64::from(s.wrong),
                i64::from(s.extra),
                i64::from(s.mean_offset_ms),
                i64::from(s.mean_abs_offset_ms),
                i64::from(s.latency_comp_ms),
                to_i64(s.duration_ms),
                a.played_midi_path.as_deref().map(|p| self.store_path(p)),
                details
            ],
        )
        .map_err(db_err)?;
        let attempt = fetch_attempt(&tx, &s.id)?;
        tx.commit().map_err(db_err)?;
        Ok(self.fix_attempt(attempt))
    }

    /// Newest first.
    pub fn list_attempts(&self, melody_id: &str) -> Result<Vec<AttemptDto>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ATTEMPT_COLS} FROM challenge_attempts WHERE melody_id = ?1 ORDER BY created_at DESC"
            ))
            .map_err(db_err)?;
        let rows = stmt.query_map(params![melody_id], map_attempt).map_err(db_err)?;
        let list = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
        Ok(list.into_iter().map(|a| self.fix_attempt(a)).collect())
    }

    pub fn get_attempt(&self, attempt_id: &str) -> Result<AttemptDto, String> {
        let conn = self.lock()?;
        fetch_attempt(&conn, attempt_id).map(|a| self.fix_attempt(a))
    }

    /// Deletes the attempt and returns the absolute path of its MIDI file, if any.
    pub fn delete_attempt(&self, attempt_id: &str) -> Result<Option<String>, String> {
        let conn = self.lock()?;
        let attempt = fetch_attempt(&conn, attempt_id)?;
        conn.execute("DELETE FROM challenge_attempts WHERE id = ?1", params![attempt_id]).map_err(db_err)?;
        Ok(attempt.played_midi_path.map(|p| self.load_path(p)))
    }

    // ----------------------------- Settings -----------------------------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.lock()?;
        conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .map_err(db_err)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key]).map_err(db_err)?;
        Ok(())
    }

    // ----------------------------- Backups -----------------------------

    /// Consistent copy of the database (`VACUUM INTO` a temporary file + atomic rename).
    pub fn backup_to(&self, dest: &Path) -> Result<(), String> {
        let conn = self.lock()?;
        backup_in(&conn, dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/vault";

    fn db() -> Database {
        Database::open_in_memory(Path::new(ROOT)).unwrap()
    }

    fn stored(db: &Database, sql: &str) -> String {
        db.lock().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn create_and_list_sessions() {
        let db = db();
        let a = db.create_session("Scales", 90).unwrap();
        let b = db.create_session("Chopin", 60).unwrap();
        assert_eq!(a.session_date, today());
        assert_eq!(a.bpm, 90);
        assert!(a.raw_midi_path.is_none());
        assert!(chrono::DateTime::parse_from_rfc3339(&a.updated_at).is_ok());

        db.insert_fragment("f1", &a.id, "Frag", "", "/vault/midi/fragments/f1.mid", 90, 1000).unwrap();
        let list = db.list_sessions().unwrap();
        assert_eq!(list.len(), 2);
        // `a` was updated (fragment) after `b` was created.
        assert_eq!(list[0].id, a.id);
        assert_eq!(list[0].fragment_count, 1);
        assert_eq!(list[1].id, b.id);
        assert_eq!(list[1].fragment_count, 0);

        db.update_session(&b.id, "Chopin op. 28", 72, "# Notes").unwrap();
        let got = db.get_session(&b.id).unwrap();
        assert_eq!(got.title, "Chopin op. 28");
        assert_eq!(got.bpm, 72);
        assert_eq!(got.markdown_notes, "# Notes");
        assert!(db.get_session("nope").is_err());
        assert!(db.update_session("nope", "x", 1, "").is_err());
    }

    #[test]
    fn paths_are_stored_relative_and_returned_absolute() {
        let db = db();
        let s = db.create_session("S", 120).unwrap();
        let updated = db.set_session_raw_midi(&s.id, "/vault/midi/raw/raw.mid", 5000).unwrap();
        assert_eq!(updated.raw_midi_path.as_deref(), Some("/vault/midi/raw/raw.mid"));
        assert_eq!(updated.raw_duration_ms, 5000);
        assert_eq!(stored(&db, "SELECT raw_midi_path FROM sessions"), "midi/raw/raw.mid");

        let f = db.insert_fragment("f1", &s.id, "One", "", "/vault/midi/fragments/f1.mid", 100, 1).unwrap();
        assert_eq!(f.file_path, "/vault/midi/fragments/f1.mid");
        assert_eq!(stored(&db, "SELECT file_path FROM midi_fragments"), "midi/fragments/f1.mid");

        let m = db.insert_media(&s.id, "/vault/media/a.png").unwrap();
        assert_eq!(m.local_path, "/vault/media/a.png");
        assert_eq!(stored(&db, "SELECT local_path FROM session_media"), "media/a.png");

        let d = db.get_session_detail(&s.id).unwrap();
        assert_eq!(d.session.raw_midi_path.as_deref(), Some("/vault/midi/raw/raw.mid"));
        assert_eq!(d.fragments[0].file_path, "/vault/midi/fragments/f1.mid");
        assert_eq!(d.media[0].local_path, "/vault/media/a.png");

        // A path outside the vault is kept as is.
        db.set_session_raw_midi(&s.id, "/other/raw.mid", 1).unwrap();
        assert_eq!(db.get_session(&s.id).unwrap().raw_midi_path.as_deref(), Some("/other/raw.mid"));
    }

    #[test]
    fn fragments_comments_and_cascade_delete() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        db.set_session_raw_midi(&s.id, "/vault/midi/raw/raw.mid", 10_000).unwrap();
        let f1 = db.insert_fragment("f1", &s.id, "One", "exp", "/vault/midi/fragments/f1.mid", 100, 2000).unwrap();
        let f2 = db.insert_fragment("f2", &s.id, "Two", "", "/vault/midi/fragments/f2.mid", 100, 3000).unwrap();
        assert_eq!(f1.order_index, 0);
        assert_eq!(f2.order_index, 1);
        assert!(db.insert_fragment("fx", "nope", "x", "", "/x.mid", 1, 1).is_err());

        let c2 = db.add_timeline_comment("f1", 1500, "late").unwrap();
        let c1 = db.add_timeline_comment("f1", 200, "early").unwrap();
        assert!(db.add_timeline_comment("nope", 1, "x").is_err());
        db.insert_media(&s.id, "/vault/media/img.png").unwrap();

        let detail = db.get_session_detail(&s.id).unwrap();
        assert_eq!(detail.fragments.len(), 2);
        assert_eq!(detail.fragments[0].id, "f1");
        let ts: Vec<u64> = detail.fragments[0].comments.iter().map(|c| c.timestamp_ms).collect();
        assert_eq!(ts, vec![200, 1500]);
        assert_eq!(detail.fragments[0].comments[0].id, c1.id);
        assert_eq!(detail.media.len(), 1);
        assert_eq!(db.get_fragment("f1").unwrap().comments.len(), 2);

        db.update_fragment_meta("f2", "Two bis", "new").unwrap();
        let f2b = db.get_fragment("f2").unwrap();
        assert_eq!((f2b.title.as_str(), f2b.explanation.as_str()), ("Two bis", "new"));

        db.delete_timeline_comment(&c2.id).unwrap();
        assert_eq!(db.get_fragment("f1").unwrap().comments.len(), 1);
        assert!(db.delete_timeline_comment("nope").is_err());

        let mut paths = db.delete_session(&s.id).unwrap();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "/vault/media/img.png",
                "/vault/midi/fragments/f1.mid",
                "/vault/midi/fragments/f2.mid",
                "/vault/midi/raw/raw.mid"
            ]
        );
        assert!(db.get_session(&s.id).is_err());
        assert!(db.get_fragment("f1").is_err());
        let conn = db.lock().unwrap();
        for table in ["midi_fragments", "timeline_comments", "session_media"] {
            let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table} should be empty");
        }
    }

    #[test]
    fn delete_fragment_returns_absolute_path() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        db.insert_fragment("f2", &s.id, "Two", "", "/vault/midi/fragments/f2.mid", 100, 3000).unwrap();
        assert_eq!(db.delete_fragment("f2").unwrap(), "/vault/midi/fragments/f2.mid");
        assert!(db.delete_fragment("f2").is_err());
    }

    #[test]
    fn settings_roundtrip() {
        let db = db();
        assert_eq!(db.get_setting("k").unwrap(), None);
        db.set_setting("k", "v1").unwrap();
        db.set_setting("k", "v2").unwrap();
        assert_eq!(db.get_setting("k").unwrap().as_deref(), Some("v2"));
        db.delete_setting("k").unwrap();
        assert_eq!(db.get_setting("k").unwrap(), None);
        db.delete_setting("k").unwrap();
    }

    /// Creates a v1 database (the Google Drive version) with absolute paths, in WAL mode.
    fn create_v1(path: &Path, old_base: &str) {
        let conn = Connection::open(path).unwrap();
        conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0)).unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch("PRAGMA user_version = 1;").unwrap();
        let md = format!(
            "Hello\n![photo]({old_base}/media/abc_photo.png)\n![other](<{old_base}/media/with space.png>)\n![web](https://x.org/a.png)"
        );
        conn.execute(
            "INSERT INTO sessions (id, title, session_date, bpm, raw_midi_path, raw_duration_ms, markdown_notes, \
             updated_at, sync_status) VALUES ('s1', 'Vieja', '2026-01-01', 90, ?1, 1000, ?2, '2026-01-01T00:00:00Z', 'SYNCED')",
            params![format!("{old_base}/midi/raw/raw_session_s1.mid"), md],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO midi_fragments (id, session_id, title, file_path, bpm, duration_ms, drive_file_id, created_at) \
             VALUES ('f1', 's1', 'Frag', ?1, 90, 500, 'drive-f1', '2026-01-01T00:00:00Z')",
            params![format!("{old_base}/midi/fragments/frag_f1.mid")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_media (id, session_id, local_path, drive_file_id) VALUES ('m1', 's1', ?1, 'drive-m1')",
            params![format!("{old_base}/media/abc_photo.png")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, action, created_at) VALUES ('DB_SNAPSHOT', 'x', 'UPLOAD', 'now')",
            [],
        )
        .unwrap();
        for (k, v) in [("google_refresh_token", "t"), ("drive_file_id:DB_SNAPSHOT", "d"), ("drive_folder_root", "r"), ("other", "v")] {
            conn.execute("INSERT INTO app_settings (key, value) VALUES (?1, ?2)", params![k, v]).unwrap();
        }
    }

    #[test]
    fn migrates_v1_to_relative_paths_without_drive() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("Café vault");
        std::fs::create_dir_all(&vault).unwrap();
        let db_path = vault.join("piano_tracker.sqlite");
        let old_base = "/home/alguien/.local/share/piano-tracker";
        create_v1(&db_path, old_base);

        let db = Database::open(&db_path, &vault).unwrap();
        let v = vault.to_string_lossy();
        let d = db.get_session_detail("s1").unwrap();
        assert_eq!(d.session.raw_midi_path, Some(format!("{v}/midi/raw/raw_session_s1.mid")));
        assert_eq!(d.fragments[0].file_path, format!("{v}/midi/fragments/frag_f1.mid"));
        assert_eq!(d.media[0].local_path, format!("{v}/media/abc_photo.png"));
        assert_eq!(
            d.session.markdown_notes,
            "Hello\n![photo](media/abc_photo.png)\n![other](<media/with space.png>)\n![web](https://x.org/a.png)"
        );
        assert_eq!(stored(&db, "SELECT file_path FROM midi_fragments"), "midi/fragments/frag_f1.mid");

        let conn = db.lock().unwrap();
        let has_queue: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'sync_queue'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(has_queue, 0);
        for (table, col) in [("sessions", "sync_status"), ("midi_fragments", "drive_file_id"), ("session_media", "sync_status")] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{col}'"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table}.{col} should have been removed");
        }
        let keys: Vec<String> = {
            let mut stmt = conn.prepare("SELECT key FROM app_settings").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(keys, vec!["other".to_string()]);
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "delete");
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(conn);
        drop(db);
        assert!(!vault.join("piano_tracker.sqlite-wal").exists());
        assert!(!vault.join("piano_tracker.sqlite-shm").exists());

        // Reopening is idempotent.
        let db = Database::open(&db_path, &vault).unwrap();
        assert_eq!(db.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn file_db_and_backup_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("sub").join("piano_tracker.sqlite");
        {
            let db = Database::open(&db_path, dir.path()).unwrap();
            let s = db.create_session("Persistent", 80).unwrap();
            db.insert_fragment("f1", &s.id, "One", "", "/data/f1.mid", 80, 1000).unwrap();
            let backup = dir.path().join("piano_tracker_backup.sqlite");
            db.backup_to(&backup).unwrap();
            // Second copy over the existing one (atomic rename).
            db.backup_to(&backup).unwrap();
            assert!(!dir.path().join("piano_tracker_backup.sqlite.tmp").exists());

            let copy = Connection::open(&backup).unwrap();
            let title: String = copy.query_row("SELECT title FROM sessions", [], |r| r.get(0)).unwrap();
            assert_eq!(title, "Persistent");
            let n: i64 = copy.query_row("SELECT COUNT(*) FROM midi_fragments", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
            let v: i64 = copy.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(v, SCHEMA_VERSION);
        }
        // Reopening: idempotent migrations and data kept.
        let db = Database::open(&db_path, dir.path()).unwrap();
        assert_eq!(db.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn migration_v3_backfills_practice_log() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("v");
        std::fs::create_dir_all(&vault).unwrap();
        let db_path = vault.join("piano_tracker.sqlite");
        create_v1(&db_path, "/old");

        let db = Database::open(&db_path, &vault).unwrap();
        // Raw take (1000 ms) + fragment (500 ms) on the session's date.
        let days = db.practice_days("2026-01-01", "2026-01-31").unwrap();
        assert_eq!(days, vec![PracticeDayDto { date: "2026-01-01".into(), duration_ms: 1500, sessions: 1 }]);
        let f = db.get_fragment("f1").unwrap();
        assert_eq!((f.piece_id, f.passage.as_str()), (None, ""));
        assert_eq!(db.get_session_detail("s1").unwrap().undo_depth, 0);
        // v4: the composer's tables exist and the old fragments reach its library.
        assert!(db.list_compositions().unwrap().is_empty());
        assert_eq!(db.list_library_fragments().unwrap()[0].id, "f1");
        drop(db);

        // Reopening does not backfill again.
        let db = Database::open(&db_path, &vault).unwrap();
        assert_eq!(db.practice_days("2026-01-01", "2026-01-31").unwrap()[0].duration_ms, 1500);
    }

    #[test]
    fn raw_history_is_a_bounded_stack() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        assert!(db.last_raw_history(&s.id).unwrap().is_none());
        assert!(db.push_raw_history("nope", "/vault/midi/history/x.mid", 1, "discard", None).is_err());

        let mut pruned = Vec::new();
        for i in 0..(RAW_HISTORY_LIMIT + 2) {
            let path = format!("/vault/midi/history/{}/{i}.mid", s.id);
            pruned.extend(db.push_raw_history(&s.id, &path, i as u64 * 100, "discard", None).unwrap());
        }
        // The two oldest were pruned.
        assert_eq!(
            pruned,
            vec![format!("/vault/midi/history/{}/0.mid", s.id), format!("/vault/midi/history/{}/1.mid", s.id)]
        );
        assert_eq!(db.get_session_detail(&s.id).unwrap().undo_depth, RAW_HISTORY_LIMIT as u32);
        assert!(stored(&db, "SELECT file_path FROM raw_history LIMIT 1").starts_with("midi/history/"));

        let last = db.last_raw_history(&s.id).unwrap().unwrap();
        assert_eq!(last.file_path, format!("/vault/midi/history/{}/{}.mid", s.id, RAW_HISTORY_LIMIT + 1));
        assert_eq!(last.duration_ms, (RAW_HISTORY_LIMIT as u64 + 1) * 100);
        db.delete_raw_history(&last.id).unwrap();
        let next = db.last_raw_history(&s.id).unwrap().unwrap();
        assert_eq!(next.duration_ms, RAW_HISTORY_LIMIT as u64 * 100);

        db.push_raw_history(&s.id, "/vault/midi/history/e.mid", 5, "extract", Some("f9")).unwrap();
        let e = db.last_raw_history(&s.id).unwrap().unwrap();
        assert_eq!((e.action.as_str(), e.fragment_id.as_deref()), ("extract", Some("f9")));
        assert_eq!(db.get_session_detail(&s.id).unwrap().undo_fragment_id.as_deref(), Some("f9"));

        // Deleting the session also hands back the snapshots.
        let paths = db.delete_session(&s.id).unwrap();
        assert_eq!(paths.iter().filter(|p| p.contains("/midi/history/")).count(), RAW_HISTORY_LIMIT);
        let n: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM raw_history", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn practice_log_groups_by_day() {
        let db = db();
        let a = db.create_session("A", 100).unwrap();
        let b = db.create_session("B", 100).unwrap();
        db.add_practice_entry(&a.id, 60_000).unwrap();
        db.add_practice_entry(&a.id, 30_000).unwrap();
        db.add_practice_entry(&b.id, 10_000).unwrap();
        db.add_practice_entry(&b.id, 0).unwrap();
        let days = db.practice_days(&today(), &today()).unwrap();
        assert_eq!(days, vec![PracticeDayDto { date: today(), duration_ms: 100_000, sessions: 2 }]);
        assert!(db.practice_days("2000-01-01", "2000-12-31").unwrap().is_empty());

        // Practice survives deleting the session.
        db.delete_session(&a.id).unwrap();
        assert_eq!(db.practice_days(&today(), &today()).unwrap()[0].duration_ms, 100_000);
    }

    #[test]
    fn pieces_group_fragments_across_sessions() {
        let db = db();
        let s1 = db.create_session("Monday", 100).unwrap();
        let s2 = db.create_session("Tuesday", 100).unwrap();
        db.insert_fragment("a", &s1.id, "A", "", "/vault/midi/fragments/a.mid", 100, 1000).unwrap();
        db.insert_fragment("b", &s2.id, "B", "", "/vault/midi/fragments/b.mid", 100, 2000).unwrap();
        db.insert_fragment("c", &s2.id, "C", "", "/vault/midi/fragments/c.mid", 100, 3000).unwrap();
        db.add_timeline_comment("b", 10, "rushed").unwrap();

        let nocturne = db.create_piece("Nocturne op. 9 no. 2", "Chopin").unwrap();
        let scales = db.create_piece("Scales", "").unwrap();
        assert!(db.set_fragment_piece("a", Some("nope"), "").is_err());
        assert!(db.set_fragment_piece("nope", Some(&nocturne.id), "").is_err());
        let a = db.set_fragment_piece("a", Some(&nocturne.id), "  bars 1-4 ").unwrap();
        assert_eq!((a.piece_id.as_deref(), a.passage.as_str()), (Some(nocturne.id.as_str()), "bars 1-4"));
        db.set_fragment_piece("b", Some(&nocturne.id), "bars 1-4").unwrap();
        db.set_fragment_piece("c", Some(&nocturne.id), "").unwrap();

        let detail = db.get_piece_detail(&nocturne.id).unwrap();
        let ids: Vec<&str> = detail.takes.iter().map(|t| t.fragment.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
        assert_eq!(detail.takes[1].session_title, "Monday");
        assert_eq!(detail.takes[2].fragment.comments.len(), 1);
        assert_eq!(detail.takes[2].fragment.file_path, "/vault/midi/fragments/b.mid");

        let list = db.list_pieces().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].piece.id.as_str(), list[0].take_count), (nocturne.id.as_str(), 3));
        assert_eq!(list[0].last_practiced.as_deref(), Some(today().as_str()));
        assert_eq!(list[0].passages, vec!["bars 1-4".to_string()]);
        assert_eq!((list[1].take_count, list[1].last_practiced.as_deref()), (0, None));

        let archived = db.update_piece(&nocturne.id, "Nocturne", "F. Chopin", "Rubato!", true).unwrap();
        assert!(archived.archived);
        assert_eq!(db.list_pieces().unwrap()[0].piece.id, scales.id);
        assert!(db.update_piece("nope", "x", "", "", false).is_err());

        // Deleting the piece keeps its fragments, without a piece.
        db.delete_piece(&nocturne.id).unwrap();
        assert!(db.delete_piece(&nocturne.id).is_err());
        let a = db.get_fragment("a").unwrap();
        assert_eq!(a.piece_id, None);
        assert_eq!(a.passage, "bars 1-4");
        // Taking a fragment out of a piece.
        db.set_fragment_piece("b", Some(&scales.id), "").unwrap();
        assert_eq!(db.set_fragment_piece("b", None, "").unwrap().piece_id, None);
    }

    fn clip(fragment_id: &str, start_ms: u64, length_ms: u64) -> CompositionClipDto {
        CompositionClipDto {
            id: String::new(),
            fragment_id: fragment_id.into(),
            start_ms,
            trim_start_ms: 0,
            length_ms,
            repeats: 1,
            transpose: 0,
            fragment_title: String::new(),
            fragment_file_path: String::new(),
            fragment_duration_ms: 0,
        }
    }

    /// A session with fragments `a` (10 s) and `b` (4 s), and a composition with one empty track.
    fn composition_fixture() -> (Database, SessionDto, CompositionDto) {
        let db = db();
        let s = db.create_session("Monday", 100).unwrap();
        db.insert_fragment("a", &s.id, "Theme A", "", "/vault/midi/fragments/a.mid", 100, 10_000).unwrap();
        db.insert_fragment("b", &s.id, "Bass", "", "/vault/midi/fragments/b.mid", 100, 4_000).unwrap();
        let c = db.create_composition("Arrangement", "Track 1").unwrap();
        (db, s, c)
    }

    #[test]
    fn compositions_save_and_reload_tracks_and_clips() {
        let (db, _, mut doc) = composition_fixture();
        assert_eq!(doc.tracks.len(), 1);
        let t = &doc.tracks[0];
        assert_eq!((t.name.as_str(), t.program, t.volume, t.sustain, t.muted), ("Track 1", 0, 100, true, false));

        doc.title = "  Nocturne arrangement ".into();
        doc.tracks[0].clips = vec![clip("a", 0, 8_000), CompositionClipDto { trim_start_ms: 1_000, ..clip("a", 8_000, 9_000) }];
        doc.tracks.push(CompositionTrackDto {
            id: String::new(),
            name: "Bass".into(),
            program: 32,
            volume: 90,
            muted: true,
            solo: false,
            sustain: false,
            color: 2,
            clips: vec![CompositionClipDto { repeats: 4, transpose: -12, ..clip("b", 0, 4_000) }],
        });
        let saved = db.save_composition(&doc).unwrap();
        assert_eq!(saved.title, "Nocturne arrangement");
        assert_eq!(saved.tracks.len(), 2);
        assert_eq!(saved.tracks[0].id, doc.tracks[0].id, "existing ids are kept");
        assert!(!saved.tracks[1].id.is_empty());
        let a2 = &saved.tracks[0].clips[1];
        assert_eq!((a2.start_ms, a2.trim_start_ms, a2.length_ms), (8_000, 1_000, 9_000));
        assert_eq!(a2.fragment_title, "Theme A");
        assert_eq!(a2.fragment_file_path, "/vault/midi/fragments/a.mid");
        assert_eq!(a2.fragment_duration_ms, 10_000);
        let bass = &saved.tracks[1];
        assert_eq!((bass.program, bass.volume, bass.muted, bass.sustain, bass.color), (32, 90, true, false, 2));
        assert_eq!((bass.clips[0].repeats, bass.clips[0].transpose), (4, -12));
        assert_eq!(db.get_composition(&doc.id).unwrap(), saved);

        let list = db.list_compositions().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].track_count, list[0].clip_count, list[0].duration_ms), (2, 3, 17_000));

        // Reordering tracks.
        let mut reordered = saved.clone();
        reordered.tracks.reverse();
        let r = db.save_composition(&reordered).unwrap();
        assert_eq!(r.tracks[0].name, "Bass");

        db.delete_composition(&doc.id).unwrap();
        assert!(db.get_composition(&doc.id).is_err());
        assert!(db.delete_composition(&doc.id).is_err());
        let n: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM composition_clips", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn compositions_reject_invalid_documents() {
        let (db, _, doc) = composition_fixture();
        let with = |clips: Vec<CompositionClipDto>| {
            let mut d = doc.clone();
            d.tracks[0].clips = clips;
            d
        };
        // Overlap on the same track; touching is fine.
        assert!(db.save_composition(&with(vec![clip("a", 0, 5_000), clip("b", 4_999, 1_000)])).is_err());
        assert!(db.save_composition(&with(vec![clip("a", 0, 5_000), clip("b", 5_000, 1_000)])).is_ok());
        // Repeats count towards the clip's end.
        let repeated = CompositionClipDto { repeats: 2, ..clip("b", 0, 4_000) };
        assert!(db.save_composition(&with(vec![repeated, clip("a", 7_000, 1_000)])).is_err());
        // The window must stay inside the fragment.
        assert!(db.save_composition(&with(vec![CompositionClipDto { trim_start_ms: 1, ..clip("b", 0, 4_000) }])).is_err());
        assert!(db.save_composition(&with(vec![clip("b", 0, 0)])).is_err());
        assert!(db.save_composition(&with(vec![CompositionClipDto { repeats: 0, ..clip("b", 0, 1_000) }])).is_err());
        assert!(db.save_composition(&with(vec![CompositionClipDto { repeats: 17, ..clip("b", 0, 1_000) }])).is_err());
        assert!(db.save_composition(&with(vec![CompositionClipDto { transpose: 25, ..clip("b", 0, 1_000) }])).is_err());
        assert!(db.save_composition(&with(vec![clip("nope", 0, 1_000)])).is_err());

        let mut bad = doc.clone();
        bad.tracks[0].program = 128;
        assert!(db.save_composition(&bad).is_err());
        let mut many = doc.clone();
        many.tracks = (0..=COMPOSITION_MAX_TRACKS)
            .map(|i| CompositionTrackDto { id: String::new(), name: format!("T{i}"), ..doc.tracks[0].clone() })
            .collect();
        assert!(db.save_composition(&many).is_err());
        let mut missing = doc.clone();
        missing.id = "nope".into();
        assert!(db.save_composition(&missing).is_err());

        // A rejected save leaves the composition as it was.
        assert_eq!(db.get_composition(&doc.id).unwrap().tracks[0].clips.len(), 2);
    }

    #[test]
    fn deleting_a_fragment_or_its_session_removes_its_clips() {
        let (db, s, mut doc) = composition_fixture();
        doc.tracks[0].clips = vec![clip("a", 0, 5_000), clip("b", 6_000, 4_000)];
        db.save_composition(&doc).unwrap();
        let other = db.create_composition("Other", "Track 1").unwrap();
        let mut other_doc = other.clone();
        other_doc.tracks[0].clips = vec![clip("b", 0, 4_000)];
        db.save_composition(&other_doc).unwrap();

        assert_eq!(db.count_compositions_using(&["a".into()], None).unwrap(), 1);
        assert_eq!(db.count_compositions_using(&["b".into()], None).unwrap(), 2);
        assert_eq!(db.count_compositions_using(&[], Some(&s.id)).unwrap(), 2);
        assert_eq!(db.count_compositions_using(&["zzz".into()], None).unwrap(), 0);
        assert_eq!(db.count_compositions_using(&[], None).unwrap(), 0);

        db.delete_fragment("b").unwrap();
        let ids: Vec<String> = db.get_composition(&doc.id).unwrap().tracks[0].clips.iter().map(|c| c.fragment_id.clone()).collect();
        assert_eq!(ids, vec!["a".to_string()]);
        assert!(db.get_composition(&other.id).unwrap().tracks[0].clips.is_empty());

        db.delete_session(&s.id).unwrap();
        let after = db.get_composition(&doc.id).unwrap();
        assert_eq!(after.tracks.len(), 1, "tracks stay, only clips go");
        assert!(after.tracks[0].clips.is_empty());
    }

    #[test]
    fn library_lists_every_fragment_with_its_piece() {
        let (db, s, _) = composition_fixture();
        let piece = db.create_piece("Nocturne", "Chopin").unwrap();
        db.set_fragment_piece("a", Some(&piece.id), "Theme A").unwrap();
        let lib = db.list_library_fragments().unwrap();
        assert_eq!(lib.len(), 2);
        let a = lib.iter().find(|f| f.id == "a").unwrap();
        assert_eq!(a.piece_title.as_deref(), Some("Nocturne"));
        assert_eq!((a.passage.as_str(), a.session_title.as_str()), ("Theme A", "Monday"));
        assert_eq!((a.file_path.as_str(), a.duration_ms), ("/vault/midi/fragments/a.mid", 10_000));
        assert_eq!(a.session_id, s.id);
        let b = lib.iter().find(|f| f.id == "b").unwrap();
        assert_eq!(b.piece_title, None);
    }

    fn melody(id: &str) -> MelodyDto {
        MelodyDto {
            id: id.into(),
            title: "Nocturne".into(),
            source: MelodySource::Fragment,
            source_fragment_id: Some("f1".into()),
            file_path: format!("/vault/midi/melodies/melody_{id}.mid"),
            bpm: 90,
            duration_ms: 8000,
            note_count: 4,
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
        }
    }

    fn attempt(id: &str, melody_id: &str, created_at: &str, score: u32, completed: bool) -> AttemptDto {
        use crate::models::{NoteOutcome, NoteStatus};
        AttemptDto {
            summary: AttemptSummaryDto {
                id: id.into(),
                melody_id: melody_id.into(),
                created_at: created_at.into(),
                tempo_pct: 80,
                bpm: 72,
                completed,
                score,
                accuracy: 0.75,
                hits: 3,
                perfect: 2,
                misses: 1,
                wrong: 1,
                extra: 0,
                mean_offset_ms: -12,
                mean_abs_offset_ms: 30,
                latency_comp_ms: 15,
                duration_ms: 10_000,
            },
            played_midi_path: Some(format!("/vault/midi/attempts/attempt_{id}.mid")),
            details: AttemptDetails {
                notes: vec![NoteOutcome { status: NoteStatus::Perfect, offset_ms: Some(-5) }, NoteOutcome { status: NoteStatus::Missed, offset_ms: None }],
                errors: Vec::new(),
            },
        }
    }

    #[test]
    fn melodies_and_attempts() {
        let db = db();
        let m = db.insert_melody(&melody("m1")).unwrap();
        assert_eq!(m.file_path, "/vault/midi/melodies/melody_m1.mid");
        assert_eq!(stored(&db, "SELECT file_path FROM melodies"), "midi/melodies/melody_m1.mid");
        db.insert_melody(&melody("m2")).unwrap();

        let list = db.list_melodies().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|s| s.attempt_count == 0 && s.best_score.is_none()));

        let a = db.insert_attempt(&attempt("a1", "m1", "2099-10-01T10:00:00.000Z", 700, true)).unwrap();
        assert_eq!(a.played_midi_path.as_deref(), Some("/vault/midi/attempts/attempt_a1.mid"));
        assert_eq!(stored(&db, "SELECT played_midi_path FROM challenge_attempts"), "midi/attempts/attempt_a1.mid");
        assert_eq!(a, attempt("a1", "m1", "2099-10-01T10:00:00.000Z", 700, true));
        // An incomplete attempt never is the best one.
        db.insert_attempt(&attempt("a2", "m1", "2099-10-02T10:00:00.000Z", 900, false)).unwrap();
        assert!(db.insert_attempt(&attempt("a3", "nope", "2099-10-02T10:00:00.000Z", 1, true)).is_err());

        let list = db.list_melodies().unwrap();
        assert_eq!(list[0].melody.id, "m1"); // most recently played first
        assert_eq!(list[0].attempt_count, 2);
        assert_eq!(list[0].best_score, Some(700));
        assert_eq!(list[0].recent_accuracy, vec![0.75]);
        assert_eq!(list[0].mastered_tempo_pct, None);
        assert_eq!(list[0].melody.file_path, "/vault/midi/melodies/melody_m1.mid");
        assert_eq!(list[0].last_attempt_at.as_deref(), Some("2099-10-02T10:00:00.000Z"));

        let attempts = db.list_attempts("m1").unwrap();
        assert_eq!(attempts.iter().map(|a| a.summary.id.as_str()).collect::<Vec<_>>(), vec!["a2", "a1"]);
        assert!(!attempts[0].summary.completed);

        assert_eq!(db.rename_melody("m1", "Nocturne op. 9").unwrap().title, "Nocturne op. 9");
        assert!(db.rename_melody("nope", "x").is_err());

        assert_eq!(db.delete_attempt("a2").unwrap().as_deref(), Some("/vault/midi/attempts/attempt_a2.mid"));
        assert!(db.get_attempt("a2").is_err());

        let paths = db.delete_melody("m1").unwrap();
        assert_eq!(paths, vec!["/vault/midi/melodies/melody_m1.mid", "/vault/midi/attempts/attempt_a1.mid"]);
        assert!(db.get_attempt("a1").is_err()); // cascade
        assert!(db.get_melody("m1").is_err());
        assert_eq!(db.list_melodies().unwrap().len(), 1);
    }

    #[test]
    fn migrates_a_v4_vault_to_v5_keeping_its_data() {
        // A vault last opened by the composer (v4): the challenge tables do not exist yet.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(crate::paths::DB_FILE_NAME);
        let session_id = {
            let db = Database::open(&path, dir.path()).unwrap();
            let s = db.create_session("Before v5", 72).unwrap();
            let conn = db.lock().unwrap();
            conn.execute_batch(
                "DROP TABLE challenge_attempts; DROP TABLE melodies; PRAGMA user_version = 4;",
            )
            .unwrap();
            s.id
        };
        let db = Database::open(&path, dir.path()).unwrap();
        let v: i64 = db.lock().unwrap().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 5);
        assert_eq!(db.get_session(&session_id).unwrap().title, "Before v5");
        assert!(db.list_melodies().unwrap().is_empty());
        db.insert_melody(&melody("m1")).unwrap();
        // Reopening is idempotent.
        drop(db);
        assert_eq!(Database::open(&path, dir.path()).unwrap().list_melodies().unwrap().len(), 1);
    }

    #[test]
    fn database_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Database>();
    }
}
