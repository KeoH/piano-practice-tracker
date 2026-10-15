//! DTOs compartidos entre los módulos Rust y el frontend Angular.
//!
//! Contrato IPC: todos los campos se serializan en `snake_case` (sin renombrado),
//! y deben coincidir exactamente con `src/app/core/models.ts`.
//! Los argumentos sueltos de los comandos Tauri se envían desde JS en camelCase
//! (`invoke('start_recording', { sessionId, portId, ... })`), convención de Tauri v2.

use serde::{Deserialize, Serialize};

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
    /// Ordenados por `timestamp_ms` ascendente.
    pub comments: Vec<TimelineCommentDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionMediaDto {
    pub id: String,
    pub session_id: String,
    /// Ruta absoluta (en la base de datos se guarda relativa a la bóveda).
    pub local_path: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentVault {
    pub path: String,
    /// Nombre de la carpeta.
    pub name: String,
    /// La carpeta existe y sigue siendo una bóveda.
    pub available: bool,
}

/// Estado de la bóveda: la abierta (si hay), las recientes y avisos.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultInfo {
    /// Raíz de la bóveda abierta (ruta absoluta), o `None` si no hay ninguna.
    pub current: Option<String>,
    /// Nombre de la carpeta de la bóveda abierta.
    pub name: Option<String>,
    /// Más recientes primero; incluye la abierta.
    pub recent: Vec<RecentVault>,
    /// Carpeta con datos de la versión anterior (sin bóvedas) que se pueden importar.
    pub legacy_data_path: Option<String>,
    /// Avisos sobre la bóveda abierta (p. ej. copias en conflicto creadas por Dropbox).
    pub warnings: Vec<String>,
}

/// Idioma de la interfaz.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LanguageInfo {
    /// Elegido por el usuario; `None` = automático (el del sistema).
    pub preference: Option<String>,
    /// Idioma en uso.
    pub effective: String,
    /// Idioma detectado en el sistema (o el de reserva si no está disponible).
    pub system: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultOpenResult {
    pub info: VaultInfo,
    /// `false` si no se abrió porque parece abierta en otro equipo (ver `lock_warning`).
    pub opened: bool,
    /// Mensaje para pedir confirmación antes de abrir con `force = true`.
    pub lock_warning: Option<String>,
}
