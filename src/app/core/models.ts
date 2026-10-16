// Contrato IPC: espejo exacto de `src-tauri/src/models.rs` (campos en snake_case).
// Los argumentos de `invoke` van en camelCase (convención Tauri v2), p. ej.
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
  /** Ruta absoluta (en la base de datos se guarda relativa a la bóveda). */
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
  /** Nombre de la carpeta. */
  name: string;
  /** La carpeta existe y sigue siendo una bóveda. */
  available: boolean;
}

/** Bóveda abierta (si hay), recientes y avisos. */
export interface VaultInfo {
  /** Raíz de la bóveda abierta (ruta absoluta), o null si no hay ninguna. */
  current: string | null;
  name: string | null;
  /** Más recientes primero; incluye la abierta. */
  recent: RecentVault[];
  /** Carpeta con datos de la versión anterior (sin bóvedas) que se pueden importar. */
  legacy_data_path: string | null;
  /** Avisos sobre la bóveda abierta (p. ej. copias en conflicto de Dropbox). */
  warnings: string[];
}

export interface VaultOpenResult {
  info: VaultInfo;
  /** false si no se abrió porque parece abierta en otro equipo (ver lock_warning). */
  opened: boolean;
  /** Mensaje para pedir confirmación antes de abrir con force = true. */
  lock_warning: string | null;
}

/** Idioma de la interfaz. */
export interface LanguageInfo {
  /** Elegido por el usuario; null = automático (el del sistema). */
  preference: string | null;
  /** Idioma en uso. */
  effective: string;
  /** Idioma detectado en el sistema (o el de reserva si no está disponible). */
  system: string;
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

/** Id del puerto simulador de MIDI (siempre presente en `list_midi_ports`). */
export const SIMULATOR_PORT_ID = 'simulator';
