# Technical Specification: Piano Practice Tracker (Tauri v2 + Angular)

## 1. Visión General del Sistema
Aplicación de escritorio nativa para **Ubuntu Linux** orientada al registro, recorte y análisis de sesiones diarias de práctica de piano mediante conexión USB-MIDI, con reproducción interna por sintetizador SoundFont (`.sf2`), comentarios anclados a la línea de tiempo, notas en Markdown con imágenes y respaldo automático *offline-first* en Google Drive.

### 1.1. Decisiones de Diseño Consolidadas
1. **Recorte Destructivo sobre Pista Bruta (Slicing):**
   - Cada sesión permite grabar una pista larga continua (`raw_session_<id>.mid`, ej. 20-30 minutos).
   - El usuario visualiza bloques de actividad MIDI (zonas con notas vs. silencios) en la línea de tiempo.
   - Al seleccionar un rango $[t_{start}, t_{end}]$ y extraerlo como un **Fragmento**, el motor en Rust crea un nuevo archivo independiente (`frag_<uuid>.mid`) ajustado a $t = 0$ y **elimina ese tramo del archivo bruto de la sesión**, desplazando los eventos posteriores para cerrar el hueco. También permite descartar rangos de silencio o errores directamente de la pista bruta.
2. **Monitoreo de Audio y Metrónomo:**
   - Durante la grabación, el metrónomo suena a través del motor de audio de la app (`cpal`).
   - El monitoreo en vivo del sintetizador de piano durante la grabación es **opcional** (desactivado por defecto para que el usuario escuche su propio piano digital sin latencia; activable mediante un interruptor en la UI).
   - Durante la reproducción de fragmentos o de la pista bruta, el motor interno (`rustysynth`) sintetiza el archivo `.mid` en tiempo real usando un archivo SoundFont (`.sf2`).
3. **Visualización de Actividad en Línea de Tiempo:**
   - El backend analiza cualquier archivo `.mid` y devuelve un vector de densidad de notas por intervalos de tiempo (buckets) para dibujar bloques visuales de actividad en el reproductor/recortador.

---

## 2. Stack Tecnológico y Dependencias

### 2.1. Requisitos del Sistema (Ubuntu Linux)
Paquetes nativos requeridos para compilar Tauri v2 y el subsistema de audio/MIDI (ALSA):
- `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `pkg-config`
- `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libwebkit2gtk-4.1-dev`
- `libasound2-dev` (requerido por `midir` y `cpal` en Linux)

### 2.2. Backend: Rust (Tauri v2)
- **Framework:** `tauri = "2"`, `tauri-plugin-fs`, `tauri-plugin-dialog`, `tauri-plugin-shell`
- **Serialización y Async:** `serde`, `serde_json`, `tokio` (features: `full`), `uuid` (features: `v4`), `chrono`
- **MIDI Input/Output:** `midir = "0.10"` (lectura de puertos ALSA MIDI en hilo dedicado)
- **MIDI Parsing y Slicing:** `midly = "0.5"` (lectura, manipulación de ticks/tempos y escritura SMF)
- **Audio y Sintetizador:**
  - `cpal = "0.15"` (salida de audio de baja latencia hacia ALSA/PipeWire)
  - `rustysynth = "1.3"` (sintetizador SoundFont `.sf2` puro en Rust, sin dependencias en C)
- **Base de Datos:** `rusqlite = { version = "0.31", features = ["bundled"] }`
- **Google Drive Sync & OAuth2:** `reqwest = { version = "0.12", features = ["json", "multipart", "stream"] }`, `url`, `sha2`, `base64`

### 2.3. Frontend: Angular (v18+ Standalone)
- **Arquitectura:** Componentes *Standalone*, gestión de estado reactiva con **Angular Signals**, comunicación mediante `@tauri-apps/api/core` (`invoke`) y `@tauri-apps/api/event` (`listen`).
- **Estilos:** TailwindCSS (modo oscuro por defecto, estética de estudio musical/DAW).
- **Markdown:** Renderizado con `marked` + soporte de interceptación del evento `paste` y `drop` para guardar imágenes localmente vía Tauri IPC y reemplazarlas con rutas locales resolubles.
- **Visualización de Línea de Tiempo:** Componente personalizado en HTML5 `<canvas>` + superposición DOM para pins de comentarios, popups flotantes y selectores de rango de recorte (handles de inicio/fin).

---

## 3. Modelo de Base de Datos (SQLite)

Ruta de almacenamiento local: `~/.local/share/piano-tracker/piano_tracker.sqlite`
Directorios locales gestionados:
- `~/.local/share/piano-tracker/midi/raw/` (pistas brutas de sesión)
- `~/.local/share/piano-tracker/midi/fragments/` (fragmentos recortados)
- `~/.local/share/piano-tracker/media/` (imágenes de notas Markdown)
- `~/.local/share/piano-tracker/assets/default_piano.sf2` (SoundFont de piano)

### 3.1. Esquema SQL Completo

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    session_date TEXT NOT NULL,
    bpm INTEGER NOT NULL DEFAULT 120,
    raw_midi_path TEXT,
    raw_duration_ms INTEGER NOT NULL DEFAULT 0,
    markdown_notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'PENDING' -- 'PENDING', 'SYNCED', 'ERROR'
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
    entity_type TEXT NOT NULL, -- 'MIDI_FRAGMENT', 'MEDIA_IMAGE', 'DB_SNAPSHOT'
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,      -- 'UPLOAD', 'UPDATE', 'DELETE'
    payload_path TEXT,
    created_at TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

---

## 4. Especificación de Motores en Rust

### 4.1. Motor de Captura MIDI (`midi_recorder.rs`)
- Lista puertos de entrada usando `midir::MidiInput`.
- Al iniciar grabación:
  - Abre conexión con el puerto seleccionado.
  - Registra `Instant::now()` como referencia $t_0$ (o reanuda acumulando el offset si ya existe una pista bruta en la sesión).
  - Cada mensaje MIDI entrante (`NoteOn`, `NoteOff`, `ControlChange`) se almacena en memoria con su timestamp en microsegundos junto con el BPM activo.
  - Si `live_synth_enabled == true`, reenvía el mensaje inmediatamente al hilo del sintetizador `rustysynth`.
- Al detener grabación:
  - Inyecta `NoteOff` para cualquier nota abierta y `CC 64 = 0` (Sustain Off).
  - Escribe un archivo Standard MIDI File (SMF formato 0, resolución 480 ticks por negra) usando `midly`, inyectando el meta-evento `Tempo` correspondiente al BPM de la sesión.

### 4.2. Motor de Recorte y Análisis MIDI (`midi_slicer.rs`)
1. **Análisis de Densidad (`analyze_midi_activity`):**
   - Lee el archivo `.mid`, convierte los deltas de ticks a milisegundos reales según el tempo.
   - Divide la duración total en segmentos (hasta 200 bloques) y devuelve `Vec<ActivityBlock { start_ms, end_ms, note_count, velocity_avg }>`.
2. **Extracción y Recorte Destructivo (`extract_fragment_and_trim`):**
   - Recibe `source_path`, `start_ms`, `end_ms`, `output_fragment_path`.
   - **Creación del Fragmento ($[start\_ms, end\_ms]$):**
     - Rastrea el estado del pedal de sustain (`CC 64`) inmediatamente anterior a `start_ms`. Si estaba pisado, inyecta `CC 64` en $t = 0$ del nuevo fragmento.
     - Copia todos los eventos dentro de $[start\_ms, end\_ms]$ desplazando sus tiempos a $t' = t - start\_ms$.
     - Al llegar a `end_ms`, cierra todas las notas activas con `NoteOff` y pone `CC 64 = 0`.
     - Guarda en `output_fragment_path`.
   - **Recorte Destructivo en Pista Bruta:**
     - Elimina del archivo maestro `source_path` los eventos en $[start\_ms, end\_ms]$.
     - Asegura que las notas que empezaron antes de `start_ms` reciban `NoteOff` en `start_ms`.
     - Desplaza todos los eventos con $t > end\_ms$ restando $(end\_ms - start\_ms)$.
     - Sobrescribe `source_path` de forma atómica y actualiza `raw_duration_ms` en la tabla `sessions`.

### 4.3. Motor de Audio, Sintetizador y Metrónomo (`audio_engine.rs`)
- Ejecuta un flujo de salida `cpal::Stream` constante (ej. $44100\text{ Hz}$ estéreo).
- Carga el archivo SoundFont `.sf2` en `rustysynth::Synthesizer`. Si no existe un `.sf2` en `~/.local/share/piano-tracker/assets/`, el sistema genera o descarga automáticamente un SoundFont compacto de piano en el arranque.
- **Metrónomo Integrado:** Generador de onda sinusoidal con envolvente exponencial corta ($880\text{ Hz}$ para el primer pulso del compás, $440\text{ Hz}$ para los demás) sincronizado por muestras de audio según el BPM activo.
- **Reproductor MIDI Interno:**
  - Lee los eventos del `.mid` seleccionado, avanza el reloj en función de los frames de audio consumidos por `cpal`, alimenta `rustysynth` y emite cada $50\text{ ms}$ un evento Tauri `playback-progress` con `{ file_path, current_ms, duration_ms, is_playing }`.
  - Soporta `play`, `pause`, `stop` y `seek(ms)` (enviando `reset_all_controllers` y `note_off_all` al hacer seek).

### 4.4. Sincronización Offline-First con Google Drive (`drive_sync.rs`)
- **OAuth 2.0 Loopback Flow:**
  - Lee `client_id` y `client_secret` configurados en `app_settings` (con interfaz en Ajustes para que el usuario introduzca sus credenciales de Google Cloud Console).
  - Al pulsar "Conectar Google Drive", levanta un servidor TCP local en `127.0.0.1:0`, abre el navegador del sistema con la URL de autorización (`scope: https://www.googleapis.com/auth/drive.file`), captura el código OAuth, canjea el `access_token` y `refresh_token`, y los guarda en `app_settings`.
- **Estructura en Drive:**
  - Busca o crea la carpeta raíz `PianoTracker` y subcarpetas `midi` y `media`.
- **Worker de Cola (`sync_worker`):**
  - Bucle `tokio::spawn` que se ejecuta cada 15 segundos o al recibir una notificación de cambio.
  - Procesa registros de `sync_queue` en orden FIFO.
  - Si hay conexión y credenciales válidas, sube o actualiza los archivos `.mid`, las imágenes `.png/.jpg` y el snapshot de `piano_tracker_backup.sqlite`.
  - Si falla por falta de red, incrementa `retry_count` y mantiene el estado en `PENDING` sin bloquear la app.

---

## 5. Contrato IPC (Comandos Tauri)

### Dispositivos MIDI y Grabación
- `list_midi_ports() -> Result<Vec<MidiPortInfo>, String>`
- `start_recording(session_id: String, port_id: String, bpm: u32, metronome_on: bool, live_synth_on: bool) -> Result<(), String>`
- `update_live_recording_settings(bpm: u32, metronome_on: bool, live_synth_on: bool) -> Result<(), String>`
- `stop_recording(session_id: String) -> Result<SessionDto, String>`

### Recorte y Reproducción
- `get_midi_activity(file_path: String) -> Result<MidiActivityDto, String>`
- `extract_midi_fragment(req: ExtractFragmentReq) -> Result<FragmentCreatedResponse, String>`
- `discard_midi_range(session_id: String, start_ms: u64, end_ms: u64) -> Result<SessionDto, String>`
- `play_midi_file(file_path: String, start_ms: u64) -> Result<(), String>`
- `pause_midi_playback() -> Result<(), String>`
- `seek_midi_playback(ms: u64) -> Result<(), String>`
- `stop_midi_playback() -> Result<(), String>`

### Sesiones, Fragmentos y Comentarios
- `get_sessions() -> Result<Vec<SessionSummaryDto>, String>`
- `get_session_detail(session_id: String) -> Result<SessionDetailDto, String>`
- `create_session(title: String, bpm: u32) -> Result<SessionDetailDto, String>`
- `update_session(session_id: String, title: String, bpm: u32, markdown_notes: String) -> Result<(), String>`
- `delete_session(session_id: String) -> Result<(), String>`
- `save_session_image(session_id: String, file_name: String, base64_data: String) -> Result<String, String>`
- `update_fragment_meta(fragment_id: String, title: String, explanation: String) -> Result<(), String>`
- `delete_fragment(fragment_id: String) -> Result<(), String>`
- `add_timeline_comment(fragment_id: String, timestamp_ms: u64, content: String) -> Result<TimelineCommentDto, String>`
- `delete_timeline_comment(comment_id: String) -> Result<(), String>`

### Sincronización Google Drive
- `save_google_credentials(client_id: String, client_secret: String) -> Result<(), String>`
- `start_google_auth() -> Result<String, String>`
- `get_sync_status() -> Result<SyncStatusDto, String>`
- `trigger_sync_now() -> Result<SyncStatusDto, String>`

---

## 6. Diseño de Interfaz de Usuario (Angular UI/UX)

1. **Barra Lateral Izquierda (Navegación y Estado):**
   - Botón "+ Nueva Sesión de Práctica".
   - Lista cronológica de sesiones con indicador de estado de sincronización (icono nube verde `SYNCED`, ámbar `PENDING`, gris `OFFLINE`).
   - Selector rápido de puerto USB-MIDI y botón de Ajustes / Cuenta de Google Drive en el pie de la barra.
2. **Cabecera de Sesión y Panel de Grabación / Metrónomo:**
   - Título editable de la sesión y fecha.
   - Controles de Metrónomo: Selector numérico/slider de BPM ($40 - 240$), botón de activar claqueta, switch de monitoreo de sintetizador en vivo, y botón principal **Grabar / Detener** con cronómetro en vivo.
3. **Zona de Pista Bruta y Recortador (Slicer):**
   - Visible cuando la sesión tiene una grabación maestra (`raw_midi_path`).
   - Línea de tiempo interactiva con bloques visuales de actividad MIDI.
   - Controles de selección de rango (Inicio `mm:ss` - Fin `mm:ss`) arrastrables en el canvas.
   - Botones de acción sobre el rango seleccionado:
     - **"Extraer como Fragmento"** (abre modal/formulario rápido para título y explicación inicial, crea el fragmento y recorta la pista maestra).
     - **"Descartar Selección"** (elimina silencios o tomas fallidas de la pista maestra).
4. **Lista de Fragmentos de la Sesión + Comentarios en Línea de Tiempo:**
   - Tarjetas expandibles por cada fragmento extraído.
   - Cada tarjeta incluye:
     - Título, BPM, duración y texto explicativo general del fragmento.
     - **Reproductor de Línea de Tiempo con Marcadores (Pins):** Muestra la barra de progreso y marcadores en los segundos exactos donde hay comentarios. Al pasar el ratón por un pin o cuando la reproducción pasa por ese segundo, aparece un **popup flotante** sobre la línea de tiempo con el comentario.
     - **Formulario rápido "+ Añadir comentario en el segundo actual (`mm:ss`)"**.
     - **Panel lateral derecho dentro de la tarjeta:** Lista ordenada cronológicamente con todos los comentarios del fragmento. Hacer clic en cualquier comentario salta (`seek`) automáticamente a ese instante.
5. **Editor de Notas de la Sesión (Markdown + Imágenes):**
   - Pestaña o panel dividido (Edición / Vista Previa / Split) para escribir apuntes generales de la sesión en Markdown.
   - Soporta pegar imágenes del portapapeles (`Ctrl+V`) o arrastrarlas; las guarda en disco, las registra en `session_media` + `sync_queue` y las renderiza en la vista previa.