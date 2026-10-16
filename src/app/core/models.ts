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
}

export interface FragmentCreatedResponse {
  fragment: FragmentDto;
  session: SessionDto;
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
