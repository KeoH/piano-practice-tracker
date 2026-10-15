//! Persistencia en SQLite dentro de la bóveda.
//!
//! - Esquema versionado con `PRAGMA user_version`.
//!   - v1: esquema original de SPECIFICATIONS.md §3.1 (con columnas y cola de Google Drive).
//!   - v2: sin sincronización con Drive y con rutas relativas a la bóveda.
//! - Las rutas de ficheros (`raw_midi_path`, `file_path`, `local_path`) se guardan **relativas a
//!   la raíz de la bóveda** y la API pública las devuelve absolutas. Así la bóveda se puede mover
//!   o sincronizar entre equipos (Dropbox, Syncthing…) sin romper referencias.
//! - `journal_mode = DELETE`: en reposo la base de datos es un único fichero, sin `-wal`/`-shm`,
//!   lo que evita que un servicio de sincronización suba un estado a medias.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use chrono::{Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::{FragmentDto, SessionDetailDto, SessionDto, SessionMediaDto, SessionSummaryDto, TimelineCommentDto};
use crate::paths::relative_to;

const SCHEMA_VERSION: i64 = 2;

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

/// v2: fuera Google Drive (cola, estados e ids remotos). Las rutas se reescriben aparte.
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

/// Subrutas de la bóveda que identifican cada tipo de fichero al convertir rutas antiguas.
const RAW_MARKER: &str = "/midi/raw/";
const FRAGMENT_MARKER: &str = "/midi/fragments/";
const MEDIA_MARKER: &str = "/media/";

const SESSION_COLS: &str =
    "id, title, session_date, bpm, raw_midi_path, raw_duration_ms, markdown_notes, updated_at";
const FRAGMENT_COLS: &str =
    "id, session_id, title, explanation, file_path, bpm, duration_ms, order_index, created_at";
const COMMENT_COLS: &str = "id, fragment_id, timestamp_ms, content, created_at";
const MEDIA_COLS: &str = "id, session_id, local_path";

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
    Ok(SessionMediaDto { id: r.get(0)?, session_id: r.get(1)?, local_path: r.get(2)? })
}

// ---------------------------------------------------------------------------
// Funciones internas sobre una conexión (permiten componerlas en transacciones)
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

/// Convierte una ruta absoluta de la versión anterior en relativa a la bóveda buscando la
/// subruta que identifica su tipo (`/midi/raw/`, …). Devuelve `(relativa, base_antigua)`.
fn legacy_to_relative(path: &str, marker: &str) -> Option<(String, String)> {
    if !path.starts_with('/') {
        return None;
    }
    let idx = path.rfind(marker)?;
    Some((path[idx + 1..].to_string(), path[..idx].to_string()))
}

/// Paso de datos de la migración v2: rutas absolutas → relativas, también en el Markdown.
/// `extra_bases` son directorios donde pudieron vivir los datos (la raíz actual de la bóveda).
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

    // Las imágenes del Markdown llevaban la ruta absoluta: se quita el prefijo de la base.
    // Primero las bases más largas, por si una contiene a otra.
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
// API pública
// ---------------------------------------------------------------------------

/// Base de datos SQLite compartible entre hilos (`Arc<Database>`).
pub struct Database {
    conn: Mutex<Connection>,
    /// Raíz de la bóveda: las rutas relativas guardadas se resuelven contra ella.
    root: PathBuf,
}

impl Database {
    /// Abre (o crea) el fichero, activa claves foráneas, fija `journal_mode = DELETE` y aplica
    /// migraciones. `root` es la raíz de la bóveda.
    pub fn open(path: &Path, root: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| t!("backend.io.createDir", path = parent.display(), e = e))?;
            }
        }
        let conn = Connection::open(path)
            .map_err(|e| t!("backend.db.openFailed", path = path.display(), e = e))?;
        // Si venía en WAL (versión anterior), este cambio hace checkpoint y borra -wal/-shm.
        let mode: String = conn
            .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
            .map_err(|e| t!("backend.db.prepareFailed", path = path.display(), e = e))?;
        if !mode.eq_ignore_ascii_case("delete") {
            log::warn!("La base de datos sigue en modo de diario '{mode}'");
        }
        Self::init(conn, root)
    }

    /// Base de datos en memoria (tests). Las rutas relativas se resuelven contra `root`.
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

    /// Ruta a guardar: relativa a la bóveda si está dentro de ella; si no, tal cual.
    fn store_path(&self, path: &str) -> String {
        relative_to(&self.root, Path::new(path)).unwrap_or_else(|| path.to_string())
    }

    /// Ruta absoluta para una ruta guardada.
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

    fn fix_media(&self, mut m: SessionMediaDto) -> SessionMediaDto {
        m.local_path = self.load_path(m.local_path);
        m
    }

    // ----------------------------- Sesiones -----------------------------

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

        Ok(SessionDetailDto { session, fragments, media })
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

    /// Borra la sesión en cascada y devuelve las rutas absolutas a eliminar por el llamador.
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
        ] {
            let mut stmt = tx.prepare(sql).map_err(db_err)?;
            let rows = stmt.query_map(params![session_id], |r| r.get::<_, String>(0)).map_err(db_err)?;
            paths.extend(rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?);
        }
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(paths.into_iter().map(|p| self.load_path(p)).collect())
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

    /// Borra el fragmento y devuelve su ruta absoluta para que el llamador borre el fichero.
    pub fn delete_fragment(&self, fragment_id: &str) -> Result<String, String> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(db_err)?;
        let frag = fetch_fragment(&tx, fragment_id)?;
        tx.execute("DELETE FROM midi_fragments WHERE id = ?1", params![fragment_id]).map_err(db_err)?;
        touch_session(&tx, &frag.session_id)?;
        tx.commit().map_err(db_err)?;
        Ok(self.load_path(frag.file_path))
    }

    // ----------------------------- Comentarios -----------------------------

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

    // ----------------------------- Ajustes -----------------------------

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

    // ----------------------------- Copias -----------------------------

    /// Copia consistente de la base de datos (`VACUUM INTO` a temporal + rename atómico).
    pub fn backup_to(&self, dest: &Path) -> Result<(), String> {
        let conn = self.lock()?;
        backup_in(&conn, dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "/boveda";

    fn db() -> Database {
        Database::open_in_memory(Path::new(ROOT)).unwrap()
    }

    fn stored(db: &Database, sql: &str) -> String {
        db.lock().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn create_and_list_sessions() {
        let db = db();
        let a = db.create_session("Escalas", 90).unwrap();
        let b = db.create_session("Chopin", 60).unwrap();
        assert_eq!(a.session_date, today());
        assert_eq!(a.bpm, 90);
        assert!(a.raw_midi_path.is_none());
        assert!(chrono::DateTime::parse_from_rfc3339(&a.updated_at).is_ok());

        db.insert_fragment("f1", &a.id, "Frag", "", "/boveda/midi/fragments/f1.mid", 90, 1000).unwrap();
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
    fn paths_are_stored_relative_and_returned_absolute() {
        let db = db();
        let s = db.create_session("S", 120).unwrap();
        let updated = db.set_session_raw_midi(&s.id, "/boveda/midi/raw/raw.mid", 5000).unwrap();
        assert_eq!(updated.raw_midi_path.as_deref(), Some("/boveda/midi/raw/raw.mid"));
        assert_eq!(updated.raw_duration_ms, 5000);
        assert_eq!(stored(&db, "SELECT raw_midi_path FROM sessions"), "midi/raw/raw.mid");

        let f = db.insert_fragment("f1", &s.id, "Uno", "", "/boveda/midi/fragments/f1.mid", 100, 1).unwrap();
        assert_eq!(f.file_path, "/boveda/midi/fragments/f1.mid");
        assert_eq!(stored(&db, "SELECT file_path FROM midi_fragments"), "midi/fragments/f1.mid");

        let m = db.insert_media(&s.id, "/boveda/media/a.png").unwrap();
        assert_eq!(m.local_path, "/boveda/media/a.png");
        assert_eq!(stored(&db, "SELECT local_path FROM session_media"), "media/a.png");

        let d = db.get_session_detail(&s.id).unwrap();
        assert_eq!(d.session.raw_midi_path.as_deref(), Some("/boveda/midi/raw/raw.mid"));
        assert_eq!(d.fragments[0].file_path, "/boveda/midi/fragments/f1.mid");
        assert_eq!(d.media[0].local_path, "/boveda/media/a.png");

        // Una ruta fuera de la bóveda se conserva tal cual.
        db.set_session_raw_midi(&s.id, "/otra/raw.mid", 1).unwrap();
        assert_eq!(db.get_session(&s.id).unwrap().raw_midi_path.as_deref(), Some("/otra/raw.mid"));
    }

    #[test]
    fn fragments_comments_and_cascade_delete() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        db.set_session_raw_midi(&s.id, "/boveda/midi/raw/raw.mid", 10_000).unwrap();
        let f1 = db.insert_fragment("f1", &s.id, "Uno", "exp", "/boveda/midi/fragments/f1.mid", 100, 2000).unwrap();
        let f2 = db.insert_fragment("f2", &s.id, "Dos", "", "/boveda/midi/fragments/f2.mid", 100, 3000).unwrap();
        assert_eq!(f1.order_index, 0);
        assert_eq!(f2.order_index, 1);
        assert!(db.insert_fragment("fx", "nope", "x", "", "/x.mid", 1, 1).is_err());

        let c2 = db.add_timeline_comment("f1", 1500, "tarde").unwrap();
        let c1 = db.add_timeline_comment("f1", 200, "pronto").unwrap();
        assert!(db.add_timeline_comment("nope", 1, "x").is_err());
        db.insert_media(&s.id, "/boveda/media/img.png").unwrap();

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
        assert!(db.delete_timeline_comment("nope").is_err());

        let mut paths = db.delete_session(&s.id).unwrap();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "/boveda/media/img.png",
                "/boveda/midi/fragments/f1.mid",
                "/boveda/midi/fragments/f2.mid",
                "/boveda/midi/raw/raw.mid"
            ]
        );
        assert!(db.get_session(&s.id).is_err());
        assert!(db.get_fragment("f1").is_err());
        let conn = db.lock().unwrap();
        for table in ["midi_fragments", "timeline_comments", "session_media"] {
            let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table} debería quedar vacía");
        }
    }

    #[test]
    fn delete_fragment_returns_absolute_path() {
        let db = db();
        let s = db.create_session("S", 100).unwrap();
        db.insert_fragment("f2", &s.id, "Dos", "", "/boveda/midi/fragments/f2.mid", 100, 3000).unwrap();
        assert_eq!(db.delete_fragment("f2").unwrap(), "/boveda/midi/fragments/f2.mid");
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

    /// Crea una base de datos v1 (versión con Google Drive) con rutas absolutas en WAL.
    fn create_v1(path: &Path, old_base: &str) {
        let conn = Connection::open(path).unwrap();
        conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0)).unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch("PRAGMA user_version = 1;").unwrap();
        let md = format!(
            "Hola\n![foto]({old_base}/media/abc_foto.png)\n![otra](<{old_base}/media/con espacio.png>)\n![web](https://x.org/a.png)"
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
            params![format!("{old_base}/media/abc_foto.png")],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_queue (entity_type, entity_id, action, created_at) VALUES ('DB_SNAPSHOT', 'x', 'UPLOAD', 'now')",
            [],
        )
        .unwrap();
        for (k, v) in [("google_refresh_token", "t"), ("drive_file_id:DB_SNAPSHOT", "d"), ("drive_folder_root", "r"), ("otro", "v")] {
            conn.execute("INSERT INTO app_settings (key, value) VALUES (?1, ?2)", params![k, v]).unwrap();
        }
    }

    #[test]
    fn migrates_v1_to_relative_paths_without_drive() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("Bóveda");
        std::fs::create_dir_all(&vault).unwrap();
        let db_path = vault.join("piano_tracker.sqlite");
        let old_base = "/home/alguien/.local/share/piano-tracker";
        create_v1(&db_path, old_base);

        let db = Database::open(&db_path, &vault).unwrap();
        let v = vault.to_string_lossy();
        let d = db.get_session_detail("s1").unwrap();
        assert_eq!(d.session.raw_midi_path, Some(format!("{v}/midi/raw/raw_session_s1.mid")));
        assert_eq!(d.fragments[0].file_path, format!("{v}/midi/fragments/frag_f1.mid"));
        assert_eq!(d.media[0].local_path, format!("{v}/media/abc_foto.png"));
        assert_eq!(
            d.session.markdown_notes,
            "Hola\n![foto](media/abc_foto.png)\n![otra](<media/con espacio.png>)\n![web](https://x.org/a.png)"
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
            assert_eq!(n, 0, "{table}.{col} debería haberse eliminado");
        }
        let keys: Vec<String> = {
            let mut stmt = conn.prepare("SELECT key FROM app_settings").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(keys, vec!["otro".to_string()]);
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "delete");
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(conn);
        drop(db);
        assert!(!vault.join("piano_tracker.sqlite-wal").exists());
        assert!(!vault.join("piano_tracker.sqlite-shm").exists());

        // Reabrir es idempotente.
        let db = Database::open(&db_path, &vault).unwrap();
        assert_eq!(db.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn file_db_and_backup_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("sub").join("piano_tracker.sqlite");
        {
            let db = Database::open(&db_path, dir.path()).unwrap();
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
        let db = Database::open(&db_path, dir.path()).unwrap();
        assert_eq!(db.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn database_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Database>();
    }
}
