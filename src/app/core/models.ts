// IPC contract: exact mirror of `src-tauri/src/models.rs` (fields in snake_case).
// `invoke` arguments are in camelCase (Tauri v2 convention), e.g.
// invoke('start_recording', { sessionId, portId, bpm, metronomeOn, liveSynthOn }).

export interface MidiPortInfo {
  id: string;
  name: string;
  is_virtual: boolean;
}

export interface SessionDto {
  id: string;
  title: string;
  session_date: string;
  bpm: number;
  raw_midi_path: string | null;
  raw_duration_ms: number;
  markdown_notes: string;
  updated_at: string;
}

export interface SessionSummaryDto {
  id: string;
  title: string;
  session_date: string;
  bpm: number;
  raw_duration_ms: number;
  fragment_count: number;
  updated_at: string;
}

export interface TimelineCommentDto {
  id: string;
  fragment_id: string;
  timestamp_ms: number;
  content: string;
  created_at: string;
}

export interface FragmentDto {
  id: string;
  session_id: string;
  title: string;
  explanation: string;
  file_path: string;
  bpm: number;
  duration_ms: number;
  order_index: number;
  created_at: string;
  /** Piece of the repertoire this take belongs to (if any). */
  piece_id: string | null;
  /** Passage of the piece (free text); empty = the whole piece. */
  passage: string;
  comments: TimelineCommentDto[];
}

export interface SessionMediaDto {
  id: string;
  session_id: string;
  /** Absolute path (stored relative to the vault in the database). */
  local_path: string;
}

export interface SessionDetailDto {
  session: SessionDto;
  fragments: FragmentDto[];
  media: SessionMediaDto[];
  /** Number of raw-take trims that can be undone. */
  undo_depth: number;
  /** Fragment that the next undo would delete (it was extracted by the newest trim). */
  undo_fragment_id: string | null;
}

export interface ActivityBlock {
  start_ms: number;
  end_ms: number;
  note_count: number;
  velocity_avg: number;
}

export interface MidiActivityDto {
  file_path: string;
  duration_ms: number;
  blocks: ActivityBlock[];
}

export interface ExtractFragmentReq {
  session_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  explanation: string;
  piece_id?: string | null;
  passage?: string;
}

export interface FragmentCreatedResponse {
  fragment: FragmentDto;
  session: SessionDto;
}

export interface UndoTrimResult {
  session: SessionDto;
  /** Fragment deleted because the undone trim had extracted it. */
  removed_fragment_id: string | null;
}

export interface TimeRangeDto {
  start_ms: number;
  end_ms: number;
}

export interface NoteSpan {
  start_ms: number;
  end_ms: number;
  key: number;
  velocity: number;
}

/** Notes and sustain pedal of a `.mid` file, for the piano roll. */
export interface MidiNotesDto {
  file_path: string;
  duration_ms: number;
  /** Lowest and highest key played (21 and 108, an 88-key piano, if there are no notes). */
  min_key: number;
  max_key: number;
  /** Sorted by `start_ms`. */
  notes: NoteSpan[];
  /** Intervals with the sustain pedal down. */
  pedal: TimeRangeDto[];
}

export interface PracticeDayDto {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  duration_ms: number;
  sessions: number;
}

export interface PracticeStatsDto {
  /** Only the days with practice, sorted by date. */
  days: PracticeDayDto[];
  /** Weekly goal in minutes (0 = no goal). */
  weekly_goal_minutes: number;
}

export interface PieceDto {
  id: string;
  title: string;
  composer: string;
  notes: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface PieceSummaryDto {
  piece: PieceDto;
  take_count: number;
  /** Date of the most recent session with a take of the piece. */
  last_practiced: string | null;
  /** Passages already used in the piece's takes (sorted, without the empty one). */
  passages: string[];
}

export interface PieceTakeDto {
  fragment: FragmentDto;
  session_title: string;
  session_date: string;
}

export interface PieceDetailDto {
  piece: PieceDto;
  /** Sorted by passage and then chronologically. */
  takes: PieceTakeDto[];
}

/** A composition in the list of the composer. */
export interface CompositionSummaryDto {
  id: string;
  title: string;
  track_count: number;
  clip_count: number;
  /** End of the last clip (repeats included). */
  duration_ms: number;
  updated_at: string;
}

/** A clip: a window of a fragment placed on a track. The fragment's MIDI is never copied. */
export interface CompositionClipDto {
  /** Empty for a clip the backend has not stored yet. */
  id: string;
  fragment_id: string;
  /** Position on the composition's timeline. */
  start_ms: number;
  /** Start of the window inside the fragment. */
  trim_start_ms: number;
  /** Length of one repetition of the window. */
  length_ms: number;
  /** Times the window is played back to back (1 = once). */
  repeats: number;
  /** Semitones. */
  transpose: number;
  /** Read only: filled in from the fragment when loading, ignored when saving. */
  fragment_title: string;
  fragment_file_path: string;
  fragment_duration_ms: number;
}

/** A track: one MIDI channel with a General MIDI instrument. The array order is the track order. */
export interface CompositionTrackDto {
  id: string;
  name: string;
  /** General MIDI program (0-127). */
  program: number;
  /** MIDI channel volume (0-127). */
  volume: number;
  muted: boolean;
  solo: boolean;
  /** Whether the recorded sustain pedal (CC64) is played. */
  sustain: boolean;
  /** Index into the track palette. */
  color: number;
  /** Sorted by `start_ms`. */
  clips: CompositionClipDto[];
}

export interface CompositionDto {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  tracks: CompositionTrackDto[];
}

/** Mixer state of a track, applied live while a composition plays. */
export interface TrackMixDto {
  volume: number;
  muted: boolean;
  solo: boolean;
}

/** A fragment as the composer's library shows it. */
export interface LibraryFragmentDto {
  id: string;
  title: string;
  file_path: string;
  duration_ms: number;
  session_id: string;
  session_title: string;
  session_date: string;
  piece_id: string | null;
  piece_title: string | null;
  passage: string;
  created_at: string;
}

export interface SoundfontCandidate {
  path: string;
  name: string;
  size_bytes: number;
  is_builtin: boolean;
}

export interface SoundfontInfo {
  current_path: string;
  loading: boolean;
  candidates: SoundfontCandidate[];
}

export interface RecentVault {
  path: string;
  /** Folder name. */
  name: string;
  /** The folder exists and is still a vault. */
  available: boolean;
}

/** Open vault (if any), recent ones and warnings. */
export interface VaultInfo {
  /** Root of the open vault (absolute path), or null if there is none. */
  current: string | null;
  name: string | null;
  /** Most recent first; includes the open one. */
  recent: RecentVault[];
  /** Folder with data from the previous version (without vaults) that can be imported. */
  legacy_data_path: string | null;
  /** Warnings about the open vault (e.g. conflicting copies from Dropbox). */
  warnings: string[];
}

export interface VaultOpenResult {
  info: VaultInfo;
  /** false if it was not opened because it seems open on another computer (see lock_warning). */
  opened: boolean;
  /** Message asking for confirmation before opening with force = true. */
  lock_warning: string | null;
}

/** UI language. */
export interface LanguageInfo {
  /** Chosen by the user; null = automatic (the system language). */
  preference: string | null;
  /** Language in use. */
  effective: string;
  /** Language detected on the system (or the fallback if it is not available). */
  system: string;
}

/** What the "About" tab shows (comes from `Cargo.toml`). */
export interface AppInfo {
  name: string;
  version: string;
  /** Author names, without the email address. */
  authors: string[];
  /** SPDX identifier (`"MIT"`). */
  license: string;
  homepage: string;
  repository: string;
  tauri_version: string;
}

/** Links the "About" tab can open; the backend builds the URL. */
export type AppLink = 'homepage' | 'repository' | 'license';

/** Payload of the `playback-progress` event (every 50 ms). */
export interface PlaybackProgress {
  file_path: string;
  current_ms: number;
  duration_ms: number;
  is_playing: boolean;
}

/** Names of the Tauri events emitted by the backend. */
export const EVENT_PLAYBACK_PROGRESS = 'playback-progress';

/** Id of the MIDI simulator port (always present in `list_midi_ports`). */
export const SIMULATOR_PORT_ID = 'simulator';
