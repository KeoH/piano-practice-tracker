# Technical Specification: Piano Practice Tracker (Tauri v2 + Angular)

## 1. System Overview
A native application for **Ubuntu Linux** (it also builds for macOS, and for Android as a debug APK) for recording, slicing and analyzing daily piano practice sessions over a USB-MIDI connection, with built-in playback through a SoundFont (`.sf2`) synthesizer, comments anchored to the timeline, Markdown notes with images, and storage in a **vault**: a folder chosen by the user (Obsidian-style) that holds all the data. The app syncs nothing on its own; if the user puts the vault inside Dropbox, Syncthing or similar, that service makes the copy.

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
9. **Composer:** recorded fragments are laid out as clips on a multitrack timeline to build a larger piece. A clip points to its fragment (window, repeats, transposition, speed) and never copies its MIDI; each track is one MIDI channel with a General MIDI instrument, and all tracks sound at once. A composition can have a **tempo**: the clips of scores follow it, and recorded clips can be matched to it.
10. **Challenge mode (compete with your previous self):** a **melody** is a frozen copy of a fragment or of an imported `.mid` (leading silence removed), so its history never breaks if the fragment changes or is deleted. An **attempt** plays it at 40-150 % of its tempo after a one-bar count-in; every note is scored live and the attempt is saved with its score, accuracy, per-note detail, mistakes and the MIDI played. The **record** is the best completed attempt at the same tempo, and a "ghost" compares the notes hit so far with it at the same moment. Attempts stopped by hand are kept as incomplete and never count for records or charts. A vault gets five **starter melodies** the first time it is opened (C major scale, Twinkle Twinkle, Frère Jacques, Ode to Joy, Petzold's Minuet in G: public domain, right hand); deleted ones can be added again from the Challenges view.
11. **Android build:** the same code base runs on Android. `midir` has no Android backend, so the MIDI input comes from the platform through a `NativeMidi` backend (a Kotlin plugin over `MidiManager`). There is no folder picker the vault can use, so the app keeps a single vault in the app's external files directory, created on first launch, and the machine configuration lives in the app's private storage. Only a debug APK is supported: the CI builds it (arm64 and 32-bit ARM, uploaded as a workflow artifact) so the Android code does not break unnoticed, but it is not tested there and not part of the releases.
12. **Score editor:** a fragment can be written on a grand staff (treble clef for the right hand, bass clef for the left) by dragging note values onto the bars. The **score** (notation as JSON in `scores`) is the source of truth; saving it regenerates a real fragment (`frag_<id>.mid`, same id every time), so the library, the composer, the exports and the challenge mode treat it like any recorded fragment. The fragments of scores live in a hidden *system session* (`sessions.kind = 'scores'`) that the list of sessions and the statistics never show. Both hands become one fragment on one MIDI channel. A score can end with a **repeat sign** (`repeat`): it is played twice, from the start, in the editor and in the fragment it generates (so the composer and the challenge mode get the piece as performed). A score has its own tempo while it is written; in a composition its clips follow the composition's tempo.

---

## 2. Technology Stack and Dependencies

### 2.1. System Requirements (Ubuntu Linux)
Native packages required to build Tauri v2 and the audio/MIDI subsystem (ALSA):
- `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `pkg-config`
- `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libwebkit2gtk-4.1-dev`
- `libasound2-dev` (required by `midir` and `cpal` on Linux)

For the Android build: JDK 17, the Android SDK (platform 37, build-tools 36), NDK 27 and the Rust targets `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android` and `x86_64-linux-android`, with `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` set. `npx tauri android build --debug --apk --target <abi>` builds one ABI at a time (cargo is memory hungry); the minimum is Android 7 (API 24).

### 2.2. Backend: Rust (Tauri v2)
- **Framework:** `tauri = "2"` (feature `protocol-asset`), `tauri-plugin-fs`, `tauri-plugin-dialog`
- **Serialization:** `serde`, `serde_json`, `uuid` (features: `v4`), `chrono`, `base64` (images pasted into the notes)
- **MIDI Input/Output:** `midir = "0.10"` (reading ALSA MIDI ports on a dedicated thread; every target except Android). On Android: the local `tauri-plugin-android-midi` crate (`src-tauri/plugins/android-midi`, with its Kotlin `MidiPlugin`) and `oboe-sys` with `shared-stdcxx`, so `libc++_shared.so` is shipped in the APK (the static runtime leaves `__cxa_pure_virtual` unresolved when the library loads).
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
- `<Vault>/midi/melodies/` and `<Vault>/midi/attempts/` (challenge mode; created on the first write)
- `<Vault>/media/` (images in the Markdown notes)

Outside the vault:
- `~/.config/piano-tracker/config.json` (current vault, recent ones, chosen SoundFont and language)
- `~/.local/share/piano-tracker/assets/default_piano.sf2` (generated synthetic piano, can be regenerated)

On Android there is no `$HOME`: both files live in the app's private storage (Tauri's `app_config_dir` / `app_data_dir`), and the vault is `Android/data/<id>/files/Documents/vault`, falling back to private storage if the external directory is not usable.

The path columns (`raw_midi_path`, `file_path`, `local_path`) and the Markdown images store paths **relative to the vault** (`midi/raw/…`, `media/…`). The API returns them absolute.

### 3.1. Full SQL Schema (version 7)

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

Version 5 adds the challenge mode tables:

```sql
-- No foreign key to the fragment: the melody is a copy. Its file and the attempts' files live in
-- midi/melodies/ and midi/attempts/ (created on the first write).
CREATE TABLE IF NOT EXISTS melodies (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,              -- 'fragment' | 'import'
    source_fragment_id TEXT,
    file_path TEXT NOT NULL,
    bpm INTEGER NOT NULL,              -- tempo at 100 %
    duration_ms INTEGER NOT NULL,
    note_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_attempts (
    id TEXT PRIMARY KEY,
    melody_id TEXT NOT NULL REFERENCES melodies(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    tempo_pct INTEGER NOT NULL,
    bpm INTEGER NOT NULL,              -- effective BPM
    completed INTEGER NOT NULL,        -- 0 = stopped by hand
    score INTEGER NOT NULL,            -- 0-1000
    accuracy REAL NOT NULL,            -- notes hit / notes
    hits INTEGER NOT NULL, perfect INTEGER NOT NULL, misses INTEGER NOT NULL,
    wrong INTEGER NOT NULL, extra INTEGER NOT NULL,
    mean_offset_ms INTEGER NOT NULL, mean_abs_offset_ms INTEGER NOT NULL,
    latency_comp_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    played_midi_path TEXT,
    details_json TEXT NOT NULL         -- AttemptDetails: per-note outcome + played errors
);
```

Version 6 adds the score editor and the composer's tempo. A score keeps its notation as JSON; the three columns are plain `ADD COLUMN`s, so no table is rebuilt (a rebuild of `midi_fragments` with foreign keys on would delete the clips and comments that point to it):

```sql
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'practice';   -- 'practice' | 'scores' (hidden)
ALTER TABLE compositions ADD COLUMN bpm INTEGER;                          -- NULL until it is set
ALTER TABLE composition_clips ADD COLUMN rate_pct INTEGER NOT NULL DEFAULT 100;  -- 25-400

CREATE TABLE IF NOT EXISTS scores (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    bpm INTEGER NOT NULL,              -- 30-240
    beats INTEGER NOT NULL,            -- time signature: beats of 1 / beat_unit (4/4, 3/4 and 2/4 in the editor)
    beat_unit INTEGER NOT NULL,
    bars INTEGER NOT NULL,             -- 1-64
    data_json TEXT NOT NULL,           -- { "treble": [Note], "bass": [Note] }, a note = id, tick, duration_ticks, key, accidental
    fragment_id TEXT REFERENCES midi_fragments(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

Version 7 adds one nullable column, so that a challenge made from a score can show its notation (a plain `ADD COLUMN`):

```sql
ALTER TABLE melodies ADD COLUMN score_json TEXT;   -- frozen copy of the ScoreDto the melody came from, or NULL
```

Version 1 included the `sync_queue` queue and the Google Drive `sync_status` and `drive_file_id` columns. The migration to version 2 drops them, deletes the `google_*` and `drive_*` settings, and turns the old absolute paths into relative ones (in `markdown_notes` too).

The migration to version 3 adds `pieces`, `practice_log`, `raw_history` and the `piece_id` / `passage` columns. It fills `practice_log` with one entry per existing session: its raw take plus its fragments, on the session's date. It is an approximation: sections discarded before version 3 are not counted. The weekly goal is the `weekly_goal_minutes` key of `app_settings`.

The migration to version 4 adds `compositions`, `composition_tracks` and `composition_clips`. A composition is saved whole (`save_composition` replaces its tracks and clips in one transaction) after checking that no two clips overlap on a track, that each window lies inside its fragment and the limits above.

The migration to version 6 keeps every session, fragment, comment and clip as they were (the old sessions are `practice`, the clips play at 100 %, the compositions have no tempo).

---

## 4. Rust Engine Specification

### 4.1. MIDI Capture Engine (`midi_recorder.rs`)
- Lists input ports using `midir::MidiInput`. On Android, `lib.rs` registers a `NativeMidi` backend (`android_midi.rs`, over the Kotlin plugin) at startup; its ports are listed as `native:<id>` and the capture uses it instead of `midir`. `split_midi_messages` cuts the chunks that the Android MIDI service delivers (several messages per buffer) into whole messages. The simulator port is always present.
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

### 4.4. Vaults (`vault.rs`)
- **Create:** in a new or empty folder; creates the layout and the `.piano-tracker/vault.json` marker.
- **Open:** accepts a folder with the marker or with `piano_tracker.sqlite` (the previous version's data folder). Applies migrations and writes `.piano-tracker/lock` with `{ host, pid, opened_at }`.
- **Locking:** if, when opening, there is a lock from another computer, or from another live process on this one, the user is asked to confirm before opening. The lock is deleted when the vault or the app is closed. Opening the same database on two computers at once ends up in conflicting copies from the sync service.
- **Conflicting copies:** on opening, the user is warned if there are `piano_tracker*conflict*.sqlite` files (Dropbox, Syncthing).
- **Importing old data:** moves `piano_tracker.sqlite`, `midi/` and `media/` from `~/.local/share/piano-tracker` into a new vault, after flushing the WAL into the main file.
- **Asset protocol:** when a vault is opened, its folder is added to the asset protocol scope so the images in the notes can be served.

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
- **Speed of a clip:** `rate_pct` (25-400) plays the window faster or slower without changing its pitch. `length_ms` and `trim_start_ms` stay in the fragment's own time, so on the timeline one repetition takes `length_ms × 100 / rate_pct`; the end of a clip is `start + ceil(length × repeats × 100 / rate)` ms (`db::clip_end_ms`, `clipEnd` in `core/composition.ts`), and the mixdown scales every event of the window, its closing events included, with the same formula so repetitions still meet at the seam.
- **Tempo:** a composition's `bpm` (30-240). A clip of a score follows it (`rate_pct = composition_bpm / score_bpm × 100`) when it is placed or when the tempo changes, and the clips that grew push the next ones on their track. The first score added to a composition with no tempo decides it (the first recorded clip's tempo, if there is one). Recorded fragments are never matched on their own, because their `bpm` is only the metronome setting; "Match tempo" in the inspector and "Match all" do it on request. The MIDI export is written at the composition's tempo.
- **Instrument preview:** a short arpeggio and chord with any General MIDI program; `soundfont::gm_programs` lists the programs (bank 0) the active SoundFont has.

### 4.8. Challenge Mode (`challenge.rs`)
- **Notes:** note-ons are paired with note-offs (FIFO per channel and key) and the leading silence is trimmed, so the first note is at $t = 0$. At `tempo_pct` the expected time of a note is $t \cdot 100 / tempo\_pct$.
- **Window:** $W = clamp(150\text{ ms} \cdot 100 / tempo\_pct,\ 100,\ 250)$ ms; a hit is "perfect" if $|\Delta| \le W/3$.
- **Matching:** each played note-on is matched with the closest still unmatched expected note of the **same key** within $\pm W$ (chords work on their own); otherwise it is **wrong** if another expected note was due within the window, or **extra**. An expected note whose window closes unmatched is **missed**.
- **Metrics:** `accuracy = hits / N`; each hit has quality $q = 1 - 0.5 \cdot |\Delta| / W$; `score = round(1000 · Σq / (N + 0.5 · (wrong + extra)))`; plus the mean signed and absolute offsets.
- **Latency:** the user plays along with what they hear (count-in, metronome, guide), which comes out `output_latency_us` late; it is subtracted from the played times.
- **Live runner:** the same `Matcher` scores live and offline. A ticker thread emits `challenge-progress` every 50 ms, starts the guide at the end of the count-in (at the challenge tempo through the global playback speed, restored afterwards) and ends the attempt 1.5 s after the last note's window. The capture reuses `midi_recorder` without writing a session take; with the simulator it plays the melody itself with some jitter and mistakes.

---

### 4.9. Scores (`score.rs`)
- **Model:** ticks at 480 per quarter note; two staves of notes (`treble` = right hand, `bass` = left hand). Only notes are stored: **rests are the gaps** between them (the editor derives them). A staff has one rhythm: notes never overlap, except a **chord** (notes that start at the same tick, last the same and have different keys; a note put where others start joins them and takes their value). A note never crosses a bar line; to hold one over it, **tie** it (`tie = true`) to the note of the same key that starts where it ends, and the two sound as a single note. The first bar can be a shorter **pickup** (anacrusis): `pickup_ticks` is its length and it is the end of a bar, so beats keep their place (`barSpans` / `missing_ticks`), and its bar has no number (the first whole bar is 1). A score with a pickup ends with a **closing bar** of what the pickup lacks (a 3-beat pickup in 4/4 is followed at the end by a 1-beat bar), so the two make one whole bar: `scoreTicks` is `(bars - 1) × bar`, `bars` counts both short bars, and a score with a pickup has at least 2 bars. Setting a pickup adds that bar (and taking it away removes it), so the score keeps its length. An empty whole bar is a single whole rest; an empty short bar (the pickup or its closing bar) is filled with the rests of its beats counted as in a whole bar, so a 3-beat pickup in 4/4 has a quarter rest and a half rest. Allowed values: whole, half, quarter, eighth and sixteenth, plain or dotted (a dotted whole note never fits a bar). `key` is the sounding MIDI key (21-108) and `accidental` (`sharp` | `flat`) only spells a black key; a white key has none. Every black key is drawn with its sharp or flat, and the staff adds a natural sign when a plain note follows an altered one on the same line or space in the same bar (accidentals last until the barline); there are no key signatures.
- **Validation:** `score::check` (mirrored by `validateScore` in `core/score.ts`): tempo 30-240, time signature, 1-64 bars, a pickup shorter than a bar in sixteenths, unique note ids, key and accidental, a valid value, inside the score, not crossing a bar line, no overlap that is not a chord, and every tie joined to a note.
- **MIDI:** both hands on channel 0, notes sounding for their whole value, a chain of tied notes as one note, note-offs before everything else at the same instant so a repeated key is struck again, and the file lasts the whole score (trailing rests included).
- **Repeat:** `repeat` closes the score with a repeat sign. The MIDI plays the whole score twice (`play_ticks`; the second pass is the first one shifted by the score's length, note-offs first at the seam), the file and `duration_ms` last both passes, and the editor's playhead shows the second pass over the first one (`pageTick`). The score itself (bars, `scoreTicks`, layout) is unchanged.
- **Storage:** the notation that has no column of its own (both staves, `pickup_ticks`, `repeat` and `closing_bar`) is the JSON in `scores.data_json`, so adding to it needs no migration; a score stored before a field existed reads it as its default (no tie, no pickup).
- **Saving (`save_score`):** validates, writes `frag_<id>.mid` atomically (the id is the stored fragment's, or a new one for the first save with notes), then in one transaction creates or updates the fragment in the hidden scores session, stores the notation and **adapts the clips** that use the fragment: their windows (in the fragment's time) follow the music when the tempo changes and are clamped to the new length (a clip left with nothing is deleted), their speed follows the composition's tempo, and the clips that grew push the next ones. A score with no notes that never had a fragment only stores the notation.
- **Deleting:** the score, its fragment, its file and the clips that use it. Deleting the fragment by other means only detaches the score (`fragment_id = NULL`); the next save creates a new one.
- **Playback:** `play_score` plays the score as it is in the editor, saved or not, under the key `score:<id>`; `update_score_playback` swaps the notes of the one that is playing, keeping the position.

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

### Scores
- `get_scores() -> Result<Vec<ScoreSummaryDto>, String>`
- `create_score(title: String) -> Result<ScoreDto, String>` (an empty title gets the default one; no fragment yet)
- `get_score(score_id: String) -> Result<ScoreDto, String>`
- `save_score(score: ScoreDto) -> Result<ScoreDto, String>` (the whole score; regenerates its fragment; an invalid score is refused)
- `delete_score(score_id: String) -> Result<(), String>`
- `play_score(score: ScoreDto, start_ms: u64) -> Result<(), String>` (progress as `score:<id>`)
- `update_score_playback(score: ScoreDto) -> Result<(), String>` (only if that score is the one loaded)
- `preview_note(key: u8) -> Result<(), String>` (one piano key for a moment)

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

### Challenge Mode
- `get_melodies() -> Result<Vec<MelodySummaryDto>, String>`
- `get_melody_detail(melody_id: String) -> Result<MelodyDetailDto, String>` (melody, notes, attempts with their detail and, for a melody that came from a score, its notation: the frozen copy kept with it or, for a melody made before copies were kept, the score its fragment still belongs to)
- `create_melody_from_fragment(fragment_id: String, title: Option<String>) -> Result<MelodyDto, String>`
- `import_melody(path: String, title: Option<String>) -> Result<MelodyDto, String>`
- `rename_melody(melody_id: String, title: String) -> Result<MelodyDto, String>`
- `delete_melody(melody_id: String) -> Result<(), String>`
- `delete_attempt(attempt_id: String) -> Result<(), String>`
- `add_starter_melodies() -> Result<Vec<MelodyDto>, String>` (the missing ones; returns those added)
- `start_challenge(melody_id: String, port_id: String, tempo_pct: u32, metronome_on: bool, guide_on: bool, live_synth_on: bool) -> Result<ChallengeStarted, String>`
- `stop_challenge() -> Result<(), String>` (kept as incomplete, unless nothing was played)
- Events: `challenge-note` (each played note, classified), `challenge-progress` (every 50 ms) and `challenge-finished` (whichever way the attempt ended).

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
   - Six views: **Sessions**, **Repertoire**, **Challenges**, **Scores**, **Compose** and **Statistics**.
   - The menu can be **collapsed to a bar of icons** (64 px, from the arrow in its header, and expanded again from the one at the top of the bar) to leave room for the content, as in a web app: only the icons of the views (their names on hover), the keyboard status and the Settings button stay. The choice is remembered on this machine.
   - "+ New Practice Session" button and the chronological list of sessions (in the Repertoire view: "+ New piece" and the list of pieces, the archived ones apart).
   - Quick USB-MIDI port selector and Settings button (with the name of the open vault) in the sidebar footer.
   - Without an open vault, the app shows a welcome screen: create a vault (name + location), open an existing one, recent ones and import of the previous version's data.
2. **Session Header and Recording / Metronome Panel:**
   - Editable session title and date.
   - Metronome controls: numeric/slider BPM selector ($40 - 240$), metronome toggle, live synthesizer monitoring switch, and the main **Record / Stop** button with a live timer.
3. **Raw Take and Slicer Area:**
   - Visible when the session has a master recording (`raw_midi_path`).
   - Interactive timeline drawn as a **piano roll** or as density blocks; the choice is kept on this machine. The roll shows:
     - each note, with opacity ∝ velocity;
     - a **beat grid** from the session BPM, anchored at the first note and heavier every 4 beats (4/4 is assumed: no time signature is stored);
     - a 12 px **sustain-pedal lane** with a "Ped" label at each press, and a faint **tail** on every note the pedal keeps sounding (until the pedal goes up or the key is struck again);
     - a **tooltip** on the note under the pointer: name, value (whole ... 32nd, dotted half and quarter; boundaries lean downwards because players lift keys early) with its length in beats, milliseconds, velocity and, with the pedal, how long it rings. The value is the finger length (key down to key up), as in notation;
     - a legend under the timeline.
   - **Zoom** (buttons and Ctrl + wheel, up to 1 px per millisecond) on the raw take; the view follows the playhead while playing. The fragment player and the Repertoire comparison show the grid, pedal and tooltip but have no zoom.
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
8. **Challenges:**
   - Sidebar: "Import .mid…" and the melody list (attempts and best score). Each fragment card has "Use as a challenge".
   - Main area: title, tempo (40-150 %, effective BPM), metronome / guide / live synth switches, a start/stop button with the record at this tempo, and "Listen" at the chosen tempo.
   - A piano roll that scrolls past a fixed playhead, with a count-in overlay; notes turn green when hit and red when missed, and wrong/extra notes appear as red marks. Live counters and the ghost ("+3 vs record").
   - **A challenge made from a score shows its notation instead:** the grand staff (the editor's, read-only) with the notes coloured as they are played (green when hit, light green when good, red when missed), the played notes that hit nothing as red crosses on the line of their key, and a playhead that follows the attempt (waiting on the first note during the count-in, and showing the second pass of a repeat over the first). Clicking a mistake in the result puts the playhead there. Melodies recorded by hand, imported or bundled keep the piano roll, and so does a melody whose score no longer matches its notes.
   - Result card: accuracy, score, new record, comparison with the record and the previous attempt, timing tendency, the list of mistakes (clicking one highlights it on the roll), retry and the suggested tempo (+5 % from 90 % accuracy, −10 % under 50 %). Then the attempt history.
   - In **Statistics**, a "Challenge progress" section: a table of every melody (attempts, best score, mastered tempo, recent accuracy sparkline, trend) and, per melody, key figures, accuracy per attempt with the best so far, tempo per attempt and a map of the notes missed most in the last 10 completed attempts.
9. **Composer:**
   - The sidebar lists the compositions; a new one starts with one empty piano track and a drop zone that explains the three steps.
   - Header (editable title, tracks · clips · length, Export MIDI / Export WAV, undo, redo, delete) and a transport bar (to the start, play/pause, stop, A-B loop, position, the composition's **tempo** in BPM with "Match all", snap to clip edges / seconds / off, speed and zoom).
   - Multitrack timeline: a ruler (click to seek, drag to set the loop) and one row per track with its colour, editable name, M / S, instrument and volume. Clips show their fragment's piano roll; they are dragged between tracks (Alt copies), trimmed by their edges and repeated with a tab on their corner. A row at the bottom takes a fragment onto a new track.
   - Library of fragments grouped by piece, with search, a piece filter and "In use ×N"; a fragment is dragged onto the timeline or added at the playhead of the active track with a click or Enter. Fragments that come from a score carry a "Score" badge and their tempo.
   - Inspector of the selected clip: start, length, trims, transposition, repeats and **speed** steppers, "Match tempo", Split at the playhead, Duplicate, Remove and a link to its session (to its score, for a clip of a score). A clip that does not play at 100 % shows its speed on the timeline.
   - Instrument dialog: 16 families, a search across the 128 programs, a preview of each one, the programs the SoundFont lacks disabled, and whether the track plays the sustain pedal.
   - Shortcuts: Space, Ctrl+Z / Ctrl+Shift+Z, S (split), Ctrl+D (duplicate), Delete, arrows (move 0.1 s, Shift: 1 s), Esc, Shift+M / Shift+S (mute / solo the active track).
   - Deleting a fragment or a session that a composition uses says so in the confirmation; its clips go with it.
10. **Score editor:**
   - The sidebar has "+ New score", a search box and the list of scores (tempo, bars and notes).
   - Header (editable title, bars · notes · length, "Use as a challenge", undo, redo, delete) and nothing else: all the controls are in the tools panel.
   - **Tools panel, fixed at the left side** while the score scrolls (so a long score never takes anything out of reach; on narrow windows it becomes a bar that sticks to the top; if it is taller than the window it scrolls inside): the transport (to the start, play/pause, stop, position), the palette, the selected note, and the score's settings (tempo in BPM, time signature 4/4, 3/4 or 2/4, number of bars, pickup, repeat, speed and zoom). Palette: whole, half, quarter, eighth and sixteenth notes, a dot, a tie and sharp and flat buttons, the selected note and its remove button. The *Pickup* selector offers none, or up to a bar less half a beat.
   - Palette (cont.): A value is **dragged onto the staff** (pointer events, so it also works by touch) or chosen and then clicked on the staff; a note is dragged to move it in time, pitch and from one hand to the other, and a preview shows where it would land (red if it does not fit). Rests appear on their own in the gaps.
   - The grand staff (SVG): treble clef above for the right hand, bass clef below for the left. Like a printed score it is broken into **systems** (lines) stacked from top to bottom: the bars fill the width of the view and the next ones continue on a new line, each with its own clefs (the time signature only on the first) and with the bars stretched to fill the line except on the last, so there is no horizontal scrolling; resizing the window or changing the zoom lays the lines out again. Each line has a ruler with bar numbers (click to move the playhead), beat guides, and a tie that crosses a line break is drawn as two arcs. The playhead follows playback, scrolls to its line and lights up the notes that sound. Playback uses the notes as they are in the editor and follows the edits while it plays.
   - Saved automatically; it shows up in the composer's library as a fragment.
   - A note selected by clicking it is edited by the palette, which shows its value: choosing a value gives it that value, plain (the dot is a separate button, so choosing half for a dotted half note makes a half note), and toggling the dot dots or undots it. If the new value does not fit it says so and the palette goes back to the note's value. A note that was just placed is selected too (for the arrow keys), but the palette is then the tool for the next one; with nothing selected it is too.
   - Chords: a note put on the beat of another takes its value and joins it, with one stem and the neighbouring heads on either side of it. Ties are arcs on the side opposite the stem, across bar lines too; T ties the selected note to the next one of the same pitch (adding it, in the next bar if it ends at a bar line) or unties it.
   - A repeat button in the transport bar closes the score with a repeat sign (two dots in each staff before the final double bar): the score is played twice, from the start, and its length shows both passes.
   - Shortcuts: Space, Ctrl+Z / Ctrl+Y, 1-5 (value), `.` (dot), `#` and `b` (sharp, flat), `T` (tie), arrows (a line or space, an octave with Shift; a grid step in time), Delete, Esc.
