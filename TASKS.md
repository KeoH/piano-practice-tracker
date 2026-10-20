# Implementation Task Plan (Piano Practice Tracker)

This document breaks down the sequential and parallelizable tasks needed to build the complete MVP.

## Phase 1: Project Setup and Environment
- [x] **1.1. Check the system dependencies on Ubuntu:** Make sure `cargo`, `node`, `npm`, `pkg-config`, `libasound2-dev` and `libwebkit2gtk-4.1-dev` are installed.
- [x] **1.2. Angular + Tauri v2 scaffolding:**
  - Initialize the Angular project (Standalone, SCSS/TailwindCSS) and set up `@tauri-apps/cli` and `@tauri-apps/api`.
  - Configure `src-tauri/Cargo.toml` with all the dependencies (`tauri`, `midir`, `midly`, `rustysynth`, `cpal`, `rusqlite`, `tokio`, `reqwest`, `serde`, `uuid`, `chrono`).
- [x] **1.3. SoundFont (`.sf2`) generator / provisioner:**
  - Create a Rust module (`sf2_builder.rs`) that checks on startup whether `~/.local/share/piano-tracker/assets/default_piano.sf2` exists and, if it doesn't, programmatically builds a valid `.sf2` SoundFont with harmonic acoustic piano waveform samples (or copies it from bundled resources), so that `rustysynth` works 100% *offline* from the very first launch without relying on external downloads that could fail.

## Phase 2: SQLite Persistence Layer and Offline-First Queue
- [x] **2.1. Database initialization (`db.rs`):**
  - Create the directories under `~/.local/share/piano-tracker/` (`midi/raw`, `midi/fragments`, `media`, `assets`).
  - Run the DDL migrations for `sessions`, `midi_fragments`, `timeline_comments`, `session_media`, `sync_queue` and `app_settings`.
- [x] **2.2. CRUD repositories and automatic queueing:**
  - Implement functions to manage sessions, fragments, timeline comments and images.
  - Make sure every creation/modification of a `.mid` file, image or session automatically inserts a task into `sync_queue` and sets `sync_status = 'PENDING'`.
- [x] **2.3. Database unit tests:**
  - Write Rust tests (`#[cfg(test)]`) covering session creation, cascading insertion of fragments and comments, and automatic registration in `sync_queue`.

## Phase 3: Native MIDI Engine and Destructive Slicing
- [x] **3.1. MIDI capture with `midir` (`midi_recorder.rs`):**
  - Implement enumeration of ALSA MIDI ports and a virtual/simulator test port for when no physical keyboard is connected during testing.
  - Implement a recording thread that captures events with a relative timestamp in microseconds and saves them to a valid `.mid` file using `midly`.
- [x] **3.2. MIDI activity analyzer (`midi_slicer.rs`):**
  - Implement `analyze_midi_activity(path)`, which parses the `.mid` with `midly` and returns the activity blocks (`Vec<ActivityBlock>`) and the total duration in milliseconds.
- [x] **3.3. Destructive slicing engine (`midi_slicer.rs`):**
  - Implement `extract_fragment_and_trim(source_path, start_ms, end_ms, dest_path)`:
    - Extract the range into the new `.mid` file with times normalized to $0$, the sustain pedal state (`CC 64`) preserved at the start, and clean note closing (`NoteOff`) at the end.
    - Cut that same range out of the master file `source_path`, shifting the later events back.
  - Implement `discard_range(source_path, start_ms, end_ms)` to delete unwanted sections from the raw file.
- [x] **3.4. MIDI slicing unit tests:**
  - Create unit tests that generate a 60-second test `.mid` file with notes and sustain pedal, extract a fragment from second 10 to 25, and check that the fragment lasts 15 seconds and the original track now lasts 45 seconds with no hanging notes.

## Phase 4: Audio Engine, Synthesizer (`rustysynth`) and Metronome (`cpal`)
- [x] **4.1. Synthesizer and audio output (`audio_engine.rs`):**
  - Initialize the `cpal` audio stream on a dedicated thread controlled through channels/shared state (`Arc<Mutex<AudioState>>`).
  - Load the SoundFont into `rustysynth::Synthesizer`.
- [x] **4.2. Metronome generator:**
  - Implement the generator of audible clicks at the configured BPM (active during recording if the user enables it).
- [x] **4.3. MIDI playback sequencer:**
  - Implement playback of `.mid` files in `audio_engine.rs` with support for `play`, `pause`, `stop` and `seek(ms)`.
  - Emit `playback-progress` events to the Angular frontend every $50\text{ ms}$.

## Phase 5: Google Drive Sync (OAuth2 + Worker)
> Replaced by the vaults in Phase 10: `drive_sync.rs` and the `sync_queue` were removed.

- [x] **5.1. OAuth2 loopback flow (`drive_sync.rs`):**
  - Implement an ephemeral local server on `127.0.0.1` to capture the Google OAuth2 callback, exchange the code for tokens (`access_token`, `refresh_token`) and persist them in `app_settings`.
- [x] **5.2. Google Drive API v3 client:**
  - Implement resolution/creation of the visible folder structure: `PianoTracker/`, `PianoTracker/midi/` and `PianoTracker/media/`.
  - Implement file uploads (`multipart/related`) and a backup of `piano_tracker_backup.sqlite`.
- [x] **5.3. Asynchronous offline-first worker:**
  - Create a background task (`tokio::spawn`) that processes `sync_queue` when there is a network connection and credentials are configured, emitting the sync status to the frontend.

## Phase 6: Tauri IPC Command Integration (`lib.rs` / `main.rs`)
- [x] **6.1. Exposing the Tauri commands:**
  - Wire all the modules (`db`, `midi_recorder`, `midi_slicer`, `audio_engine`, `drive_sync`) into Tauri's managed state (`tauri::State`).
  - Register all the `@tauri::command`s defined in `specification.md`.
- [x] **6.2. Backend build check:**
  - Run `cargo test` and `cargo check` inside `src-tauri`, making sure there are zero errors.

## Phase 7: Angular Frontend - Services, Sessions and Markdown Editor
- [x] **7.1. IPC services and TypeScript models:**
  - Create `TauriApiService` with strict typing for all commands and subscriptions to the `playback-progress` and `sync-status` events.
- [x] **7.2. Main layout, sidebar and Google Drive modal:**
  - Build the session sidebar with filters, cloud sync status, MIDI device selector (including simulator mode) and the Google Drive settings modal.
- [x] **7.3. Recording header and metronome:**
  - Build the recording control panel with BPM selector, metronome toggle, live monitoring toggle and record button with a live time indicator.
- [x] **7.4. Markdown editor with image support:**
  - Build the session notes editor with split/preview view, intercepting image `paste` and `drop` to save them locally through `save_session_image` and render them in the Markdown.

## Phase 8: Angular Frontend - Visual Slicer and Player with Comments
- [x] **8.1. Raw take slicer component (`MidiSlicerComponent`):**
  - Draw the MIDI activity blocks returned by the backend on a `<canvas>`.
  - Implement draggable start and end slice handles (`start_ms`, `end_ms`), preview of the selected section, an **"Extract Fragment"** button (with a title and explanation form) and a **"Discard Section"** button.
- [x] **8.2. Fragment and timeline component (`FragmentPlayerComponent`):**
  - Build the interactive player for each fragment with a progress bar, `Play/Pause/Stop` controls and activity blocks.
  - Render the **markers (pins)** on the timeline for each comment.
  - Show the automatic **floating popup** over the timeline when playback reaches the comment's second or when hovering over the pin.
  - Build the **side list of comments** sorted by second (jumping straight to it on click) and the quick input to add new comments at the current instant.

## Phase 9: End-to-End Validation and Final Polish
- [x] **9.1. Full frontend and backend build:**
  - Run `npm run build` to validate that Angular compiles without template or type errors.
  - Run `cargo test` and `cargo build` in `src-tauri` to validate that the Linux desktop binary builds cleanly.
- [x] **9.2. Checklist review:**
  - Mark all completed tasks in `task.md`.

## Phase 10: Vaults Instead of Google Drive
- [x] **10.1. Remove the Google Drive sync:**
  - Delete `drive_sync.rs`, its commands, the `sync-status` event, `SyncStatusDto` and the `reqwest`, `url`, `sha2`, `rand`, `tokio` and `tauri-plugin-shell` dependencies.
- [x] **10.2. Database v2 (`db.rs`):**
  - Migration that drops `sync_queue`, `sync_status`, `drive_file_id` and the Google settings.
  - Paths relative to the vault in the database and in the Markdown images; the API returns them absolute.
  - `journal_mode = DELETE` so the database is a single file at rest.
- [x] **10.3. `vault.rs` module:**
  - Machine configuration in `~/.config/piano-tracker/config.json` (current vault, recent ones, SoundFont).
  - Create, open and close vaults, lock per computer and pid, warning about conflicting copies, and import of the previous version's data.
- [x] **10.4. Frontend:**
  - `VaultStore`, welcome screen (`vault-welcome`) and *Vault* tab in Settings (`settings-dialog`).
  - Remove the cloud indicators from the sidebar, the session header and the fragments.
  - Markdown images with paths relative to the vault.
- [ ] **10.5. Manual check with `npm run tauri dev`:**
  - Import the old data into a vault inside Dropbox and check sessions, playback and images.
  - Record with the simulator, slice and paste an image: everything must end up inside the vault.
  - Copy the vault to another path, open it with "Open another vault…" and check that everything works.
  - Open the same vault in two instances: the second one must warn about the lock.

## Phase 11: Multi-language Support (English and Spanish)
- [x] **11.1. Shared language files:** `src/locales/en.json` (reference) and `es.json`, used by both Angular and Rust.
- [x] **11.2. Backend (`i18n.rs`):**
  - `t!` macro, system language from environment variables with English as the fallback, and the preference in `AppConfig.language`.
  - `get_language` / `set_language` commands.
  - Translated error messages and key/placeholder parity tests.
- [x] **11.3. Frontend:**
  - `I18nService`, `t` / `tp` pipes, `LanguageStore`, typed keys and dates with `Intl` according to the language.
  - All components translated.
  - Language selector in Settings → General and on the welcome screen.
- [ ] **11.4. Manual check with `npm run tauri dev`:**
  - Start with `LANG=es_ES.UTF-8` (Spanish) and with `LANG=fr_FR.UTF-8` (English).
  - Change the language in Settings without reloading and check that it is kept after a restart.
  - Trigger a backend error (e.g. creating a vault in a non-empty folder) and see it in the chosen language.

## Phase 12: English as the Project's Official Language
- [x] **12.1.** Comments, doc comments, logs, test messages and test data translated into English in Rust, TypeScript, HTML and CSS.
- [x] **12.2.** `CLAUDE.md`, `SPECIFICATIONS.md` and `TASKS.md` translated into English.

## Phase 13: CI/CD with GitHub Actions
- [x] **13.1. Frontend tests:** Vitest through `@angular/build:unit-test` (`npm test`, `npm run test:ci` with v8 coverage) and specs for `format`, `markdown` and `I18nService`.
- [x] **13.2. CI (`ci.yml`, every PR):** frontend build + tests, Rust tests with `cargo-llvm-cov`, and a coverage table in the job summary and a sticky PR comment.
- [x] **13.3. Releases (`release.yml`, every push to `main`):** release-please with Conventional Commits keeps the version in sync across `package.json`, `Cargo.toml`, `Cargo.lock` and `tauri.conf.json`; merging the release PR tags `vX.Y.Z` and attaches the `.deb`, `.AppImage` and `SHA256SUMS.txt` to the GitHub Release.
- [ ] **13.4. GitHub configuration (manual):**
  - Settings → Actions → General: "Read and write permissions" and "Allow GitHub Actions to create and approve pull requests".
  - Branch protection on `main` requiring the `Frontend` and `Backend` checks; squash merge with Conventional Commit titles.
  - Optional: a PAT in the `RELEASE_PLEASE_TOKEN` secret so the release PR also runs CI.
- [ ] **13.5. First release:** open a test PR (CI + coverage comment), merge it, merge the release PR and install the published `.deb`.
- [ ] **13.6. More frontend tests:** stores (`SessionStore`, `PlaybackStore`, `RecordingStore`, `VaultStore`) with `TauriApiService` mocked.

## Phase 14: Practice Tools, Analysis and Repertoire
- [x] **14.1. Schema v3 (`db.rs`):** `pieces`, `midi_fragments.piece_id` / `passage`, `practice_log` (backfilled from the existing sessions) and `raw_history`.
- [x] **14.2. Undo trims (`raw_history.rs`):** copy of the raw take before each trim in `midi/history/`, 10 steps per session, `undo_raw_trim`, an Undo button and Ctrl+Z in the slicer. A new recording clears the history.
- [x] **14.3. A-B loop and speed (`audio_engine.rs`):** position in file time advancing at `rate`, loop of the loaded file in the backend, `TimelineDrag` + `range-handles` shared by the slicer and the fragment loop, speed selector.
- [x] **14.4. Piano roll (`midi_notes.rs`, `timeline-canvas`):** `get_midi_notes`, notes drawn into cached layers per colour, pedal strip, and a roll / density toggle kept in `localStorage`.
- [x] **14.5. Cut suggestions:** `suggest_midi_segments` (silence with the pedal counted as sound), clickable passages over the timeline, and `discard_midi_ranges` to discard every silence as one undo step.
- [x] **14.6. WAV export (`wav.rs`):** offline render streamed to a 16-bit WAV with the current SoundFont, for fragments and raw takes.
- [x] **14.7. Practice statistics:** `practice_log` filled by `stop_recording`, `get_practice_stats` / `set_weekly_goal`, `core/stats.ts` (streaks, week, heatmap) and the *Statistics* view.
- [x] **14.8. Repertoire:** CRUD of pieces, `assign_fragment_piece`, `piece-picker` in the fragment card and the extract dialog, the *Repertoire* view with takes by passage and the comparison of two takes.
- [x] **14.9. Navigation:** `NavStore` and the Sessions / Repertoire / Statistics switch in the sidebar.
- [x] **14.10. UI check in headless Chrome** with the Tauri IPC mocked (screenshots of the slicer, suggestions, fragment loop, statistics and repertoire, in English and Spanish).
- [ ] **14.11. Manual check with `npm run tauri dev`:**
  - Open a copy of a v2 vault: it migrates and the statistics show the backfill.
  - Record about 60 s with the simulator → "Suggest cuts" → extract one passage → undo: the fragment disappears and the take gets its duration back. "Discard the silences" → a single undo reverts it.
  - In a fragment: loop over a passage at 70 %; it must sound in a loop without hanging notes.
  - The roll / bars toggle is kept after a restart.
  - Export a WAV and open it in an external player.
  - Create a piece, file two fragments from different sessions under the same passage and compare them in Repertoire.
  - Switch to English and check there is no untranslated text.
