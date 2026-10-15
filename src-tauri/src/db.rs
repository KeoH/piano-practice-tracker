//! Persistencia local en SQLite (offline-first).
//!
//! - Esquema según SPECIFICATIONS.md §3.1, versionado con `PRAGMA user_version`.
//! - Toda mutación relevante registra automáticamente su entrada en `sync_queue`.
//! - `drive_file_id` de la pista bruta y del snapshot de la base de datos se guardan en
//!   `app_settings` (claves `drive_file_id:RAW_MIDI:<session_id>` y `drive_file_id:DB_SNAPSHOT`),
//!   sin alterar el esquema.
//! - Elementos `DELETE` de la cola: `entity_id` = id local original (fragmento, media o sesión) y
//!   `payload_path` = `drive_file_id` remoto a borrar.
//! - Sesiones: pasan a `SYNCED` cuando no quedan elementos pendientes que les afecten
//!   (snapshot de BD, pista bruta, fragmentos o media de la sesión). Esto se reevalúa al
//!   marcar como sincronizada cualquier entidad (en especial tras subir el `DB_SNAPSHOT`).
//!   Por eso el worker llama primero a `complete_sync_item` y después a `mark_entity_synced`.
//! - Un elemento con `retry_count >= MAX_RETRIES` se considera en error: no se devuelve en
//!   `pending_sync_items` y cuenta en `sync_counts().1`.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use chrono::{Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::{
    FragmentDto, SessionDetailDto, SessionDto, SessionMediaDto, SessionSummaryDto, SyncQueueItem,
    TimelineCommentDto, ACTION_DELETE, ACTION_UPLOAD, ENTITY_DB_SNAPSHOT, ENTITY_MEDIA_IMAGE,
    ENTITY_MIDI_FRAGMENT, ENTITY_RAW_MIDI, SYNC_ERROR, SYNC_PENDING, SYNC_SYNCED,
};

/// Número de reintentos a partir del cual un elemento de la cola se considera fallido.
pub const MAX_RETRIES: i64 = 5;

/// `entity_id` usado para los elementos `DB_SNAPSHOT` de la cola.
pub const SNAPSHOT_ENTITY_ID: &str = "piano_tracker_backup";

const SCHEMA_VERSION: i64 = 1;

const MIGRATION_V1: &str = r#"
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

const SESSION_COLS: &str =
    "id, title, session_date, bpm, raw_midi_path, raw_duration_ms, markdown_notes, updated_at, sync_status";
const FRAGMENT_COLS: &str = "id, session_id, title, explanation, file_path, bpm, duration_ms, order_index, \
     drive_file_id, created_at, sync_status";
const COMMENT_COLS: &str = "id, fragment_id, timestamp_ms, content, created_at";
const MEDIA_COLS: &str = "id, session_id, local_path, drive_file_id, sync_status";
const QUEUE_COLS: &str = "id, entity_type, entity_id, action, payload_path, created_at, retry_count, last_error";

/// Clave de `app_settings` donde se guarda el `drive_file_id` de entidades sin columna propia.
pub fn drive_file_setting_key(entity_type: &str, entity_id: &str) -> String {
    if entity_type == ENTITY_DB_SNAPSHOT {
        format!("drive_file_id:{ENTITY_DB_SNAPSHOT}")
    } else {
        format!("drive_file_id:{entity_type}:{entity_id}")
    }
}

fn db_err(e: rusqlite::Error) -> String {
    format!("Error de base de datos: {e}")
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
        sync_status: r.get(8)?,
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
        drive_file_id: r.get(8)?,
        created_at: r.get(9)?,
        sync_status: r.get(10)?,
        comments: Vec::new(),
    })
}

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
    Ok(SessionMediaDto {
        id: r.get(0)?,
        session_id: r.get(1)?,
        local_path: r.get(2)?,
        drive_file_id: r.get(3)?,
        sync_status: r.get(4)?,
    })
}

fn map_queue(r: &Row) -> rusqlite::Result<SyncQueueItem> {
    Ok(SyncQueueItem {
        id: r.get(0)?,
        entity_type: r.get(1)?,
        entity_id: r.get(2)?,
        action: r.get(3)?,
        payload_path: r.get(4)?,
        created_at: r.get(5)?,
        retry_count: r.get(6)?,
        last_error: r.get(7)?,
    })
}

// ---------------------------------------------------------------------------
// Funciones internas sobre una conexión (permiten componerlas en transacciones)
// ---------------------------------------------------------------------------

fn enqueue_in(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    action: &str,
    payload_path: Option<&str>,
) -> Result<(), String> {
    if entity_type == ENTITY_DB_SNAPSHOT {
        let existing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_queue WHERE entity_type = ?1 AND retry_count < ?2",
                params![ENTITY_DB_SNAPSHOT, MAX_RETRIES],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if existing > 0 {
            return Ok(());
        }
    }
    conn.execute(
        "INSERT INTO sync_queue (entity_type, entity_id, action, payload_path, created_at, retry_count) \
         VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        params![entity_type, entity_id, action, payload_path, now_rfc3339()],
    )
    .map_err(db_err)?;
    Ok(())
}

fn enqueue_snapshot(conn: &Connection) -> Result<(), String> {
    enqueue_in(conn, ENTITY_DB_SNAPSHOT, SNAPSHOT_ENTITY_ID, ACTION_UPLOAD, None)
}

fn fetch_session(conn: &Connection, session_id: &str) -> Result<SessionDto, String> {
    conn.query_row(
        &format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1"),
        params![session_id],
        map_session,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("La sesión '{session_id}' no existe"))
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

fn fetch_fragment(conn: &Connection, fragment_id: &str) -> Result<FragmentDto, String> {
    let mut frag = conn
        .query_row(
            &format!("SELECT {FRAGMENT_COLS} FROM midi_fragments WHERE id = ?1"),
            params![fragment_id],
            map_fragment,
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| format!("El fragmento '{fragment_id}' no existe"))?;
    frag.comments = fetch_comments(conn, fragment_id)?;
    Ok(frag)
}

fn touch_session(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE sessions SET updated_at = ?1, sync_status = ?2 WHERE id = ?3",
        params![now_rfc3339(), SYNC_PENDING, session_id],
    )
    .map_err(db_err)?;
    Ok(())
}

fn get_setting_in(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(db_err)
}

fn set_setting_in(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(db_err)?;
    Ok(())
}

fn delete_setting_in(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key]).map_err(db_err)?;
    Ok(())
}

/// Elimina de la cola las subidas/actualizaciones pendientes de una entidad (no los DELETE).
fn drop_pending_uploads(conn: &Connection, entity_type: &str, entity_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM sync_queue WHERE entity_type = ?1 AND entity_id = ?2 AND action <> ?3",
        params![entity_type, entity_id, ACTION_DELETE],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Marca como SYNCED las sesiones PENDING (todas o solo una) sin elementos pendientes que les afecten.
fn refresh_sessions_sync(conn: &Connection, only_session: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE sessions SET sync_status = ?1 \
         WHERE sync_status = ?2 AND (?3 IS NULL OR id = ?3) AND NOT EXISTS ( \
            SELECT 1 FROM sync_queue q WHERE q.retry_count < ?4 AND ( \
                q.entity_type = ?5 \
                OR (q.entity_type = ?6 AND q.entity_id = sessions.id) \
                OR (q.entity_type = ?7 AND q.entity_id IN \
                    (SELECT f.id FROM midi_fragments f WHERE f.session_id = sessions.id)) \
                OR (q.entity_type = ?8 AND q.entity_id IN \
                    (SELECT m.id FROM session_media m WHERE m.session_id = sessions.id))))",
        params![
            SYNC_SYNCED,
            SYNC_PENDING,
            only_session,
            MAX_RETRIES,
            ENTITY_DB_SNAPSHOT,
            ENTITY_RAW_MIDI,
            ENTITY_MIDI_FRAGMENT,
            ENTITY_MEDIA_IMAGE
        ],
    )
    .map_err(db_err)?;
    Ok(())
}

fn backup_in(conn: &Connection, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("No se pudo crear el directorio {}: {e}", parent.display()))?;
        }
    }
    let mut tmp_name = dest.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp_name);
    if tmp.exists() {
        std::fs::remove_file(&tmp)
            .map_err(|e| format!("No se pudo eliminar el temporal {}: {e}", tmp.display()))?;
    }
    let tmp_str = tmp
        .to_str()
        .ok_or_else(|| format!("Ruta de copia de seguridad no válida: {}", tmp.display()))?;
    conn.execute("VACUUM INTO ?1", params![tmp_str])
        .map_err(|e| format!("No se pudo crear la copia de seguridad: {e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("No se pudo mover la copia de seguridad a {}: {e}", dest.display())
    })
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/// Base de datos SQLite compartible entre hilos (`Arc<Database>`).
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Abre (o crea) el fichero, activa claves foráneas y WAL, y aplica migraciones.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("No se pudo crear el directorio {}: {e}", parent.display()))?;
            }
        }
        let conn = Connection::open(path)
            .map_err(|e| format!("No se pudo abrir la base de datos {}: {e}", path.display()))?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0))
            .map_err(db_err)?;
        Self::init(conn)
    }

    /// Base de datos en memoria (tests).
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(db_err)?;
        Self::init(conn)
    }

    fn init(mut conn: Connection) -> Result<Self, String> {
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(db_err)?;
        Self::migrate(&mut conn)?;
        Ok(Database { conn: Mutex::new(conn) })
    }

    fn migrate(conn: &mut Connection) -> Result<(), String> {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err)?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "La base de datos tiene una versión de esquema ({version}) más reciente que la aplicación ({SCHEMA_VERSION})"
            ));
        }
        if version < 1 {
            let tx = conn.transaction().map_err(db_err)?;
            tx.execute_batch(MIGRATION_V1)
                .map_err(|e| format!("Error al migrar la base de datos (v1): {e}"))?;
            tx.execute_batch("PRAGMA user_version = 1;").map_err(db_err)?;
            tx.commit().map_err(db_err)?;
        }
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "La conexión a la base de datos quedó bloqueada por un error previo".to_string())
    }

    // ----------------------------- Sesiones -----------------------------

    pub fn create_session(&self, title: &str, bpm: u32) -> Result<SessionDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO sessions (id, title, session_date, bpm, raw_midi_path, raw_duration_ms, \
             markdown_notes, updated_at, sync_status) VALUES (?1, ?2, ?3, ?4, NULL, 0, '', ?5, ?6)",
            params![id, title, today(), i64::from(bpm), now_rfc3339(), SYNC_PENDING],
        )
        .map_err(db_err)?;
        enqueue_snapshot(&tx)?;
        let session = fetch_session(&tx, &id)?;
        tx.commit().map_err(db_err)?;
        Ok(session)
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionSummaryDto>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.title, s.session_date, s.bpm, s.raw_duration_ms, \
                 (SELECT COUNT(*) FROM midi_fragments f WHERE f.session_id = s.id), \
                 s.updated_at, s.sync_status \
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
                    sync_status: r.get(7)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
    }

    pub fn get_session(&self, session_id: &str) -> Result<SessionDto, String> {
        let conn = self.lock()?;
        fetch_session(&conn, session_id)
    }

    pub fn get_session_detail(&self, session_id: &str) -> Result<SessionDetailDto, String> {
        let conn = self.lock()?;
        let session = fetch_session(&conn, session_id)?;

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

        let media = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {MEDIA_COLS} FROM session_media WHERE session_id = ?1 ORDER BY rowid ASC"
                ))
                .map_err(db_err)?;
            let rows = stmt.query_map(params![session_id], map_media).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };

        Ok(SessionDetailDto { session, fragments, media })
    }

    pub fn update_session(&self, session_id: &str, title: &str, bpm: u32, markdown_notes: &str) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let changed = tx
            .execute(
                "UPDATE sessions SET title = ?1, bpm = ?2, markdown_notes = ?3, updated_at = ?4, sync_status = ?5 \
                 WHERE id = ?6",
                params![title, i64::from(bpm), markdown_notes, now_rfc3339(), SYNC_PENDING, session_id],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(format!("La sesión '{session_id}' no existe"));
        }
        enqueue_snapshot(&tx)?;
        tx.commit().map_err(db_err)
    }

    pub fn set_session_raw_midi(&self, session_id: &str, raw_path: &str, duration_ms: u64) -> Result<SessionDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let changed = tx
            .execute(
                "UPDATE sessions SET raw_midi_path = ?1, raw_duration_ms = ?2, updated_at = ?3, sync_status = ?4 \
                 WHERE id = ?5",
                params![raw_path, to_i64(duration_ms), now_rfc3339(), SYNC_PENDING, session_id],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(format!("La sesión '{session_id}' no existe"));
        }
        enqueue_in(&tx, ENTITY_RAW_MIDI, session_id, ACTION_UPLOAD, Some(raw_path))?;
        enqueue_snapshot(&tx)?;
        let session = fetch_session(&tx, session_id)?;
        tx.commit().map_err(db_err)?;
        Ok(session)
    }

    /// Borra la sesión en cascada y devuelve las rutas locales a eliminar por el llamador.
    pub fn delete_session(&self, session_id: &str) -> Result<Vec<String>, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let session = fetch_session(&tx, session_id)?;
        let mut paths = Vec::new();
        if let Some(raw) = session.raw_midi_path.filter(|p| !p.is_empty()) {
            paths.push(raw);
        }

        let fragments: Vec<(String, String, Option<String>)> = {
            let mut stmt = tx
                .prepare("SELECT id, file_path, drive_file_id FROM midi_fragments WHERE session_id = ?1")
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };
        let media: Vec<(String, String, Option<String>)> = {
            let mut stmt = tx
                .prepare("SELECT id, local_path, drive_file_id FROM session_media WHERE session_id = ?1")
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        };

        for (entity_type, items) in [(ENTITY_MIDI_FRAGMENT, &fragments), (ENTITY_MEDIA_IMAGE, &media)] {
            for (id, path, drive_id) in items {
                paths.push(path.clone());
                drop_pending_uploads(&tx, entity_type, id)?;
                if let Some(drive_id) = drive_id.as_deref().filter(|d| !d.is_empty()) {
                    enqueue_in(&tx, entity_type, id, ACTION_DELETE, Some(drive_id))?;
                }
            }
        }

        drop_pending_uploads(&tx, ENTITY_RAW_MIDI, session_id)?;
        let raw_key = drive_file_setting_key(ENTITY_RAW_MIDI, session_id);
        if let Some(raw_drive_id) = get_setting_in(&tx, &raw_key)? {
            enqueue_in(&tx, ENTITY_RAW_MIDI, session_id, ACTION_DELETE, Some(&raw_drive_id))?;
            delete_setting_in(&tx, &raw_key)?;
        }

        tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id]).map_err(db_err)?;
        enqueue_snapshot(&tx)?;
        tx.commit().map_err(db_err)?;
        Ok(paths)
    }

    // ----------------------------- Fragmentos -----------------------------

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
             order_index, drive_file_id, created_at, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10)",
            params![
                fragment_id,
                session_id,
                title,
                explanation,
                file_path,
                i64::from(bpm),
                to_i64(duration_ms),
                order_index,
                now_rfc3339(),
                SYNC_PENDING
            ],
        )
        .map_err(db_err)?;
        touch_session(&tx, session_id)?;
        enqueue_in(&tx, ENTITY_MIDI_FRAGMENT, fragment_id, ACTION_UPLOAD, Some(file_path))?;
        enqueue_snapshot(&tx)?;
        let frag = fetch_fragment(&tx, fragment_id)?;
        tx.commit().map_err(db_err)?;
        Ok(frag)
    }

    pub fn get_fragment(&self, fragment_id: &str) -> Result<FragmentDto, String> {
        let conn = self.lock()?;
        fetch_fragment(&conn, fragment_id)
    }

    pub fn update_fragment_meta(&self, fragment_id: &str, title: &str, explanation: &str) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let session_id: Option<String> = tx
            .query_row("SELECT session_id FROM midi_fragments WHERE id = ?1", params![fragment_id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        let session_id = session_id.ok_or_else(|| format!("El fragmento '{fragment_id}' no existe"))?;
        tx.execute(
            "UPDATE midi_fragments SET title = ?1, explanation = ?2 WHERE id = ?3",
            params![title, explanation, fragment_id],
        )
        .map_err(db_err)?;
        touch_session(&tx, &session_id)?;
        enqueue_snapshot(&tx)?;
        tx.commit().map_err(db_err)
    }

    /// Borra el fragmento y devuelve su `file_path`. Si ya estaba en Drive encola
    /// `MIDI_FRAGMENT DELETE` con `entity_id = fragment_id` y `payload_path = drive_file_id`.
    pub fn delete_fragment(&self, fragment_id: &str) -> Result<String, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let frag = fetch_fragment(&tx, fragment_id)?;
        drop_pending_uploads(&tx, ENTITY_MIDI_FRAGMENT, fragment_id)?;
        if let Some(drive_id) = frag.drive_file_id.as_deref().filter(|d| !d.is_empty()) {
            enqueue_in(&tx, ENTITY_MIDI_FRAGMENT, fragment_id, ACTION_DELETE, Some(drive_id))?;
        }
        tx.execute("DELETE FROM midi_fragments WHERE id = ?1", params![fragment_id]).map_err(db_err)?;
        touch_session(&tx, &frag.session_id)?;
        enqueue_snapshot(&tx)?;
        tx.commit().map_err(db_err)?;
        Ok(frag.file_path)
    }

    // ----------------------------- Comentarios -----------------------------

    pub fn add_timeline_comment(&self, fragment_id: &str, timestamp_ms: u64, content: &str) -> Result<TimelineCommentDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let session_id: Option<String> = tx
            .query_row("SELECT session_id FROM midi_fragments WHERE id = ?1", params![fragment_id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        let session_id = session_id.ok_or_else(|| format!("El fragmento '{fragment_id}' no existe"))?;
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
        enqueue_snapshot(&tx)?;
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
        let session_id = session_id.ok_or_else(|| format!("El comentario '{comment_id}' no existe"))?;
        tx.execute("DELETE FROM timeline_comments WHERE id = ?1", params![comment_id]).map_err(db_err)?;
        touch_session(&tx, &session_id)?;
        enqueue_snapshot(&tx)?;
        tx.commit().map_err(db_err)
    }

    // ----------------------------- Media -----------------------------

    pub fn insert_media(&self, session_id: &str, local_path: &str) -> Result<SessionMediaDto, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        fetch_session(&tx, session_id)?;
        let media = SessionMediaDto {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            local_path: local_path.to_string(),
            drive_file_id: None,
            sync_status: SYNC_PENDING.to_string(),
        };
        tx.execute(
            "INSERT INTO session_media (id, session_id, local_path, drive_file_id, sync_status) \
             VALUES (?1, ?2, ?3, NULL, ?4)",
            params![media.id, media.session_id, media.local_path, media.sync_status],
        )
        .map_err(db_err)?;
        touch_session(&tx, session_id)?;
        enqueue_in(&tx, ENTITY_MEDIA_IMAGE, &media.id, ACTION_UPLOAD, Some(local_path))?;
        enqueue_snapshot(&tx)?;
        tx.commit().map_err(db_err)?;
        Ok(media)
    }

    // ----------------------------- Ajustes -----------------------------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.lock()?;
        get_setting_in(&conn, key)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.lock()?;
        set_setting_in(&conn, key, value)
    }

    pub fn delete_setting(&self, key: &str) -> Result<(), String> {
        let conn = self.lock()?;
        delete_setting_in(&conn, key)
    }

    // ----------------------------- Cola de sincronización -----------------------------

    /// Encola una operación. `DB_SNAPSHOT` se deduplica: si ya hay uno pendiente no inserta otro.
    pub fn enqueue_sync(&self, entity_type: &str, entity_id: &str, action: &str, payload_path: Option<&str>) -> Result<(), String> {
        let conn = self.lock()?;
        enqueue_in(&conn, entity_type, entity_id, action, payload_path)
    }

    /// Elementos pendientes (`retry_count < MAX_RETRIES`) en orden FIFO.
    pub fn pending_sync_items(&self, limit: usize) -> Result<Vec<SyncQueueItem>, String> {
        let conn = self.lock()?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {QUEUE_COLS} FROM sync_queue WHERE retry_count < ?1 ORDER BY id ASC LIMIT ?2"
            ))
            .map_err(db_err)?;
        let rows = stmt.query_map(params![MAX_RETRIES, limit], map_queue).map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
    }

    pub fn complete_sync_item(&self, queue_id: i64) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM sync_queue WHERE id = ?1", params![queue_id]).map_err(db_err)?;
        Ok(())
    }

    /// Fallo definitivo/recuperable: `retry_count += 1` y guarda el error.
    pub fn fail_sync_item(&self, queue_id: i64, error: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE sync_queue SET retry_count = retry_count + 1, last_error = ?1 WHERE id = ?2",
            params![error, queue_id],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Fallo transitorio (sin red): incrementa `retry_count` pero sin llegar nunca a
    /// `MAX_RETRIES`, de modo que el elemento sigue PENDING y se reintentará al volver la red.
    pub fn defer_sync_item(&self, queue_id: i64, error: &str) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "UPDATE sync_queue SET retry_count = MIN(retry_count + 1, ?1), last_error = ?2 WHERE id = ?3",
            params![MAX_RETRIES - 1, error, queue_id],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Lee un elemento concreto de la cola (si sigue existiendo).
    pub fn get_sync_item(&self, queue_id: i64) -> Result<Option<SyncQueueItem>, String> {
        let conn = self.lock()?;
        conn.query_row(
            &format!("SELECT {QUEUE_COLS} FROM sync_queue WHERE id = ?1"),
            params![queue_id],
            map_queue,
        )
        .optional()
        .map_err(db_err)
    }

    pub fn mark_entity_synced(&self, entity_type: &str, entity_id: &str, drive_file_id: Option<&str>) -> Result<(), String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        match entity_type {
            ENTITY_MIDI_FRAGMENT => {
                tx.execute(
                    "UPDATE midi_fragments SET sync_status = ?1, drive_file_id = COALESCE(?2, drive_file_id) \
                     WHERE id = ?3",
                    params![SYNC_SYNCED, drive_file_id, entity_id],
                )
                .map_err(db_err)?;
                let sid: Option<String> = tx
                    .query_row("SELECT session_id FROM midi_fragments WHERE id = ?1", params![entity_id], |r| r.get(0))
                    .optional()
                    .map_err(db_err)?;
                if let Some(sid) = sid {
                    refresh_sessions_sync(&tx, Some(&sid))?;
                }
            }
            ENTITY_MEDIA_IMAGE => {
                tx.execute(
                    "UPDATE session_media SET sync_status = ?1, drive_file_id = COALESCE(?2, drive_file_id) \
                     WHERE id = ?3",
                    params![SYNC_SYNCED, drive_file_id, entity_id],
                )
                .map_err(db_err)?;
                let sid: Option<String> = tx
                    .query_row("SELECT session_id FROM session_media WHERE id = ?1", params![entity_id], |r| r.get(0))
                    .optional()
                    .map_err(db_err)?;
                if let Some(sid) = sid {
                    refresh_sessions_sync(&tx, Some(&sid))?;
                }
            }
            ENTITY_RAW_MIDI => {
                let exists = fetch_session(&tx, entity_id).is_ok();
                if exists {
                    if let Some(id) = drive_file_id {
                        set_setting_in(&tx, &drive_file_setting_key(ENTITY_RAW_MIDI, entity_id), id)?;
                    }
                    refresh_sessions_sync(&tx, Some(entity_id))?;
                }
            }
            ENTITY_DB_SNAPSHOT => {
                if let Some(id) = drive_file_id {
                    set_setting_in(&tx, &drive_file_setting_key(ENTITY_DB_SNAPSHOT, entity_id), id)?;
                }
                // Un snapshot correcto deja obsoletos los snapshots fallidos anteriores.
                tx.execute(
                    "DELETE FROM sync_queue WHERE entity_type = ?1 AND retry_count >= ?2",
                    params![ENTITY_DB_SNAPSHOT, MAX_RETRIES],
                )
                .map_err(db_err)?;
                refresh_sessions_sync(&tx, None)?;
            }
            other => return Err(format!("Tipo de entidad desconocido: {other}")),
        }
        tx.commit().map_err(db_err)
    }

    pub fn mark_entity_error(&self, entity_type: &str, entity_id: &str) -> Result<(), String> {
        let conn = self.lock()?;
        let sql = match entity_type {
            ENTITY_MIDI_FRAGMENT => "UPDATE midi_fragments SET sync_status = ?1 WHERE id = ?2",
            ENTITY_MEDIA_IMAGE => "UPDATE session_media SET sync_status = ?1 WHERE id = ?2",
            ENTITY_RAW_MIDI => "UPDATE sessions SET sync_status = ?1 WHERE id = ?2",
            ENTITY_DB_SNAPSHOT => return Ok(()),
            other => return Err(format!("Tipo de entidad desconocido: {other}")),
        };
        conn.execute(sql, params![SYNC_ERROR, entity_id]).map_err(db_err)?;
        Ok(())
    }

    /// `true` si la entidad local sigue existiendo (para detectar borrados durante una subida).
    pub fn entity_exists(&self, entity_type: &str, entity_id: &str) -> Result<bool, String> {
        let conn = self.lock()?;
        let sql = match entity_type {
            ENTITY_MIDI_FRAGMENT => "SELECT COUNT(*) FROM midi_fragments WHERE id = ?1",
            ENTITY_MEDIA_IMAGE => "SELECT COUNT(*) FROM session_media WHERE id = ?1",
            ENTITY_RAW_MIDI => "SELECT COUNT(*) FROM sessions WHERE id = ?1",
            ENTITY_DB_SNAPSHOT => return Ok(true),
            other => return Err(format!("Tipo de entidad desconocido: {other}")),
        };
        let n: i64 = conn.query_row(sql, params![entity_id], |r| r.get(0)).map_err(db_err)?;
        Ok(n > 0)
    }

    /// `drive_file_id` conocido de una entidad (columna propia o `app_settings`).
    pub fn get_drive_file_id(&self, entity_type: &str, entity_id: &str) -> Result<Option<String>, String> {
        let conn = self.lock()?;
        let id: Option<String> = match entity_type {
            ENTITY_MIDI_FRAGMENT => conn
                .query_row("SELECT drive_file_id FROM midi_fragments WHERE id = ?1", params![entity_id], |r| r.get(0))
                .optional()
                .map_err(db_err)?
                .flatten(),
            ENTITY_MEDIA_IMAGE => conn
                .query_row("SELECT drive_file_id FROM session_media WHERE id = ?1", params![entity_id], |r| r.get(0))
                .optional()
                .map_err(db_err)?
                .flatten(),
            ENTITY_RAW_MIDI | ENTITY_DB_SNAPSHOT => {
                get_setting_in(&conn, &drive_file_setting_key(entity_type, entity_id))?
            }
            other => return Err(format!("Tipo de entidad desconocido: {other}")),
        };
        Ok(id.filter(|s| !s.is_empty()))
    }

    /// (elementos pendientes, elementos con `retry_count >= MAX_RETRIES`).
    pub fn sync_counts(&self) -> Result<(u32, u32), String> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN retry_count < ?1 THEN 1 ELSE 0 END), 0), \
                    COALESCE(SUM(CASE WHEN retry_count >= ?1 THEN 1 ELSE 0 END), 0) FROM sync_queue",
            params![MAX_RETRIES],
            |r| Ok((to_u32(r.get(0)?), to_u32(r.get(1)?))),
        )
        .map_err(db_err)
    }

    /// Copia consistente de la base de datos (`VACUUM INTO` a temporal + rename atómico).
    pub fn backup_to(&self, dest: &Path) -> Result<(), String> {
        let conn = self.lock()?;
        backup_in(&conn, dest)
    }

    /// Para el worker de sincronización: genera el snapshot en `dest` y, de forma atómica con
    /// él, retira de la cola el elemento `DB_SNAPSHOT` `queue_id`. Así cualquier cambio posterior
    /// encola un snapshot nuevo (la deduplicación no lo absorbe en el que está en vuelo).
    pub fn snapshot_for_sync(&self, queue_id: i64, dest: &Path) -> Result<(), String> {
        let conn = self.lock()?;
        backup_in(&conn, dest)?;
        conn.execute("DELETE FROM sync_queue WHERE id = ?1", params![queue_id]).map_err(db_err)?;
        Ok(())
    }

    /// Vuelve a encolar un snapshot cuya subida falló tras `snapshot_for_sync`, conservando el
    /// número de reintentos indicado (si ya hay otro snapshot pendiente, se le anota el error).
    pub fn requeue_snapshot(&self, retry_count: i64, error: &str) -> Result<(), String> {
        let conn = self.lock()?;
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM sync_queue WHERE entity_type = ?1 AND retry_count < ?2 ORDER BY id LIMIT 1",
                params![ENTITY_DB_SNAPSHOT, MAX_RETRIES],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        match existing {
            Some(id) => conn.execute(
                "UPDATE sync_queue SET retry_count = MAX(retry_count, ?1), last_error = ?2 WHERE id = ?3",
                params![retry_count, error, id],
            ),
            None => conn.execute(
                "INSERT INTO sync_queue (entity_type, entity_id, action, payload_path, created_at, retry_count, last_error) \
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)",
                params![ENTITY_DB_SNAPSHOT, SNAPSHOT_ENTITY_ID, ACTION_UPLOAD, now_rfc3339(), retry_count, error],
            ),
        }
        .map_err(db_err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        Database::open_in_memory().unwrap()
    }

    fn queue_of(db: &Database, entity_type: &str) -> Vec<SyncQueueItem> {
        db.pending_sync_items(1000)
            .unwrap()
            .into_iter()
            .filter(|i| i.entity_type == entity_type)
            .collect()
    }

    #[test]
    fn create_and_list_sessions() {
        let db = db();
        let a = db.create_session("Escalas", 90).unwrap();
        let b = db.create_session("Chopin", 60).unwrap();
        assert_eq!(a.session_date, today());
        assert_eq!(a.sync_status, SYNC_PENDING);
        assert_eq!(a.bpm, 90);
        assert!(a.raw_midi_path.is_none());
        assert!(chrono::DateTime::parse_from_rfc3339(&a.updated_at).is_ok());

        db.insert_fragment("f1", &a.id, "Frag", "", "/tmp/f1.mid", 90, 1000).unwrap();
        let list = db.list_sessions().unwrap();
        assert_eq!(list.len(), 2);
        // `a` se actualizó (fragmento) después de crear `b`.
        assert_eq!(list[0].id, a.id);
        assert_eq!(list[0].fragment_count, 1);
        assert_eq!(list[1].id, b.id);
        assert_eq!(list[1].fragment_count, 0);

        db.update_session(&b.id, "Chopin op. 28", 72, "# Notas").unwrap();
        let got = db.get_session(&b.id).unwrap();
        assert_eq!(got.title, "Chopin op. 28");
        assert_eq!(got.bpm, 72);
        assert_eq!(got.markdown_notes, "# Notas");
        assert!(db.get_session("nope").is_err());
        assert!(db.update_session("nope", "x", 1, "").is_err());
    }

    #[test]
    fn raw_midi_enqueues_upload() {
        let db = db();
        let s = db.create_session("S", 120).unwrap();
        let updated = db.set_session_raw_midi(&s.id, "/tmp/raw.mid", 5000).unwrap();
        assert_eq!(updated.raw_midi_path.as_deref(), Some("/tmp/raw.mid"));
        assert_eq!(updated.raw_duration_ms, 5000);
        let raw = queue_of(&db, ENTITY_RAW_MIDI);
        assert_eq!(raw.len(), 1);
        assert_eq!(raw[0].entity_id, s.id);
        assert_eq!(raw[0].action, ACTION_UPLOAD);
        assert_eq!(raw[0].payload_path.as_deref(), Some("/tmp/raw.mid"));
    }

    #[test]
    fn fragments_comments_and_cascade_delete() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        db.set_session_raw_midi(&s.id, "/data/raw.mid", 10_000).unwrap();
        let f1 = db.insert_fragment("f1", &s.id, "Uno", "exp", "/data/f1.mid", 100, 2000).unwrap();
        let f2 = db.insert_fragment("f2", &s.id, "Dos", "", "/data/f2.mid", 100, 3000).unwrap();
        assert_eq!(f1.order_index, 0);
        assert_eq!(f2.order_index, 1);
        assert!(db.insert_fragment("fx", "nope", "x", "", "/x.mid", 1, 1).is_err());

        let c2 = db.add_timeline_comment("f1", 1500, "tarde").unwrap();
        let c1 = db.add_timeline_comment("f1", 200, "pronto").unwrap();
        assert!(db.add_timeline_comment("nope", 1, "x").is_err());
        let m = db.insert_media(&s.id, "/data/img.png").unwrap();

        let detail = db.get_session_detail(&s.id).unwrap();
        assert_eq!(detail.fragments.len(), 2);
        assert_eq!(detail.fragments[0].id, "f1");
        let ts: Vec<u64> = detail.fragments[0].comments.iter().map(|c| c.timestamp_ms).collect();
        assert_eq!(ts, vec![200, 1500]);
        assert_eq!(detail.fragments[0].comments[0].id, c1.id);
        assert_eq!(detail.media.len(), 1);
        assert_eq!(db.get_fragment("f1").unwrap().comments.len(), 2);

        db.update_fragment_meta("f2", "Dos bis", "nueva").unwrap();
        let f2b = db.get_fragment("f2").unwrap();
        assert_eq!((f2b.title.as_str(), f2b.explanation.as_str()), ("Dos bis", "nueva"));

        db.delete_timeline_comment(&c2.id).unwrap();
        assert_eq!(db.get_fragment("f1").unwrap().comments.len(), 1);

        // Simula que f1 y la media ya estaban en Drive.
        db.mark_entity_synced(ENTITY_MIDI_FRAGMENT, "f1", Some("drive-f1")).unwrap();
        db.mark_entity_synced(ENTITY_MEDIA_IMAGE, &m.id, Some("drive-m")).unwrap();
        db.mark_entity_synced(ENTITY_RAW_MIDI, &s.id, Some("drive-raw")).unwrap();

        let mut paths = db.delete_session(&s.id).unwrap();
        paths.sort();
        assert_eq!(paths, vec!["/data/f1.mid", "/data/f2.mid", "/data/img.png", "/data/raw.mid"]);
        assert!(db.get_session(&s.id).is_err());
        assert!(db.get_fragment("f1").is_err());
        {
            let conn = db.lock().unwrap();
            for table in ["midi_fragments", "timeline_comments", "session_media"] {
                let n: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                    .unwrap();
                assert_eq!(n, 0, "{table} debería quedar vacía");
            }
        }
        let items = db.pending_sync_items(100).unwrap();
        let deletes: Vec<_> = items.iter().filter(|i| i.action == ACTION_DELETE).collect();
        assert_eq!(deletes.len(), 3);
        assert!(deletes
            .iter()
            .any(|d| d.entity_type == ENTITY_MIDI_FRAGMENT && d.payload_path.as_deref() == Some("drive-f1")));
        assert!(deletes
            .iter()
            .any(|d| d.entity_type == ENTITY_MEDIA_IMAGE && d.payload_path.as_deref() == Some("drive-m")));
        assert!(deletes
            .iter()
            .any(|d| d.entity_type == ENTITY_RAW_MIDI && d.payload_path.as_deref() == Some("drive-raw")));
        // No quedan subidas pendientes de entidades borradas.
        assert!(items
            .iter()
            .all(|i| i.action == ACTION_DELETE || i.entity_type == ENTITY_DB_SNAPSHOT));
        assert!(db.get_setting(&drive_file_setting_key(ENTITY_RAW_MIDI, &s.id)).unwrap().is_none());
    }

    #[test]
    fn delete_fragment_returns_path_and_enqueues_delete() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        db.insert_fragment("f1", &s.id, "Uno", "", "/data/f1.mid", 100, 2000).unwrap();
        db.add_timeline_comment("f1", 10, "c").unwrap();
        // Sin drive_file_id: no encola DELETE y retira la subida pendiente.
        assert_eq!(db.delete_fragment("f1").unwrap(), "/data/f1.mid");
        assert!(queue_of(&db, ENTITY_MIDI_FRAGMENT).is_empty());

        db.insert_fragment("f2", &s.id, "Dos", "", "/data/f2.mid", 100, 2000).unwrap();
        db.mark_entity_synced(ENTITY_MIDI_FRAGMENT, "f2", Some("drive-f2")).unwrap();
        assert_eq!(db.get_fragment("f2").unwrap().sync_status, SYNC_SYNCED);
        assert_eq!(db.get_drive_file_id(ENTITY_MIDI_FRAGMENT, "f2").unwrap().as_deref(), Some("drive-f2"));
        let up = queue_of(&db, ENTITY_MIDI_FRAGMENT);
        db.complete_sync_item(up[0].id).unwrap();
        db.delete_fragment("f2").unwrap();
        let q = queue_of(&db, ENTITY_MIDI_FRAGMENT);
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].action, ACTION_DELETE);
        assert_eq!(q[0].entity_id, "f2");
        assert_eq!(q[0].payload_path.as_deref(), Some("drive-f2"));
        assert!(db.delete_fragment("f2").is_err());
    }

    #[test]
    fn sync_queue_registration_and_snapshot_dedupe() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        db.update_session(&s.id, "S2", 100, "").unwrap();
        db.insert_fragment("f1", &s.id, "Uno", "", "/data/f1.mid", 100, 2000).unwrap();
        let m = db.insert_media(&s.id, "/data/img.jpg").unwrap();
        db.enqueue_sync(ENTITY_DB_SNAPSHOT, SNAPSHOT_ENTITY_ID, ACTION_UPLOAD, None).unwrap();

        let items = db.pending_sync_items(100).unwrap();
        // FIFO por id.
        assert!(items.windows(2).all(|w| w[0].id < w[1].id));
        assert_eq!(queue_of(&db, ENTITY_DB_SNAPSHOT).len(), 1, "DB_SNAPSHOT deduplicado");
        let frag = queue_of(&db, ENTITY_MIDI_FRAGMENT);
        assert_eq!(frag.len(), 1);
        assert_eq!((frag[0].entity_id.as_str(), frag[0].action.as_str()), ("f1", ACTION_UPLOAD));
        assert_eq!(frag[0].payload_path.as_deref(), Some("/data/f1.mid"));
        let media = queue_of(&db, ENTITY_MEDIA_IMAGE);
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].entity_id, m.id);
        assert_eq!(media[0].payload_path.as_deref(), Some("/data/img.jpg"));
        assert_eq!(db.sync_counts().unwrap(), (3, 0));
        assert_eq!(db.pending_sync_items(1).unwrap().len(), 1);

        // Tras completar el snapshot, un cambio nuevo vuelve a encolar uno.
        let snap = queue_of(&db, ENTITY_DB_SNAPSHOT);
        db.complete_sync_item(snap[0].id).unwrap();
        assert!(queue_of(&db, ENTITY_DB_SNAPSHOT).is_empty());
        db.update_session(&s.id, "S3", 100, "").unwrap();
        assert_eq!(queue_of(&db, ENTITY_DB_SNAPSHOT).len(), 1);
    }

    #[test]
    fn fail_complete_and_error_counts() {
        let db = db();
        db.enqueue_sync(ENTITY_MIDI_FRAGMENT, "f1", ACTION_UPLOAD, Some("/x.mid")).unwrap();
        db.enqueue_sync(ENTITY_MEDIA_IMAGE, "m1", ACTION_UPLOAD, Some("/x.png")).unwrap();
        let items = db.pending_sync_items(10).unwrap();
        assert_eq!(items.len(), 2);

        db.fail_sync_item(items[0].id, "HTTP 400").unwrap();
        let it = db.get_sync_item(items[0].id).unwrap().unwrap();
        assert_eq!(it.retry_count, 1);
        assert_eq!(it.last_error.as_deref(), Some("HTTP 400"));
        for _ in 0..4 {
            db.fail_sync_item(items[0].id, "HTTP 400").unwrap();
        }
        assert_eq!(db.sync_counts().unwrap(), (1, 1));
        let pending = db.pending_sync_items(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, items[1].id);

        // Fallos de red: nunca alcanzan MAX_RETRIES.
        for _ in 0..10 {
            db.defer_sync_item(items[1].id, "sin red").unwrap();
        }
        assert_eq!(db.get_sync_item(items[1].id).unwrap().unwrap().retry_count, MAX_RETRIES - 1);
        assert_eq!(db.sync_counts().unwrap(), (1, 1));

        db.complete_sync_item(items[1].id).unwrap();
        assert_eq!(db.sync_counts().unwrap(), (0, 1));
        assert!(db.pending_sync_items(10).unwrap().is_empty());
    }

    #[test]
    fn mark_synced_and_error_update_entities() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        db.insert_fragment("f1", &s.id, "Uno", "", "/data/f1.mid", 100, 2000).unwrap();
        let path = std::env::temp_dir().join(format!("pt_snap_{}.sqlite", uuid::Uuid::new_v4()));

        for item in db.pending_sync_items(100).unwrap() {
            match item.entity_type.as_str() {
                ENTITY_MIDI_FRAGMENT => {
                    // Orden del worker: completar el elemento y luego marcar la entidad.
                    db.complete_sync_item(item.id).unwrap();
                    db.mark_entity_synced(ENTITY_MIDI_FRAGMENT, "f1", Some("d1")).unwrap();
                }
                ENTITY_DB_SNAPSHOT => {
                    db.snapshot_for_sync(item.id, &path).unwrap();
                    // La sesión aún no está SYNCED hasta marcar el snapshot.
                    db.mark_entity_synced(ENTITY_DB_SNAPSHOT, SNAPSHOT_ENTITY_ID, Some("snap")).unwrap();
                }
                _ => {}
            }
        }
        let _ = std::fs::remove_file(&path);
        assert_eq!(db.sync_counts().unwrap(), (0, 0));
        assert_eq!(db.get_session(&s.id).unwrap().sync_status, SYNC_SYNCED);
        assert_eq!(db.get_drive_file_id(ENTITY_DB_SNAPSHOT, "x").unwrap().as_deref(), Some("snap"));

        // Fallo del snapshot tras reclamarlo: se reencola con su contador.
        db.requeue_snapshot(2, "sin red").unwrap();
        let snap = queue_of(&db, ENTITY_DB_SNAPSHOT);
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].retry_count, 2);

        db.mark_entity_error(ENTITY_MIDI_FRAGMENT, "f1").unwrap();
        assert_eq!(db.get_fragment("f1").unwrap().sync_status, SYNC_ERROR);
        assert!(db.entity_exists(ENTITY_MIDI_FRAGMENT, "f1").unwrap());
        assert!(!db.entity_exists(ENTITY_MEDIA_IMAGE, "zz").unwrap());
        assert!(db.mark_entity_synced("FOO", "x", None).is_err());
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

    #[test]
    fn file_db_and_backup_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("sub").join("piano_tracker.sqlite");
        {
            let db = Database::open(&db_path).unwrap();
            let s = db.create_session("Persistente", 80).unwrap();
            db.insert_fragment("f1", &s.id, "Uno", "", "/data/f1.mid", 80, 1000).unwrap();
            let backup = dir.path().join("piano_tracker_backup.sqlite");
            db.backup_to(&backup).unwrap();
            // Segunda copia sobre la existente (rename atómico).
            db.backup_to(&backup).unwrap();
            assert!(!dir.path().join("piano_tracker_backup.sqlite.tmp").exists());

            let copy = Connection::open(&backup).unwrap();
            let title: String = copy.query_row("SELECT title FROM sessions", [], |r| r.get(0)).unwrap();
            assert_eq!(title, "Persistente");
            let n: i64 = copy.query_row("SELECT COUNT(*) FROM midi_fragments", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
            let v: i64 = copy.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(v, SCHEMA_VERSION);
        }
        // Reapertura: migraciones idempotentes y datos conservados.
        let db = Database::open(&db_path).unwrap();
        assert_eq!(db.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn in_memory_backup_works() {
        let db = db();
        db.create_session("M", 60).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("b.sqlite");
        db.backup_to(&dest).unwrap();
        let copy = Connection::open(&dest).unwrap();
        let n: i64 = copy.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn database_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Database>();
    }
}
