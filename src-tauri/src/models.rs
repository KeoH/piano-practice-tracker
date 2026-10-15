//! DTOs compartidos entre los módulos Rust y el frontend Angular.
//!
//! Contrato IPC: todos los campos se serializan en `snake_case` (sin renombrado),
//! y deben coincidir exactamente con `src/app/core/models.ts`.
//! Los argumentos sueltos de los comandos Tauri se envían desde JS en camelCase
//! (`invoke('start_recording', { sessionId, portId, ... })`), convención de Tauri v2.

use serde::{Deserialize, Serialize};

/// Estados de sincronización usados en `sessions`, `midi_fragments` y `session_media`.
pub const SYNC_PENDING: &str = "PENDING";
pub const SYNC_SYNCED: &str = "SYNCED";
pub const SYNC_ERROR: &str = "ERROR";

/// Tipos de entidad en `sync_queue.entity_type`.
pub const ENTITY_MIDI_FRAGMENT: &str = "MIDI_FRAGMENT";
pub const ENTITY_MEDIA_IMAGE: &str = "MEDIA_IMAGE";
pub const ENTITY_DB_SNAPSHOT: &str = "DB_SNAPSHOT";
/// Pista bruta de sesión (extensión sobre la especificación: también se respalda en Drive).
pub const ENTITY_RAW_MIDI: &str = "RAW_MIDI";

/// Acciones en `sync_queue.action`.
pub const ACTION_UPLOAD: &str = "UPLOAD";
pub const ACTION_UPDATE: &str = "UPDATE";
pub const ACTION_DELETE: &str = "DELETE";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MidiPortInfo {
    /// Identificador estable para `start_recording` (`"simulator"` para el simulador interno).
    pub id: String,
    pub name: String,
    pub is_virtual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionDto {
    pub id: String,
    pub title: String,
    /// Fecha ISO `YYYY-MM-DD`.
    pub session_date: String,
    pub bpm: u32,
    pub raw_midi_path: Option<String>,
    pub raw_duration_ms: u64,
    pub markdown_notes: String,
    /// RFC 3339.
    pub updated_at: String,
    pub sync_status: String,
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
    pub sync_status: String,
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
    pub drive_file_id: Option<String>,
    pub created_at: String,
    pub sync_status: String,
    /// Ordenados por `timestamp_ms` ascendente.
    pub comments: Vec<TimelineCommentDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionMediaDto {
    pub id: String,
    pub session_id: String,
    pub local_path: String,
    pub drive_file_id: Option<String>,
    pub sync_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionDetailDto {
    pub session: SessionDto,
    /// Ordenados por `order_index` y luego `created_at`.
    pub fragments: Vec<FragmentDto>,
    pub media: Vec<SessionMediaDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActivityBlock {
    pub start_ms: u64,
    pub end_ms: u64,
    pub note_count: u32,
    /// Velocidad media de los NoteOn del bloque (0.0 si no hay notas).
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FragmentCreatedResponse {
    pub fragment: FragmentDto,
    /// Sesión tras el recorte destructivo (nueva `raw_duration_ms`).
    pub session: SessionDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SyncStatusDto {
    /// Hay `client_id`/`client_secret` guardados.
    pub has_credentials: bool,
    /// Hay `refresh_token` guardado (cuenta conectada).
    pub connected: bool,
    /// Último intento de red con éxito (false si el último intento falló por red).
    pub online: bool,
    pub is_syncing: bool,
    pub pending_count: u32,
    pub error_count: u32,
    /// RFC 3339.
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
}

/// Payload del evento Tauri `playback-progress` (emitido cada 50 ms durante la reproducción).
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
    /// El piano sintético generado por la app (último recurso).
    pub is_builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SoundfontInfo {
    /// SoundFont activo (o el que se está cargando en segundo plano).
    pub current_path: String,
    /// `true` mientras se carga el SoundFont en segundo plano.
    pub loading: bool,
    pub candidates: Vec<SoundfontCandidate>,
}

/// Fila de `sync_queue`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SyncQueueItem {
    pub id: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub payload_path: Option<String>,
    pub created_at: String,
    pub retry_count: i64,
    pub last_error: Option<String>,
}
