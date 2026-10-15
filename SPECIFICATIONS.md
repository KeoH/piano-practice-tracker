# Technical Specification: Piano Practice Tracker (Tauri v2 + Angular)

## 1. System Overview
A native desktop application for **Ubuntu Linux** for recording, slicing and analyzing daily piano practice sessions over a USB-MIDI connection, with built-in playback through a SoundFont (`.sf2`) synthesizer, comments anchored to the timeline, Markdown notes with images, and storage in a **vault**: a folder chosen by the user (Obsidian-style) that holds all the data. The app syncs nothing on its own; if the user puts the vault inside Dropbox, Syncthing or similar, that service makes the copy.

### 1.1. Consolidated Design Decisions
1. **Destructive Slicing of the Raw Take:**
   - Each session can record one long continuous track (`raw_session_<id>.mid`, e.g. 20-30 minutes).
   - The user sees MIDI activity blocks (areas with notes vs. silence) on the timeline.
   - When a range $[t_{start}, t_{end}]$ is selected and extracted as a **Fragment**, the Rust engine creates a new standalone file (`frag_<uuid>.mid`) aligned to $t = 0$ and **removes that section from the session's raw file**, shifting the later events to close the gap. Ranges of silence or mistakes can also be discarded directly from the raw take.
2. **Audio Monitoring and Metronome:**
   - During recording, the metronome plays through the app's audio engine (`cpal`).
   - Live monitoring through the piano synthesizer during recording is **optional** (off by default so the user hears their own digital piano with no latency; it can be turned on with a switch in the UI).
   - During playback of fragments or of the raw take, the built-in engine (`rustysynth`) synthesizes the `.mid` file in real time using a SoundFont (`.sf2`) file.
3. **Activity Display on the Timeline:**
   - The backend analyzes any `.mid` file and returns a vector of note density per time interval (buckets) to draw visual activity blocks in the player/slicer.
4. **Vaults instead of a custom sync:**
   - All the data (database, MIDI and images) lives in the vault folder, with paths relative to it, so it can be moved or synced between computers.
   - The machine's own configuration (current vault, recent ones, chosen SoundFont, language) stays outside it, in `~/.config/piano-tracker/config.json`.
5. **Multi-language:**
   - The UI and the backend messages are available in English and Spanish. The system language is used if available, otherwise English; the user can choose it in Settings and on the welcome screen.
   - All texts live in `src/locales/<code>.json`, shared by Angular and Rust, so adding a language means adding a file.

---

## 2. Technology Stack and Dependencies

### 2.1. System Requirements (Ubuntu Linux)
Native packages required to build Tauri v2 and the audio/MIDI subsystem (ALSA):
- `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `pkg-config`
- `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libwebkit2gtk-4.1-dev`
- `libasound2-dev` (required by `midir` and `cpal` on Linux)

### 2.2. Backend: Rust (Tauri v2)
- **Framework:** `tauri = "2"` (feature `protocol-asset`), `tauri-plugin-fs`, `tauri-plugin-dialog`
- **Serialization:** `serde`, `serde_json`, `uuid` (features: `v4`), `chrono`, `base64` (images pasted into the notes)
- **MIDI Input/Output:** `midir = "0.10"` (reading ALSA MIDI ports on a dedicated thread)
- **MIDI Parsing and Slicing:** `midly = "0.5"` (reading, tick/tempo handling and SMF writing)
- **Audio and Synthesizer:**
  - `cpal = "0.15"` (low-latency audio output to ALSA/PipeWire)
  - `rustysynth = "1.3"` (pure-Rust `.sf2` SoundFont synthesizer, no C dependencies)
- **Database:** `rusqlite = { version = "0.31", features = ["bundled"] }`

### 2.3. Frontend: Angular (v18+ Standalone)
- **Architecture:** *Standalone* components, reactive state management with **Angular Signals**, communication through `@tauri-apps/api/core` (`invoke`) and `@tauri-apps/api/event` (`listen`).
- **Styles:** TailwindCSS (dark mode by default, music studio/DAW look).
- **Markdown:** Rendered with `marked`, plus interception of the `paste` and `drop` events to save images locally through Tauri IPC and replace them with resolvable local paths.
- **Timeline Display:** Custom HTML5 `<canvas>` component + DOM overlay for comment pins, floating popups and slice range selectors (start/end handles).

---

## 3. Database Model (SQLite)

Layout of a vault (`<Vault>` is the folder chosen by the user):
- `<Vault>/.piano-tracker/vault.json` (vault marker) and `.piano-tracker/lock` (host and pid while it is open)
- `<Vault>/piano_tracker.sqlite` (database, in `journal_mode = DELETE`: a single file at rest)
- `<Vault>/midi/raw/` (session raw takes)
- `<Vault>/midi/fragments/` (sliced fragments)
- `<Vault>/media/` (images in the Markdown notes)

Outside the vault:
- `~/.config/piano-tracker/config.json` (current vault, recent ones, chosen SoundFont and language)
- `~/.local/share/piano-tracker/assets/default_piano.sf2` (generated synthetic piano, can be regenerated)

The path columns (`raw_midi_path`, `file_path`, `local_path`) and the Markdown images store paths **relative to the vault** (`midi/raw/…`, `media/…`). The API returns them absolute.

### 3.1. Full SQL Schema (version 2)

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

Version 1 included the `sync_queue` queue and the Google Drive `sync_status` and `drive_file_id` columns. The migration to version 2 drops them, deletes the `google_*` and `drive_*` settings, and turns the old absolute paths into relative ones (in `markdown_notes` too).

---

## 4. Rust Engine Specification

### 4.1. MIDI Capture Engine (`midi_recorder.rs`)
- Lists input ports using `midir::MidiInput`.
- When recording starts:
  - Opens a connection to the selected port.
  - Records `Instant::now()` as the $t_0$ reference (or resumes, accumulating the offset, if the session already has a raw take).
  - Every incoming MIDI message (`NoteOn`, `NoteOff`, `ControlChange`) is stored in memory with its timestamp in microseconds, together with the active BPM.
  - If `live_synth_enabled == true`, the message is forwarded immediately to the `rustysynth` synthesizer thread.
- When recording stops:
  - Injects `NoteOff` for any open note and `CC 64 = 0` (Sustain Off).
  - Writes a Standard MIDI File (SMF format 0, resolution 480 ticks per quarter note) using `midly`, injecting the `Tempo` meta event matching the session's BPM.

### 4.2. MIDI Slicing and Analysis Engine (`midi_slicer.rs`)
1. **Density Analysis (`analyze_midi_activity`):**
   - Reads the `.mid` file and converts the tick deltas to real milliseconds according to the tempo.
   - Splits the total duration into segments (up to 200 blocks) and returns `Vec<ActivityBlock { start_ms, end_ms, note_count, velocity_avg }>`.
2. **Extraction and Destructive Slicing (`extract_fragment_and_trim`):**
   - Takes `source_path`, `start_ms`, `end_ms`, `output_fragment_path`.
   - **Creating the Fragment ($[start\_ms, end\_ms]$):**
     - Tracks the state of the sustain pedal (`CC 64`) right before `start_ms`. If it was pressed, it injects `CC 64` at $t = 0$ of the new fragment.
     - Copies every event within $[start\_ms, end\_ms]$, shifting their times to $t' = t - start\_ms$.
     - On reaching `end_ms`, closes every active note with `NoteOff` and sets `CC 64 = 0`.
     - Saves to `output_fragment_path`.
   - **Destructive Slicing of the Raw Take:**
     - Removes the events in $[start\_ms, end\_ms]$ from the master file `source_path`.
     - Makes sure notes that started before `start_ms` receive a `NoteOff` at `start_ms`.
     - Shifts every event with $t > end\_ms$ by subtracting $(end\_ms - start\_ms)$.
     - Atomically overwrites `source_path` and updates `raw_duration_ms` in the `sessions` table.

### 4.3. Audio Engine, Synthesizer and Metronome (`audio_engine.rs`)
- Runs a constant `cpal::Stream` output (e.g. $44100\text{ Hz}$ stereo).
- Loads the `.sf2` SoundFont file into `rustysynth::Synthesizer`. If there is no `.sf2` in `~/.local/share/piano-tracker/assets/`, the system automatically generates or downloads a compact piano SoundFont on startup.
- **Built-in Metronome:** Sine wave generator with a short exponential envelope ($880\text{ Hz}$ for the first beat of the bar, $440\text{ Hz}$ for the rest), synchronized by audio samples to the active BPM.
- **Built-in MIDI Player:**
  - Reads the events of the selected `.mid`, advances the clock according to the audio frames consumed by `cpal`, feeds `rustysynth` and emits a Tauri `playback-progress` event every $50\text{ ms}$ with `{ file_path, current_ms, duration_ms, is_playing }`.
  - Supports `play`, `pause`, `stop` and `seek(ms)` (sending `reset_all_controllers` and `note_off_all` on seek).

### 4.4. Vaults (`vault.rs`)
- **Create:** in a new or empty folder; creates the layout and the `.piano-tracker/vault.json` marker.
- **Open:** accepts a folder with the marker or with `piano_tracker.sqlite` (the previous version's data folder). Applies migrations and writes `.piano-tracker/lock` with `{ host, pid, opened_at }`.
- **Locking:** if, when opening, there is a lock from another computer, or from another live process on this one, the user is asked to confirm before opening. The lock is deleted when the vault or the app is closed. Opening the same database on two computers at once ends up in conflicting copies from the sync service.
- **Conflicting copies:** on opening, the user is warned if there are `piano_tracker*conflict*.sqlite` files (Dropbox, Syncthing).
- **Importing old data:** moves `piano_tracker.sqlite`, `midi/` and `media/` from `~/.local/share/piano-tracker` into a new vault, after flushing the WAL into the main file.
- **Asset protocol:** when a vault is opened, its folder is added to the asset protocol scope so the images in the notes can be served.

---

## 5. IPC Contract (Tauri Commands)

### MIDI Devices and Recording
- `list_midi_ports() -> Result<Vec<MidiPortInfo>, String>`
- `start_recording(session_id: String, port_id: String, bpm: u32, metronome_on: bool, live_synth_on: bool) -> Result<(), String>`
- `update_live_recording_settings(bpm: u32, metronome_on: bool, live_synth_on: bool) -> Result<(), String>`
- `stop_recording(session_id: String) -> Result<SessionDto, String>`

### Slicing and Playback
- `get_midi_activity(file_path: String) -> Result<MidiActivityDto, String>`
- `extract_midi_fragment(req: ExtractFragmentReq) -> Result<FragmentCreatedResponse, String>`
- `discard_midi_range(session_id: String, start_ms: u64, end_ms: u64) -> Result<SessionDto, String>`
- `play_midi_file(file_path: String, start_ms: u64) -> Result<(), String>`
- `pause_midi_playback() -> Result<(), String>`
- `seek_midi_playback(ms: u64) -> Result<(), String>`
- `stop_midi_playback() -> Result<(), String>`

### Sessions, Fragments and Comments
- `get_sessions() -> Result<Vec<SessionSummaryDto>, String>`
- `get_session_detail(session_id: String) -> Result<SessionDetailDto, String>`
- `create_session(title: String, bpm: u32) -> Result<SessionDetailDto, String>`
- `update_session(session_id: String, title: String, bpm: u32, markdown_notes: String) -> Result<(), String>`
- `delete_session(session_id: String) -> Result<(), String>`
- `save_session_image(session_id: String, file_name: String, base64_data: String) -> Result<String, String>` (returns the path relative to the vault, `media/…`)
- `update_fragment_meta(fragment_id: String, title: String, explanation: String) -> Result<(), String>`
- `delete_fragment(fragment_id: String) -> Result<(), String>`
- `add_timeline_comment(fragment_id: String, timestamp_ms: u64, content: String) -> Result<TimelineCommentDto, String>`
- `delete_timeline_comment(comment_id: String) -> Result<(), String>`

### Vault
- `get_vault_info() -> Result<VaultInfo, String>`
- `create_vault(path: String) -> Result<VaultInfo, String>`
- `open_vault(path: String, force: bool) -> Result<VaultOpenResult, String>` (`opened = false` + `lock_warning` if it seems open on another computer)
- `import_legacy_data(path: String) -> Result<VaultInfo, String>`
- `close_vault() -> Result<VaultInfo, String>`
- `forget_recent_vault(path: String) -> Result<VaultInfo, String>`
- `reveal_vault() -> Result<(), String>`

### SoundFont
- `get_soundfont_info() -> Result<SoundfontInfo, String>`
- `set_soundfont(path: String) -> Result<SoundfontInfo, String>`

### Language
- `get_language() -> Result<LanguageInfo, String>`
- `set_language(language: Option<String>) -> Result<LanguageInfo, String>` (`None` = the system language)

---

## 6. User Interface Design (Angular UI/UX)

1. **Left Sidebar (Navigation and Status):**
   - "+ New Practice Session" button.
   - Chronological list of sessions.
   - Quick USB-MIDI port selector and Settings button (with the name of the open vault) in the sidebar footer.
   - Without an open vault, the app shows a welcome screen: create a vault (name + location), open an existing one, recent ones and import of the previous version's data.
2. **Session Header and Recording / Metronome Panel:**
   - Editable session title and date.
   - Metronome controls: numeric/slider BPM selector ($40 - 240$), metronome toggle, live synthesizer monitoring switch, and the main **Record / Stop** button with a live timer.
3. **Raw Take and Slicer Area:**
   - Visible when the session has a master recording (`raw_midi_path`).
   - Interactive timeline with visual MIDI activity blocks.
   - Range selection controls (Start `mm:ss` - End `mm:ss`) that can be dragged on the canvas.
   - Action buttons for the selected range:
     - **"Extract as Fragment"** (opens a quick modal/form for the title and initial explanation, creates the fragment and slices the master track).
     - **"Discard Selection"** (removes silences or failed takes from the master track).
4. **Session Fragment List + Timeline Comments:**
   - Expandable cards for each extracted fragment.
   - Each card includes:
     - Title, BPM, duration and the fragment's general explanation text.
     - **Timeline Player with Markers (Pins):** Shows the progress bar and markers at the exact seconds where there are comments. When hovering over a pin, or when playback passes that second, a **floating popup** with the comment appears over the timeline.
     - **Quick form "+ Add comment at the current second (`mm:ss`)"**.
     - **Right side panel inside the card:** Chronologically sorted list of all the fragment's comments. Clicking any comment automatically jumps (`seek`) to that instant.
5. **Session Notes Editor (Markdown + Images):**
   - Tab or split panel (Edit / Preview / Split) to write general session notes in Markdown.
   - Supports pasting images from the clipboard (`Ctrl+V`) or dragging them in; saves them in `media/` inside the vault, registers them in `session_media`, inserts their relative path into the Markdown and renders them in the preview.
