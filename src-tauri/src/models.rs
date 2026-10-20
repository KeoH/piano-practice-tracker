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
    /// Lowest and highest key played (0 and 127 if there are no notes).
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

/// Links the "About" tab can open. The webview never sends a URL: the backend builds it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppLink {
    Homepage,
    Repository,
    License,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultOpenResult {
    pub info: VaultInfo,
    /// `false` if it was not opened because it seems open on another computer (see `lock_warning`).
    pub opened: bool,
    /// Message asking for confirmation before opening with `force = true`.
    pub lock_warning: Option<String>,
}
