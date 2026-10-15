// Contrato IPC: espejo exacto de `src-tauri/src/models.rs` (campos en snake_case).
// Los argumentos de `invoke` van en camelCase (convención Tauri v2), p. ej.
// invoke('start_recording', { sessionId, portId, bpm, metronomeOn, liveSynthOn }).

export type SyncState = 'PENDING' | 'SYNCED' | 'ERROR';

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
  sync_status: SyncState;
}

export interface SessionSummaryDto {
  id: string;
  title: string;
  session_date: string;
  bpm: number;
  raw_duration_ms: number;
  fragment_count: number;
  updated_at: string;
  sync_status: SyncState;
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
  drive_file_id: string | null;
  created_at: string;
  sync_status: SyncState;
  comments: TimelineCommentDto[];
}

export interface SessionMediaDto {
  id: string;
  session_id: string;
  local_path: string;
  drive_file_id: string | null;
  sync_status: SyncState;
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

export interface SyncStatusDto {
  has_credentials: boolean;
  connected: boolean;
  online: boolean;
  is_syncing: boolean;
  pending_count: number;
  error_count: number;
  last_sync_at: string | null;
  last_error: string | null;
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

/** Payload del evento `playback-progress` (cada 50 ms). */
export interface PlaybackProgress {
  file_path: string;
  current_ms: number;
  duration_ms: number;
  is_playing: boolean;
}

/** Nombres de eventos Tauri emitidos por el backend. */
export const EVENT_PLAYBACK_PROGRESS = 'playback-progress';
export const EVENT_SYNC_STATUS = 'sync-status';

/** Id del puerto simulador de MIDI (siempre presente en `list_midi_ports`). */
export const SIMULATOR_PORT_ID = 'simulator';
