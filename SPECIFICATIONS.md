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
6. **Trims can be undone:** before each trim the raw take is copied to `midi/history/`; the last 10 trims of each session can be undone (undoing an extraction deletes the fragment it created). Recording again clears that history.
7. **Practice time is recorded, not derived:** `practice_log` keeps what was actually recorded each day, so trimming or deleting a session does not change the statistics.
8. **Repertoire:** a fragment can be filed under a piece and a passage (free text), so the takes of the same passage can be compared across sessions.
9. **Composer:** recorded fragments are laid out as clips on a multitrack timeline to build a larger piece. A clip points to its fragment (window, repeats, transposition) and never copies its MIDI; each track is one MIDI channel with a General MIDI instrument, and all tracks sound at once.

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
- `<Vault>/midi/history/<session_id>/` (copies of the raw take taken before each trim, to undo it)
- `<Vault>/media/` (images in the Markdown notes)

Outside the vault:
- `~/.config/piano-tracker/config.json` (current vault, recent ones, chosen SoundFont and language)
- `~/.local/share/piano-tracker/assets/default_piano.sf2` (generated synthetic piano, can be regenerated)

The path columns (`raw_midi_path`, `file_path`, `local_path`) and the Markdown images store paths **relative to the vault** (`midi/raw/…`, `media/…`). The API returns them absolute.

### 3.1. Full SQL Schema (version 4)

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
    piece_id TEXT REFERENCES pieces(id) ON DELETE SET NULL,
    passage TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pieces (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    composer TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Time actually recorded per day (local date); not changed by trims.
CREATE TABLE IF NOT EXISTS practice_log (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    practiced_on TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
);

-- Undo stack of the raw takes (at most 10 per session).
CREATE TABLE IF NOT EXISTS raw_history (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,          -- relative: midi/history/<session>/<uuid>.mid
    duration_ms INTEGER NOT NULL,     -- duration of the take when the copy was taken
    action TEXT NOT NULL,             -- 'extract' | 'discard'
    fragment_id TEXT,                 -- fragment created by an 'extract'
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compositions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- One MIDI channel per track (derived from order_index, skipping channel 10): at most 15.
CREATE TABLE IF NOT EXISTS composition_tracks (
    id TEXT PRIMARY KEY,
    composition_id TEXT NOT NULL REFERENCES compositions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    program INTEGER NOT NULL DEFAULT 0,   -- General MIDI program (0-127)
    volume INTEGER NOT NULL DEFAULT 100,  -- channel volume (CC7)
    muted INTEGER NOT NULL DEFAULT 0,
    solo INTEGER NOT NULL DEFAULT 0,
    sustain INTEGER NOT NULL DEFAULT 1,   -- play the recorded pedal (CC64)
    color INTEGER NOT NULL DEFAULT 0,     -- index into the UI palette
    order_index INTEGER NOT NULL
);

-- A window of a fragment placed on a track; disappears with the fragment.
CREATE TABLE IF NOT EXISTS composition_clips (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES composition_tracks(id) ON DELETE CASCADE,
    fragment_id TEXT NOT NULL REFERENCES midi_fragments(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,            -- position on the timeline
    trim_start_ms INTEGER NOT NULL DEFAULT 0,
    length_ms INTEGER NOT NULL,           -- length of one repetition of the window
    repeats INTEGER NOT NULL DEFAULT 1,   -- 1-16, back to back
    transpose INTEGER NOT NULL DEFAULT 0  -- semitones, ±24
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

The migration to version 3 adds `pieces`, `practice_log`, `raw_history` and the `piece_id` / `passage` columns. It fills `practice_log` with one entry per existing session: its raw take plus its fragments, on the session's date. It is an approximation: sections discarded before version 3 are not counted. The weekly goal is the `weekly_goal_minutes` key of `app_settings`.

The migration to version 4 adds `compositions`, `composition_tracks` and `composition_clips`. A composition is saved whole (`save_composition` replaces its tracks and clips in one transaction) after checking that no two clips overlap on a track, that each window lies inside its fragment and the limits above.

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
  - **Speed:** from 0.25 to 1.5 (the UI offers 50–100 %). The position advances in file time at that rate, so the pitch does not change.
  - **A-B loop** of the loaded file: on reaching the end it releases the sounding notes and jumps back to the start, restoring the controllers (pedal) at that point.
- **Sequences in memory:** besides files, the player plays events built in memory under a key (`play_sequence`, a composition's `composition:<id>`), which `PlaybackProgress.file_path` reports. Editing a composition while it plays swaps its events in place (`replace_sequence`), keeping the position, play state and loop.
- **Channel mix:** volume and mute per MIDI channel, applied live (CC7, and All Sound Off when muting) and kept across seeks and synthesizer resets. Playing a file restores the default mix, and so does turning live monitoring on.
- **WAV export:** a file is rendered offline with its own synthesizer and the current SoundFont (the live player is not touched), plus 2 s of tail, and written as 16-bit stereo PCM at 44.1 kHz block by block, so a long take does not have to fit in memory. The level is the same as playback (no normalization).

### 4.5. Notes and Cut Suggestions (`midi_notes.rs`)
- `extract_notes`: pairs NoteOn/NoteOff per channel and key (a repeated NoteOn closes the previous note) and returns the notes with velocity, the sustain pedal intervals and the key range, for the piano roll.
- `suggest_segments`: the passages separated by at least a minimum silence (3 s by default). A note released with the pedal down rings until the pedal goes up. Passages shorter than 4 s join the closest neighbour, and each one keeps up to 0.5 s of silence around it.
- `discard_ranges` (`midi_slicer.rs`) removes several ranges with one read and one write, so "discard every silence" is a single undo step.

### 4.6. Undo (`raw_history.rs`)
- Before a trim the raw take is copied (tmp + rename) to `midi/history/<session>/`; after a successful trim the copy is recorded in `raw_history` and the copies beyond the 10 newest are deleted.
- Undoing renames the newest copy over the raw take, restores its duration and, if that trim extracted a fragment that still exists, deletes it.
- If inserting the fragment fails after the take was trimmed, the copy is put back, so the section is not lost.

### 4.7. Compositions (`composition.rs`)
- **Mixdown:** each clip is the `[trim_start, trim_start + length)` window of its fragment, cut like an extraction (open notes and the pedal close at the window's end), repeated back to back and transposed (notes falling outside 0-127 are dropped). Every event moves to its track's channel.
- **The track owns the instrument:** the fragment's program changes, volume (CC7) and pan (CC10) are dropped, and its pedal (CC64) too when the track ignores it; each track starts with its own program change.
- **Ordering:** simultaneous events go note-offs first, then controllers, then note-ons, so the seam between repeats never cuts the new note.
- **Live vs export:** live playback leaves volume, mute and solo to the engine's channel mix; WAV and MIDI exports bake them in (silent tracks are left out). Solo wins: once a track is soloed, only the soloed ones sound, and a muted track never does.
- **MIDI export:** SMF format 1 with a tempo track and one named track per voice (its program and volume at the start), timed at a nominal 120 BPM.
- **Instrument preview:** a short arpeggio and chord with any General MIDI program; `soundfont::gm_programs` lists the programs (bank 0) the active SoundFont has.

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
- `set_playback_rate(rate: f32) -> Result<f32, String>` (returns the speed applied)
- `set_playback_loop(start_ms: Option<u64>, end_ms: Option<u64>) -> Result<(), String>` (`None` removes the loop)
- `get_midi_notes(file_path: String) -> Result<MidiNotesDto, String>`
- `suggest_midi_segments(file_path: String, min_gap_ms: Option<u64>) -> Result<Vec<TimeRangeDto>, String>`
- `discard_midi_ranges(session_id: String, ranges: Vec<TimeRangeDto>) -> Result<SessionDto, String>`
- `undo_raw_trim(session_id: String) -> Result<UndoTrimResult, String>`
- `export_audio(file_path: String, dest_path: String) -> Result<String, String>` (returns the path written, with `.wav` added if missing)

`ExtractFragmentReq` also accepts `piece_id` and `passage` to file the new fragment under a piece. `SessionDetailDto` includes `undo_depth` and `undo_fragment_id` (the fragment the next undo would delete).

### Repertoire
- `get_pieces() -> Result<Vec<PieceSummaryDto>, String>`
- `get_piece_detail(piece_id: String) -> Result<PieceDetailDto, String>`
- `create_piece(title: String, composer: String) -> Result<PieceDto, String>`
- `update_piece(piece_id: String, title: String, composer: String, notes: String, archived: bool) -> Result<PieceDto, String>`
- `delete_piece(piece_id: String) -> Result<(), String>` (the fragments stay in their sessions)
- `assign_fragment_piece(fragment_id: String, piece_id: Option<String>, passage: String) -> Result<FragmentDto, String>`

### Compositions
- `get_compositions() -> Result<Vec<CompositionSummaryDto>, String>`
- `create_composition(title: String) -> Result<CompositionDto, String>` (with one empty piano track)
- `get_composition(composition_id: String) -> Result<CompositionDto, String>`
- `save_composition(composition: CompositionDto) -> Result<CompositionDto, String>` (the whole document; empty track or clip ids get a new one)
- `delete_composition(composition_id: String) -> Result<(), String>`
- `get_library_fragments() -> Result<Vec<LibraryFragmentDto>, String>` (every fragment, with its piece and session)
- `count_composition_uses(fragment_ids: Vec<String>, session_id: Option<String>) -> Result<u32, String>` (compositions that would lose clips)
- `play_composition(composition_id: String, start_ms: u64) -> Result<(), String>` (progress as `composition:<id>`; pause, seek, loop and speed are the playback commands)
- `set_composition_mix(composition_id: String, mix: Vec<TrackMixDto>) -> Result<(), String>` (applied only if it is the one loaded)
- `get_soundfont_programs() -> Result<Vec<u8>, String>`
- `preview_instrument(program: u8) -> Result<(), String>`
- `export_composition_audio(composition_id: String, dest_path: String) -> Result<String, String>`
- `export_composition_midi(composition_id: String, dest_path: String) -> Result<String, String>`

### Practice Statistics
- `get_practice_stats(from: String, to: String) -> Result<PracticeStatsDto, String>` (ISO dates; only the days with practice)
- `set_weekly_goal(minutes: u32) -> Result<u32, String>`

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
   - Four views: **Sessions**, **Repertoire**, **Compose** and **Statistics**.
   - "+ New Practice Session" button and the chronological list of sessions (in the Repertoire view: "+ New piece" and the list of pieces, the archived ones apart).
   - Quick USB-MIDI port selector and Settings button (with the name of the open vault) in the sidebar footer.
   - Without an open vault, the app shows a welcome screen: create a vault (name + location), open an existing one, recent ones and import of the previous version's data.
2. **Session Header and Recording / Metronome Panel:**
   - Editable session title and date.
   - Metronome controls: numeric/slider BPM selector ($40 - 240$), metronome toggle, live synthesizer monitoring switch, and the main **Record / Stop** button with a live timer.
3. **Raw Take and Slicer Area:**
   - Visible when the session has a master recording (`raw_midi_path`).
   - Interactive timeline drawn as a **piano roll** (each note, with the pedal strip) or as density blocks; the choice is kept on this machine.
   - **"Suggest cuts"** marks the passages separated by silences (minimum silence adjustable from 1 to 10 s); clicking one selects it, and **"Discard the silences"** removes every gap at once.
   - **Undo** (and Ctrl+Z) reverts the last trims, one by one.
   - Playback speed and WAV export of the raw take.
   - Range selection controls (Start `mm:ss` - End `mm:ss`) that can be dragged on the canvas.
   - Action buttons for the selected range:
     - **"Extract as Fragment"** (opens a quick modal/form for the title, piece, passage and initial explanation, creates the fragment and slices the master track).
     - **"Discard Selection"** (removes silences or failed takes from the master track).
4. **Session Fragment List + Timeline Comments:**
   - Expandable cards for each extracted fragment.
   - Each card includes:
     - Title, BPM, duration and the fragment's general explanation text.
     - **Timeline Player with Markers (Pins):** Shows the progress bar and markers at the exact seconds where there are comments. When hovering over a pin, or when playback passes that second, a **floating popup** with the comment appears over the timeline.
     - **Quick form "+ Add comment at the current second (`mm:ss`)"**.
     - **Right side panel inside the card:** Chronologically sorted list of all the fragment's comments. Clicking any comment automatically jumps (`seek`) to that instant.
     - **Loop and speed:** "Loop" repeats the whole fragment; dragging on the timeline narrows the passage. The speed goes from 50 % to 100 %.
     - Piece and passage of the take, and **"Export WAV"**.
5. **Session Notes Editor (Markdown + Images):**
   - Tab or split panel (Edit / Preview / Split) to write general session notes in Markdown.
   - Supports pasting images from the clipboard (`Ctrl+V`) or dragging them in; saves them in `media/` inside the vault, registers them in `session_media`, inserts their relative path into the Markdown and renders them in the preview.
6. **Repertoire:**
   - A piece has a title, composer, notes and can be archived.
   - Its takes are grouped by passage, in chronological order, each with a mini piano roll, duration, BPM and comments, and a link to its session.
   - Two takes can be compared one above the other on the same time scale, each with its own play button.
7. **Practice Statistics:**
   - Today, the current and best streak (days with at least a minute of practice; today's practice can still continue yesterday's streak), and the week against a goal set by the user.
   - A heatmap of the last 53 weeks (levels at 1, 15, 30 and 60 minutes) and a bar chart of the last 30 days, with a tooltip on hover or focus and a table view.
8. **Composer:**
   - The sidebar lists the compositions; a new one starts with one empty piano track and a drop zone that explains the three steps.
   - Header (editable title, tracks · clips · length, Export MIDI / Export WAV, undo, redo, delete) and a transport bar (to the start, play/pause, stop, A-B loop, position, snap to clip edges / seconds / off, speed and zoom).
   - Multitrack timeline: a ruler (click to seek, drag to set the loop) and one row per track with its colour, editable name, M / S, instrument and volume. Clips show their fragment's piano roll; they are dragged between tracks (Alt copies), trimmed by their edges and repeated with a tab on their corner. A row at the bottom takes a fragment onto a new track.
   - Library of fragments grouped by piece, with search, a piece filter and "In use ×N"; a fragment is dragged onto the timeline or added at the playhead of the active track with a click or Enter.
   - Inspector of the selected clip: start, length, trims, transposition and repeats steppers, Split at the playhead, Duplicate, Remove and a link to its session.
   - Instrument dialog: 16 families, a search across the 128 programs, a preview of each one, the programs the SoundFont lacks disabled, and whether the track plays the sustain pedal.
   - Shortcuts: Space, Ctrl+Z / Ctrl+Shift+Z, S (split), Ctrl+D (duplicate), Delete, arrows (move 0.1 s, Shift: 1 s), Esc, Shift+M / Shift+S (mute / solo the active track).
   - Deleting a fragment or a session that a composition uses says so in the confirmation; its clips go with it.
