//! DTOs shared between the Rust modules and the Angular frontend.
//!
//! IPC contract: every field is serialized in `snake_case` (no renaming) and must match
//! `src/app/core/models.ts` exactly.
//! Plain Tauri command arguments are sent from JS in camelCase
//! (`invoke('start_recording', { sessionId, portId, ... })`), the Tauri v2 convention.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MidiPortInfo {
    /// Stable identifier for `start_recording` (`"simulator"` for the built-in simulator).
    pub id: String,
    pub name: String,
    pub is_virtual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionDto {
    pub id: String,
    pub title: String,
    /// ISO date `YYYY-MM-DD`.
    pub session_date: String,
    pub bpm: u32,
    pub raw_midi_path: Option<String>,
    pub raw_duration_ms: u64,
    pub markdown_notes: String,
    /// RFC 3339.
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionSummaryDto {
    pub id: String,
    pub title: String,
    pub session_date: String,
    pub bpm: u32,
    pub raw_duration_ms: u64,
    pub fragment_count: u32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimelineCommentDto {
    pub id: String,
    pub fragment_id: String,
    pub timestamp_ms: u64,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FragmentDto {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub explanation: String,
    pub file_path: String,
    pub bpm: u32,
    pub duration_ms: u64,
    pub order_index: i64,
    pub created_at: String,
    /// Piece of the repertoire this take belongs to (if any).
    pub piece_id: Option<String>,
    /// Passage of the piece (free text, e.g. "bars 1-16"); empty = the whole piece.
    pub passage: String,
    /// Sorted by ascending `timestamp_ms`.
    pub comments: Vec<TimelineCommentDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionMediaDto {
    pub id: String,
    pub session_id: String,
    /// Absolute path (stored relative to the vault in the database).
    pub local_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionDetailDto {
    pub session: SessionDto,
    /// Sorted by `order_index` and then `created_at`.
    pub fragments: Vec<FragmentDto>,
    pub media: Vec<SessionMediaDto>,
    /// Number of raw-take trims that can be undone.
    pub undo_depth: u32,
    /// Fragment that the next undo would delete (it was extracted by the newest trim).
    pub undo_fragment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActivityBlock {
    pub start_ms: u64,
    pub end_ms: u64,
    pub note_count: u32,
    /// Average velocity of the block's NoteOns (0.0 if there are no notes).
    pub velocity_avg: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MidiActivityDto {
    pub file_path: String,
    pub duration_ms: u64,
    pub blocks: Vec<ActivityBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExtractFragmentReq {
    pub session_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub title: String,
    pub explanation: String,
    /// Piece to file the new fragment under.
    #[serde(default)]
    pub piece_id: Option<String>,
    #[serde(default)]
    pub passage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FragmentCreatedResponse {
    pub fragment: FragmentDto,
    /// Session after the destructive slice (new `raw_duration_ms`).
    pub session: SessionDto,
}

/// Result of undoing the last trim of a raw take.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UndoTrimResult {
    /// Session with the restored raw take.
    pub session: SessionDto,
    /// Fragment deleted because the undone trim had extracted it.
    pub removed_fragment_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimeRangeDto {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// One note of a piano roll.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteSpan {
    pub start_ms: u64,
    pub end_ms: u64,
    pub key: u8,
    pub velocity: u8,
}

/// Notes and sustain pedal of a `.mid` file, for the piano roll.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MidiNotesDto {
    pub file_path: String,
    pub duration_ms: u64,
    /// Lowest and highest key played (21 and 108, an 88-key piano, if there are no notes).
    pub min_key: u8,
    pub max_key: u8,
    /// Sorted by `start_ms`.
    pub notes: Vec<NoteSpan>,
    /// Intervals with the sustain pedal (CC64 >= 64) down.
    pub pedal: Vec<TimeRangeDto>,
}

/// Time played on one day (local date).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PracticeDayDto {
    /// ISO date `YYYY-MM-DD`.
    pub date: String,
    pub duration_ms: u64,
    /// Distinct sessions recorded that day.
    pub sessions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PracticeStatsDto {
    /// Only the days with practice, sorted by date.
    pub days: Vec<PracticeDayDto>,
    /// Weekly goal in minutes (0 = no goal).
    pub weekly_goal_minutes: u32,
}

/// A piece of the repertoire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PieceDto {
    pub id: String,
    pub title: String,
    pub composer: String,
    pub notes: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PieceSummaryDto {
    pub piece: PieceDto,
    pub take_count: u32,
    /// Date (`YYYY-MM-DD`) of the most recent session with a take of the piece.
    pub last_practiced: Option<String>,
    /// Passages already used in the piece's takes (sorted, without the empty one).
    pub passages: Vec<String>,
}

/// A fragment filed under a piece, with the session it comes from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PieceTakeDto {
    pub fragment: FragmentDto,
    pub session_title: String,
    pub session_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PieceDetailDto {
    pub piece: PieceDto,
    /// Sorted by passage and then chronologically.
    pub takes: Vec<PieceTakeDto>,
}

/// A composition in the list of the composer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositionSummaryDto {
    pub id: String,
    pub title: String,
    pub track_count: u32,
    pub clip_count: u32,
    /// End of the last clip (repeats included).
    pub duration_ms: u64,
    pub updated_at: String,
}

/// A clip: a window of a fragment placed on a track. The fragment's MIDI is never copied.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositionClipDto {
    pub id: String,
    pub fragment_id: String,
    /// Position on the composition's timeline.
    pub start_ms: u64,
    /// Start of the window inside the fragment.
    pub trim_start_ms: u64,
    /// Length of one repetition of the window.
    pub length_ms: u64,
    /// Times the window is played back to back (1 = once).
    pub repeats: u32,
    /// Semitones.
    pub transpose: i32,
    /// Read only: filled in from the fragment when loading, ignored when saving.
    pub fragment_title: String,
    pub fragment_file_path: String,
    pub fragment_duration_ms: u64,
}

/// A track: one MIDI channel with a General MIDI instrument. The vector order is the track order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositionTrackDto {
    pub id: String,
    pub name: String,
    /// General MIDI program (0-127).
    pub program: u8,
    /// MIDI channel volume (0-127).
    pub volume: u8,
    pub muted: bool,
    pub solo: bool,
    /// Whether the recorded sustain pedal (CC64) is played.
    pub sustain: bool,
    /// Index into the frontend's track palette.
    pub color: u8,
    /// Sorted by `start_ms`.
    pub clips: Vec<CompositionClipDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompositionDto {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub tracks: Vec<CompositionTrackDto>,
}

/// Mixer state of a track, applied live while a composition plays.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct TrackMixDto {
    pub volume: u8,
    pub muted: bool,
    pub solo: bool,
}

/// A fragment as the composer's library shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LibraryFragmentDto {
    pub id: String,
    pub title: String,
    pub file_path: String,
    pub duration_ms: u64,
    pub session_id: String,
    pub session_title: String,
    pub session_date: String,
    pub piece_id: Option<String>,
    pub piece_title: Option<String>,
    pub passage: String,
    pub created_at: String,
}

/// Payload of the Tauri `playback-progress` event (emitted every 50 ms during playback).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaybackProgress {
    pub file_path: String,
    pub current_ms: u64,
    pub duration_ms: u64,
    pub is_playing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SoundfontCandidate {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    /// The synthetic piano generated by the app (last resort).
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SoundfontInfo {
    /// Active SoundFont (or the one loading in the background).
    pub current_path: String,
    /// `true` while the SoundFont is loading in the background.
    pub loading: bool,
    pub candidates: Vec<SoundfontCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentVault {
    pub path: String,
    /// Folder name.
    pub name: String,
    /// The folder exists and is still a vault.
    pub available: bool,
}

/// Vault state: the open one (if any), the recent ones and warnings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultInfo {
    /// Root of the open vault (absolute path), or `None` if there is none.
    pub current: Option<String>,
    /// Folder name of the open vault.
    pub name: Option<String>,
    /// Most recent first; includes the open one.
    pub recent: Vec<RecentVault>,
    /// Folder with data from the previous version (without vaults) that can be imported.
    pub legacy_data_path: Option<String>,
    /// Warnings about the open vault (e.g. conflicting copies created by Dropbox).
    pub warnings: Vec<String>,
}

/// UI language.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LanguageInfo {
    /// Chosen by the user; `None` = automatic (the system language).
    pub preference: Option<String>,
    /// Language in use.
    pub effective: String,
    /// Language detected on the system (or the fallback if it is not available).
    pub system: String,
}

/// What the "About" tab shows. It comes from `Cargo.toml`, the same source as the `.deb` metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    /// Author names, without the email address.
    pub authors: Vec<String>,
    /// SPDX identifier (`"MIT"`).
    pub license: String,
    pub homepage: String,
    pub repository: String,
    pub tauri_version: String,
}

/// Links the "About" tab and the SoundFont settings can open. The webview never sends a URL: the backend builds it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppLink {
    Homepage,
    Repository,
    License,
    GmSoundfont,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultOpenResult {
    pub info: VaultInfo,
    /// `false` if it was not opened because it seems open on another computer (see `lock_warning`).
    pub opened: bool,
    /// Message asking for confirmation before opening with `force = true`.
    pub lock_warning: Option<String>,
}

// ---------------------------------------------------------------------------
// Challenge mode
// ---------------------------------------------------------------------------

/// Where a melody came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MelodySource {
    Fragment,
    Import,
    /// One of the melodies bundled with the app (`starter_melodies`).
    Starter,
}

impl MelodySource {
    pub fn as_str(self) -> &'static str {
        match self {
            MelodySource::Fragment => "fragment",
            MelodySource::Import => "import",
            MelodySource::Starter => "starter",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "fragment" => MelodySource::Fragment,
            "starter" => MelodySource::Starter,
            _ => MelodySource::Import,
        }
    }
}

/// A reference melody for the challenge mode: a frozen copy of a fragment or of an imported file,
/// or one of the starter melodies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MelodyDto {
    pub id: String,
    pub title: String,
    pub source: MelodySource,
    /// Fragment it was copied from (informative: it may no longer exist).
    pub source_fragment_id: Option<String>,
    /// Absolute path (stored relative to the vault in the database).
    pub file_path: String,
    /// Original tempo: the one at 100 %.
    pub bpm: u32,
    pub duration_ms: u64,
    pub note_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MelodySummaryDto {
    pub melody: MelodyDto,
    pub attempt_count: u32,
    /// Best score among the completed attempts (at any tempo).
    pub best_score: Option<u32>,
    pub last_attempt_at: Option<String>,
    /// Accuracy (0.0-1.0) of the last completed attempts, oldest first (at most 12).
    pub recent_accuracy: Vec<f64>,
    /// Highest tempo with a completed attempt of at least 90 % accuracy.
    pub mastered_tempo_pct: Option<u32>,
}

/// A note of a melody, in its original time with the leading silence trimmed (the first note
/// starts at 0). Its index in `MelodyDetailDto.notes` is the one `AttemptDetails.notes` uses.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteDto {
    pub key: u8,
    pub start_ms: u64,
    pub end_ms: u64,
    pub velocity: u8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoteStatus {
    Perfect,
    Good,
    Missed,
}

/// Result of one expected note in an attempt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteOutcome {
    pub status: NoteStatus,
    /// Played time minus expected time (negative = early); `None` if missed.
    pub offset_ms: Option<i32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlayedErrorKind {
    /// Another expected note was due at that moment.
    Wrong,
    /// Nothing was due at that moment.
    Extra,
}

/// A played note that matched nothing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlayedError {
    /// In the attempt's timeline (already scaled by the tempo), relative to the first note.
    pub time_ms: i64,
    pub kind: PlayedErrorKind,
    pub played_key: u8,
    /// The closest note that was due (only for `Wrong`).
    pub expected_key: Option<u8>,
}

/// Per-note detail of an attempt (`details_json` in the database).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AttemptDetails {
    /// One per note of the melody, in the same order as `MelodyDetailDto.notes`.
    pub notes: Vec<NoteOutcome>,
    /// Sorted by time.
    pub errors: Vec<PlayedError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptSummaryDto {
    pub id: String,
    pub melody_id: String,
    pub created_at: String,
    pub tempo_pct: u32,
    /// Effective BPM (`melody.bpm · tempo_pct / 100`).
    pub bpm: u32,
    /// `false` if it was stopped before the end: it does not count for records or charts.
    pub completed: bool,
    /// 0-1000.
    pub score: u32,
    /// Fraction of notes hit, 0.0-1.0.
    pub accuracy: f64,
    pub hits: u32,
    pub perfect: u32,
    pub misses: u32,
    pub wrong: u32,
    pub extra: u32,
    pub mean_offset_ms: i32,
    pub mean_abs_offset_ms: u32,
    pub latency_comp_ms: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptDto {
    pub summary: AttemptSummaryDto,
    /// Absolute path of what was played.
    pub played_midi_path: Option<String>,
    pub details: AttemptDetails,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MelodyDetailDto {
    pub melody: MelodyDto,
    pub notes: Vec<NoteDto>,
    /// Newest first, with their details (for the ghost, the history and the statistics).
    pub attempts: Vec<AttemptDto>,
}

/// Returned by `start_challenge`: what the frontend needs to run its clock and draw the roll.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChallengeStarted {
    pub melody_id: String,
    pub tempo_pct: u32,
    /// Effective BPM (count-in and metronome).
    pub bpm: u32,
    /// The first note is due this long after the start.
    pub count_in_ms: u64,
    /// Output latency subtracted from the played times.
    pub latency_comp_ms: u32,
    /// Half-width of the hit window.
    pub window_ms: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeNoteKind {
    Perfect,
    Good,
    Wrong,
    Extra,
}

/// Payload of the `challenge-note` event: a played note, already classified.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChallengeNoteEvent {
    /// In the attempt's timeline (the first note is due at 0).
    pub time_ms: i64,
    pub key: u8,
    pub kind: ChallengeNoteKind,
    /// Index of the note it hit (`Perfect` / `Good`).
    pub expected_index: Option<u32>,
    pub offset_ms: Option<i32>,
}

/// Payload of the `challenge-progress` event (every 50 ms while a challenge runs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChallengeProgress {
    /// In the attempt's timeline: negative during the count-in.
    pub elapsed_ms: i64,
    pub hits: u32,
    pub misses: u32,
    pub errors: u32,
    /// Notes missed since the previous event.
    pub missed: Vec<u32>,
}

/// Payload of the `challenge-finished` event, sent when an attempt ends on its own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChallengeFinished {
    pub attempt: Option<AttemptDto>,
    /// Why it could not be saved, if that failed.
    pub error: Option<String>,
}
