# Technical Specification: Piano Practice Tracker (Tauri v2 + Angular)

## 1. Visión General del Sistema
Aplicación de escritorio nativa para **Ubuntu Linux** orientada al registro, recorte y análisis de sesiones diarias de práctica de piano mediante conexión USB-MIDI, con reproducción interna por sintetizador SoundFont (`.sf2`), comentarios anclados a la línea de tiempo, notas en Markdown con imágenes y almacenamiento en una **bóveda**: una carpeta elegida por el usuario (al estilo de Obsidian) que contiene todos los datos. La app no sincroniza nada por su cuenta; si el usuario pone la bóveda dentro de Dropbox, Syncthing o similar, ese servicio hace la copia.

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
4. **Bóvedas en lugar de sincronización propia:**
   - Todos los datos (base de datos, MIDI e imágenes) viven en la carpeta de la bóveda, con rutas relativas a ella, para que pueda moverse o sincronizarse entre equipos.
   - La configuración propia del equipo (bóveda actual, recientes, SoundFont elegido, idioma) queda fuera, en `~/.config/piano-tracker/config.json`.
5. **Multi-idioma:**
   - La interfaz y los mensajes del backend están en inglés y español. Se usa el idioma del sistema si está disponible y, si no, inglés; el usuario puede elegirlo en Ajustes y en la pantalla de bienvenida.
   - Todos los textos están en `src/locales/<código>.json`, compartidos por Angular y Rust, para que añadir un idioma sea añadir un fichero.

---

## 2. Stack Tecnológico y Dependencias

### 2.1. Requisitos del Sistema (Ubuntu Linux)
Paquetes nativos requeridos para compilar Tauri v2 y el subsistema de audio/MIDI (ALSA):
- `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `pkg-config`
- `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libwebkit2gtk-4.1-dev`
- `libasound2-dev` (requerido por `midir` y `cpal` en Linux)

### 2.2. Backend: Rust (Tauri v2)
- **Framework:** `tauri = "2"` (feature `protocol-asset`), `tauri-plugin-fs`, `tauri-plugin-dialog`
- **Serialización:** `serde`, `serde_json`, `uuid` (features: `v4`), `chrono`, `base64` (imágenes pegadas en las notas)
- **MIDI Input/Output:** `midir = "0.10"` (lectura de puertos ALSA MIDI en hilo dedicado)
- **MIDI Parsing y Slicing:** `midly = "0.5"` (lectura, manipulación de ticks/tempos y escritura SMF)
- **Audio y Sintetizador:**
  - `cpal = "0.15"` (salida de audio de baja latencia hacia ALSA/PipeWire)
  - `rustysynth = "1.3"` (sintetizador SoundFont `.sf2` puro en Rust, sin dependencias en C)
- **Base de Datos:** `rusqlite = { version = "0.31", features = ["bundled"] }`

### 2.3. Frontend: Angular (v18+ Standalone)
- **Arquitectura:** Componentes *Standalone*, gestión de estado reactiva con **Angular Signals**, comunicación mediante `@tauri-apps/api/core` (`invoke`) y `@tauri-apps/api/event` (`listen`).
- **Estilos:** TailwindCSS (modo oscuro por defecto, estética de estudio musical/DAW).
- **Markdown:** Renderizado con `marked` + soporte de interceptación del evento `paste` y `drop` para guardar imágenes localmente vía Tauri IPC y reemplazarlas con rutas locales resolubles.
- **Visualización de Línea de Tiempo:** Componente personalizado en HTML5 `<canvas>` + superposición DOM para pins de comentarios, popups flotantes y selectores de rango de recorte (handles de inicio/fin).

---

## 3. Modelo de Base de Datos (SQLite)

Estructura de una bóveda (`<Bóveda>` es la carpeta elegida por el usuario):
- `<Bóveda>/.piano-tracker/vault.json` (marcador de bóveda) y `.piano-tracker/lock` (equipo y pid mientras está abierta)
- `<Bóveda>/piano_tracker.sqlite` (base de datos, en `journal_mode = DELETE`: un único fichero en reposo)
- `<Bóveda>/midi/raw/` (pistas brutas de sesión)
- `<Bóveda>/midi/fragments/` (fragmentos recortados)
- `<Bóveda>/media/` (imágenes de notas Markdown)

Fuera de la bóveda:
- `~/.config/piano-tracker/config.json` (bóveda actual, recientes y SoundFont elegido)
- `~/.local/share/piano-tracker/assets/default_piano.sf2` (piano sintético generado, regenerable)

Las columnas de rutas (`raw_midi_path`, `file_path`, `local_path`) y las imágenes del Markdown guardan rutas **relativas a la bóveda** (`midi/raw/…`, `media/…`). La API las devuelve absolutas.

### 3.1. Esquema SQL Completo (versión 2)

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
    updated_at TEXT NOT NULL
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
    created_at TEXT NOT NULL,
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
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

La versión 1 incluía la cola `sync_queue` y las columnas `sync_status` y `drive_file_id` de Google Drive. La migración a la versión 2 las elimina, borra los ajustes `google_*` y `drive_*`, y convierte las rutas absolutas antiguas en relativas (también en `markdown_notes`).

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

### 4.4. Bóvedas (`vault.rs`)
- **Crear:** en una carpeta nueva o vacía; crea la estructura y el marcador `.piano-tracker/vault.json`.
- **Abrir:** acepta una carpeta con el marcador o con `piano_tracker.sqlite` (la carpeta de datos de la versión anterior). Aplica migraciones y escribe `.piano-tracker/lock` con `{ host, pid, opened_at }`.
- **Bloqueo:** si al abrir hay un lock de otro equipo, o de otro proceso vivo en este, se pide confirmación antes de abrir. El lock se borra al cerrar la bóveda o la app. Abrir la misma base de datos en dos equipos a la vez acaba en copias en conflicto del servicio de sincronización.
- **Copias en conflicto:** al abrir se avisa si hay ficheros `piano_tracker*conflict*.sqlite` (Dropbox, Syncthing).
- **Importar datos antiguos:** mueve `piano_tracker.sqlite`, `midi/` y `media/` desde `~/.local/share/piano-tracker` a una bóveda nueva, tras volcar el WAL al fichero principal.
- **Asset protocol:** al abrir una bóveda se añade su carpeta al alcance del asset protocol para servir las imágenes de las notas.

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
- `save_session_image(session_id: String, file_name: String, base64_data: String) -> Result<String, String>` (devuelve la ruta relativa a la bóveda, `media/…`)
- `update_fragment_meta(fragment_id: String, title: String, explanation: String) -> Result<(), String>`
- `delete_fragment(fragment_id: String) -> Result<(), String>`
- `add_timeline_comment(fragment_id: String, timestamp_ms: u64, content: String) -> Result<TimelineCommentDto, String>`
- `delete_timeline_comment(comment_id: String) -> Result<(), String>`

### Bóveda
- `get_vault_info() -> Result<VaultInfo, String>`
- `create_vault(path: String) -> Result<VaultInfo, String>`
- `open_vault(path: String, force: bool) -> Result<VaultOpenResult, String>` (`opened = false` + `lock_warning` si parece abierta en otro equipo)
- `import_legacy_data(path: String) -> Result<VaultInfo, String>`
- `close_vault() -> Result<VaultInfo, String>`
- `forget_recent_vault(path: String) -> Result<VaultInfo, String>`
- `reveal_vault() -> Result<(), String>`

### SoundFont
- `get_soundfont_info() -> Result<SoundfontInfo, String>`
- `set_soundfont(path: String) -> Result<SoundfontInfo, String>`

### Idioma
- `get_language() -> Result<LanguageInfo, String>`
- `set_language(language: Option<String>) -> Result<LanguageInfo, String>` (`None` = el del sistema)

---

## 6. Diseño de Interfaz de Usuario (Angular UI/UX)

1. **Barra Lateral Izquierda (Navegación y Estado):**
   - Botón "+ Nueva Sesión de Práctica".
   - Lista cronológica de sesiones.
   - Selector rápido de puerto USB-MIDI y botón de Ajustes (con el nombre de la bóveda abierta) en el pie de la barra.
   - Sin bóveda abierta, la app muestra una pantalla de bienvenida: crear bóveda (nombre + ubicación), abrir una existente, recientes e importación de los datos de la versión anterior.
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
   - Soporta pegar imágenes del portapapeles (`Ctrl+V`) o arrastrarlas; las guarda en `media/` dentro de la bóveda, las registra en `session_media`, inserta su ruta relativa en el Markdown y las renderiza en la vista previa.