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

## Phase 15: Composer
- [x] **15.1. Schema v4 (`db.rs`):** `compositions`, `composition_tracks` and `composition_clips` (clips point to fragments and disappear with them), whole-document save with validation, the fragment library and `count_composition_uses`.
- [x] **15.2. Mixdown and playback (`composition.rs`, `audio_engine.rs`):** clips flattened into one event list with a channel and program per track, `play_sequence` / `replace_sequence` for sequences built in memory, and a live per-channel mix (volume, mute, solo).
- [x] **15.3. Composer view:** `CompositionStore` (undo history, delayed save), `core/composition.ts` (snap, fit, trim, split), the timeline with clip drag / trim / repeat, the fragment library, the clip inspector, the sidebar list and the shortcuts. The view is loaded with `@defer`.
- [x] **15.4. Instruments:** the General MIDI names in the locales, `get_soundfont_programs`, `preview_instrument` and the instrument dialog with the sustain switch.
- [x] **15.5. Export:** `export_composition_audio` (WAV as heard) and `export_composition_midi` (SMF format 1, one named track per voice).
- [x] **15.6. Deleting with a warning:** the confirmation to delete a fragment or a session says how many compositions use it.
- [ ] **15.7. Manual check with `npm run tauri dev`:**
  - Create a composition, drag three fragments onto two tracks, and set the second one to Flute.
  - Play it and, while it sounds, mute, solo and move a volume: no note is cut.
  - Trim a clip, repeat it ×4, split it with S and undo with Ctrl+Z.
  - Loop a range dragged on the ruler.
  - Export the WAV and the MIDI and open the `.mid` in another program (one track per voice).
  - Delete a fragment used in the composition: the confirmation says so and its clip disappears.
  - Reopen the vault: the composition is still there.

## Phase 16: Challenge Mode
- [x] **16.1. Scoring core (`challenge.rs`):** notes from MIDI events, hit window scaled by the tempo, matching (hit / wrong / extra / missed), score and accuracy, latency compensation; the same `Matcher` live and offline.
- [x] **16.2. Schema v5 (`db.rs`):** `melodies` and `challenge_attempts`, files in `midi/melodies/` and `midi/attempts/` (created on the first write), CRUD with paths relative to the vault; migration test from a v4 vault.
- [x] **16.3. Live challenge:** `ChallengeRunner` (count-in, ticker, auto end), capture without a session take and scripted simulator in `midi_recorder`, metronome aligned with the count-in, guide at the challenge tempo, commands and `challenge-*` events.
- [x] **16.4. Challenges view:** `ChallengeStore`, melody list in the sidebar, challenge view, piano roll, result card, history and "Use as a challenge" on fragments.
- [x] **16.5. Challenge progress in Statistics:** melody table with sparklines, key figures, accuracy and tempo charts, and the error map.
- [x] **16.6. Translations (English and Spanish) and specs for `challenge-stats` and `music`.**
- [ ] **16.7. Manual check with `npm run tauri dev`:**
  - Open an existing v4 vault: it migrates to v5, keeps sessions, pieces and compositions, and the five starter melodies appear in Challenges.
  - Listen to each starter melody at 100 % and check it sounds right.
  - Turn a fragment into a challenge and import an external `.mid`.
  - With the simulator, play attempts at 60 % and 100 %: the count-in matches the metronome, notes change colour live, the ghost appears, and the result lists the mistakes and suggests a tempo.
  - "Listen" at 80 % and then check that the speed selector of the players still shows the previous speed.
  - Stop an attempt halfway: it shows as incomplete and does not count for the record.
  - Check the challenge progress in Statistics and switch the language without reloading.
  - With a real keyboard, play "on time" and check that the mean offset stays close to 0 ms.
- [x] **16.8. Starter melodies:** five public-domain tunes added once per vault, and "Add the starter melodies" to bring back the deleted ones.

## Phase 17: Android Build
- [x] **17.1. Android project:** `tauri android init` (`src-tauri/gen/android`), application id `dev.fmanzano.pianotracker` (the Tauri identifier and the AppStream id were renamed from `com.keoh.pianotracker`), minSdk 24.
- [x] **17.2. Native MIDI input:**
  - `NativeMidi` trait and `native:<id>` ports in `midi_recorder.rs` (`midir` only on non-Android targets), `split_midi_messages` for the chunks the Android service delivers, and tests with a fake backend.
  - `plugins/android-midi` (Rust + Kotlin `MidiPlugin` over `MidiManager`) and `android_midi.rs` adapting it to the recorder.
- [x] **17.3. Platform adaptations:** machine directories from Tauri's path resolver, a single vault in the external files directory (fallback: private storage), `open_with_desktop` unsupported on Android, `oboe-sys` with `shared-stdcxx` and `libc++_shared.so` copied into the APK, and a retry in `TauriApiService.call` for the "state not managed" error while the backend is still starting.
- [x] **17.4. Build and run on a device:** debug APK with `source ~/.local/android-env.sh && npx tauri android build --debug --apk --target armv7`, installed with `adb install -r` on a Samsung Galaxy Tab A (SM-T510, Android 11, `armeabi-v7a`). Verified on the device by the author.
- [ ] **17.5. Pending:**
  - Build and try `aarch64` (a 64-bit device) and an emulator (`x86_64`).
  - Record, slice and play back with a USB-MIDI keyboard through an OTG adapter, and check that the vault is readable over MTP.
  - Check the first run of the `android` CI job (it builds a debug APK for arm64 and armv7 and uploads it as the `android-debug-apk` artifact; the workflow could not be run locally), and, if wanted, a signed release build and publishing the APK with the releases.
  - Mobile layout: the UI is the desktop one.

## Phase 18: Note Durations and Pedal on the Piano Roll
- [x] **18.1. Note values (`core/music.ts`):** `noteValue` names a duration at a BPM (whole ... 32nd, dotted half and quarter) with boundaries that lean downwards, and always gives the length in beats; `beatMs`.
- [x] **18.2. Timeline canvas (`timeline-canvas`):** beat grid anchored at the first note (4/4), 12 px pedal lane with "Ped" labels, faint tails for notes the pedal keeps sounding, hover tooltip, and a drawing window (`viewStartMs` / `viewSpanMs`) so the canvas stays as wide as the viewport.
- [x] **18.3. Zoom (`core/timeline-zoom.ts`):** `TimelineZoom` (zoom, scroll, follow the playhead, Ctrl + wheel with a non-passive listener) and `timeline-zoom-controls`, in the slicer only: the fragment player's comment pins sit outside the track.
- [x] **18.4. Legend and translations:** `timeline-legend` and the `timeline.*` keys in English and Spanish; specs for `noteValue` and the zoom math.
- [ ] **18.5. Manual check with `npm run tauri dev`:**
  - Record with the simulator at 90 BPM: the grid lines up with the first note and the metronome; a note held for 4 beats says "whole note" and spans four grid cells; a quarter released slightly early still says "quarter".
  - The pedal lane is visible and labelled, distinct from the selection colour, and pedalled notes show their tail up to the pedal release.
  - Zoom with the buttons and Ctrl + wheel: selecting, the handles, click-to-seek, the suggestion chips and the playhead stay right while zoomed and scrolled.
  - Check the Fragments tab and the Repertoire comparison, switch to Spanish, and check that the density bars mode is unchanged.

## Phase 19: Score Editor (staff notation for the composer)
Goal: write a fragment on a grand staff (treble clef for the right hand, bass clef for the left) by dragging note values onto bars, and use it in the composer like any recorded fragment.

Design decisions (recorded here so they are not re-litigated):
- **The score document is the source of truth.** Its `.mid` file is derived output. Converting MIDI back to notation loses information (quantization, accidental spelling, voices), so MIDI → score import is out of scope.
- **A saved score is a real fragment.** Saving regenerates `midi/fragments/frag_<id>.mid` and keeps the fragment id stable, so the library, composer, mixdown, WAV / MIDI export and "Use as a challenge" work unchanged.
- **Storage: a `scores` table plus a system session** (decided). `midi_fragments.session_id` is `NOT NULL` with `ON DELETE CASCADE` and ~26 queries in `db.rs` rely on it. Making it nullable needs a table rebuild, and dropping `midi_fragments` with `foreign_keys = ON` would cascade-delete `composition_clips` and `timeline_comments` (the migration would have to turn the pragma off outside the transaction). Instead, v6 adds `sessions.kind TEXT NOT NULL DEFAULT 'practice'` (a plain `ADD COLUMN`) and one `kind = 'scores'` session per vault, created on demand and excluded from `list_sessions` and anything that counts sessions. Its title is translated for the library (`backend.scores.sessionTitle`).
  - *Alternative, not chosen:* nullable `session_id` and `LEFT JOIN sessions` everywhere. Cleaner data model, but a riskier migration on a real vault and a wider change.
- **Model in ticks at 480 TPQ** (the resolution `midi_slicer` writes), never in ms. Tempo is stored on the score (decided); the fragment's `bpm` and `duration_ms` are derived from it when saving.
- **Both hands become one fragment on one channel** (decided). A composition track is one instrument, so the right and left hands are merged when the MIDI is generated; they stay separate in the score.
- **Tempo adapts in the composer** (decided). A score has its own tempo while it is written, but once it is placed next to other fragments it must follow the composition's tempo. The composer works in milliseconds and a clip cannot change speed today, so this adds two things, both plain `ADD COLUMN`s in v6:
  - `compositions.bpm` (nullable: unset until the user or the first clip sets it; exports use it instead of the nominal 120).
  - `composition_clips.rate_pct` (default 100): the clip plays its window at that speed, without changing pitch (MIDI events are just rescaled). `length_ms` and `trim_start_ms` stay in the fragment's own time; the clip occupies `length_ms × repeats × 100 / rate_pct` on the timeline. That formula lives in one place on each side (`db::clip_end_ms`, `clipEnd` in `core/composition.ts`) and `composition.rs` scales the events of a clip by it.
  - A clip of a score gets `rate_pct = composition_bpm / score_bpm × 100` automatically when it is placed or when the composition's tempo changes (the score's tempo is exact). Recorded fragments are not touched, because their `bpm` is only the metronome setting and not necessarily how it was played; they get a manual "Match tempo" action in the clip inspector (and "Match all" in the transport bar).
- **Schema number:** every branch (`feat/*`, `main`) is at v5 and the real vault (`~/Dropbox/Musicalia`, a read-only copy) has `user_version = 5` → this is **v6**. Re-check `SCHEMA_VERSION` on all branches before starting (see the schema memory).
- **Rendering:** SVG, no canvas (testable in jsdom, scales on the tablet). Engraving with **VexFlow 5** (MIT, TypeScript, SVG) with **Bravura** (SIL OFL) bundled locally from `angular.json`/`@fontsource`-style assets because the app works offline (VexFlow's quick start loads the font from a CDN). The editor lives in a `@defer` chunk like the composer. Fallback if VexFlow's layout fights the hit-testing: a small own SVG engraver for the MVP subset (staff lines, noteheads, stems, flags, rests, accidentals), since the subset is small.
- **Interaction:** own hit layer over the SVG: y → diatonic step on that clef → MIDI key (+ accidental); x → bar and snapped tick. **Pointer events, not HTML5 drag and drop** (WebKitGTK / Tauri intercept it; touch must work on Android).

MVP scope:
- In: grand staff, 4/4, 3/4 and 2/4, whole to sixteenth notes and rests, dotted values, drag from a palette to the staff, select / move / delete, sharp / flat / natural with shortcuts, a bar that never holds more than its capacity (free space is filled with rests), playback and save → library fragment.
- In (composer side): `compositions.bpm` and per-clip `rate_pct` so scores follow the composition's tempo.
- Deferred: chords per hand (several notes on one tick), ties across bar lines, key signatures, tuplets, multiple voices, pickup bars, MIDI → score import, printing / MusicXML export.

- [x] **19.1. Pure model (`core/score.ts` + spec):**
  - `ScoreDto` / `ScoreNoteDto` mirrored in `models.rs` / `models.ts` (snake_case): id, title, bpm, time signature `(beats, beat_unit)`, bar count, two staves (`treble`, `bass`) of notes `{ id, tick, duration_ticks, key, accidental }`, `fragment_id`, timestamps.
  - **Only notes are stored; rests are derived** from the gaps (`withRests`: aligned greedy split, a whole empty bar is one bar rest), so moving or deleting a note never needs rest bookkeeping. One voice per staff (no overlaps) and a note never crosses a bar line (no ties yet).
  - **Accidentals:** `key` is the sounding MIDI key; `accidental` (`'sharp' | 'flat' | null`) only spells black keys and is always drawn (every black key is drawn with its sharp or flat; the staff adds a natural sign when a plain note follows an altered one on the same line or space in the same bar, as accidentals last until the barline; no key signatures).
  - Pure helpers, as in `core/composition.ts`: staff step ↔ key for each clef (`staffStep` / `keyFromStep`, ledger lines), bar capacity in ticks, `roomAt`, `place`, `move` (also between staves), `remove`, `setDuration`, `shiftStep`, `setAccidental`, `resizeBars`, `setTimeSignature`, `validateScore`, tick ↔ ms, and the duration palette from `NoteKind` (`core/music.ts`).
  - Specs: every clef's pitch mapping (C4 = first ledger line below the treble staff / above the bass staff), `keyFromStep` ∘ `staffStep` round trip over the piano range, overlap and bar-crossing rejection, 3/4 vs 4/4 capacity, dotted values, derived rests.
- [x] **19.2. Schema v6 and persistence (`db.rs`):**
  - `scores` (`id`, `title`, `bpm`, `beats`, `beat_unit`, `bars`, `data_json`, `fragment_id REFERENCES midi_fragments(id) ON DELETE SET NULL`, timestamps), `sessions.kind`, `compositions.bpm` and `composition_clips.rate_pct`. Migration test from a v5 vault that checks sessions, fragments, clips and comments are intact.
  - `list_sessions` and any session count exclude `kind = 'scores'`. The system session is created on the first save (`ensure_scores_session`).
  - Deleting a score deletes its fragment; deleting its fragment by other means only detaches the score (`fragment_id = NULL`) and the next save makes a new one. The fragment of a score cannot be reached from the sessions (they are hidden), so it is only deleted with its score.
  - `save_score` also adapts the clips that use the fragment (windows follow a new tempo, clamped to the new length, speed follows the composition's tempo, the next clips are pushed).
- [x] **19.3. Score → MIDI (`score.rs`, Tauri-independent):**
  - Generalize `starter_melodies.rs` (`(key, beats)` → SMF with `ARTICULATION` / `VELOCITY` via `write_smf`) into ticks → `TimedMidiEvent`s: both staves merged on channel 0, rests as gaps, a tempo and time-signature meta event.
  - `save_score(score)` validates (bar capacity, overlaps, key range 21-108), writes the file atomically, inserts or updates the fragment (same id), and **clamps the windows of composition clips** that now exceed the shorter fragment inside the same transaction, since `save_composition` rejects windows outside their fragment.
  - Tests: events for a known two-bar score, rests, dotted notes, round trip through `read_timed_events`.
- [x] **19.4. IPC:** `get_scores`, `create_score`, `get_score`, `save_score`, `delete_score`, and `play_score` / `preview_score` (key `score:<id>`, using `play_sequence`; editing while it plays uses `replace_sequence`). Each one in `commands.rs`, `generate_handler!` in `lib.rs` and `TauriApiService`; `commands.rs` tests with `mock_app()`. Update `SPECIFICATIONS.md` (schema v6, §4 and the IPC list).
- [x] **19.5. Engraving and hit layer (`score-staff` component, SVG):**
  - Renders both staves with clefs, time signature, bar lines, notes and rests, ledger lines, beams and accidentals, with a stable mapping from tick → x and step → y exposed to the editor.
  - Hover ghost note snapped to the grid; a playhead line synced with `playback-progress` for `score:<id>`; selected and playing notes highlighted. Bravura bundled locally.
  - Specs on the SVG (jsdom): note count, ledger lines, stem direction, hit-test results for known coordinates.
- [x] **19.6. Editor view (`score-editor`, `@defer`):**
  - `ScoreStore`: open score, local edits, undo history (up to 50, like `CompositionStore`), save delayed by 400 ms, one save at a time.
  - Header (title, tempo, time signature, add bars), value palette (whole … sixteenth, dotted toggle), the staff with pointer-driven placement, move and delete; Space = play/pause, Ctrl+Z, Delete, arrows (pitch ± step, tick ± grid), `#` / `b` / `n`.
  - Placing or moving a note plays it (`preview_note`) unless the score is playing.
  - Where it lives in the UI: its own view in `NavStore` (`scores`), with the list in the sidebar. The header has "Use as a challenge".
- [x] **19.7. Composition tempo (`composition.rs`, `core/composition.ts`, composer UI):**
  - `CompositionDto.bpm: Option<u32>` and `CompositionClipDto.rate_pct` (50-200, default 100) mirrored in `models.rs` / `models.ts`; `save_composition` validates them and the overlap / window checks use the scaled length.
  - `clip_end_ms` / `clipEnd` apply `rate_pct`; `trimClip`, `splitClip`, `fitStart`, `freeSpan`, `maxRepeats` and the drag / snap code are reviewed so they keep working in timeline time while the window stays in fragment time (specs for each, including a clip at 150 %).
  - Mixdown: `build_tracks_with` scales each clip's events by `100 / rate_pct` (repeats included) and `build_named_tracks` / the MIDI export write the composition's tempo.
  - UI: a BPM field in the transport bar, `rate_pct` stepper and "Match tempo" in the clip inspector, a "Match all" button, and a small "×1.25" badge on clips that are not at 100 %. Changing the composition's tempo re-fits the score clips (and moves the following clips on their track so nothing overlaps), as one undo step.
  - Tests: a 4-beat score clip at 90 BPM in a 120 BPM composition lasts 2/3 of its length and its notes keep their pitch; existing compositions (`rate_pct = 100`, `bpm = NULL`) sound exactly as before.
- [x] **19.8. Composer integration:** scores appear in `fragment-library` with a "Score" badge and their tempo; the clip inspector's "open in its session" link becomes "Open score" for them (the library row is one button, so the edit action lives in the inspector). The composer view reloads the library and the open composition each time it is shown, so a saved score is already up to date.
- [x] **19.9. Translations (English and Spanish):** `score.*` and `backend.scores.*` keys (the i18n parity test fails otherwise), note-value names, clef labels and tooltips.
- [x] **19.11. Fixes and the deferred notation (after the first manual tests):**
  - **Grid per bar:** a dotted half note in 3/4 could not be placed in every bar, because the grid (the half note's 960 ticks) was counted from the start of the score and 1440 is not a multiple of it. `snapTickInBar` snaps from the start of each bar and keeps the note inside it.
  - **Chords:** notes with the same start, value and different keys on a staff; a note put where others start joins them (one stem, a second goes to the other side of it, accidentals stack). A chord has one value.
  - **Ties:** `tie` on a note joins it to the note of the same key that starts where it ends (also across a bar line); `toggleTie` adds that note if it is missing. Ties that no longer join two notes are cleared by every edit; the MIDI plays a chain as one note.
  - **Pickup:** `pickup_ticks` makes the first bar shorter (the end of a bar); bar lines, numbers, beat guides, rests and the score length follow `barSpans`.
  - No migration: `tie` and `pickup_ticks` are in the notation JSON, so a v6 vault that already has scores keeps working (they read as no tie, no pickup).
- [x] **19.12. Lines (systems) instead of horizontal scrolling:** `layoutOf` breaks the bars into systems that fit the width of the view, each with its own clefs (time signature on the first only) and ruler; bars stretch to fill a line except in the last; `score-staff` measures its host and lays out again on resize or zoom; hit-testing, ghost, rests, ties (split across a line break) and the playhead (which scrolls to its line) work per system.
- [x] **19.13. Repeat sign at the end:** `repeat` on the score (in the notation JSON, no migration) draws two dots in each staff before the final double bar and plays the score twice, from the start. `build_events` unrolls it, so the saved fragment (and what the composer and the challenge mode take from it) lasts both passes; the editor's playhead shows the second pass over the first one.
- [x] **19.14. Notation in the challenge screen:** a melody made from a score keeps a frozen copy of the notation (schema v7, `melodies.score_json`) and the challenge shows it on the read-only staff instead of the piano roll: notes coloured by state, red crosses for played notes that hit nothing, a playhead that follows the attempt, the repeat's second pass over the first. The score is matched against the melody's notes (`mapScoreToMelody`) and the piano roll stays for melodies recorded by hand, imported, bundled, or whose score no longer matches. Not done: the error map in Statistics still uses the piano roll.
- [x] **19.15. Closing bar of a pickup:** a score with a pickup ends with a bar of what the pickup lacks (3 beats of pickup in 4/4, a 1-beat last bar), so the two make one whole bar. `bars` counts both, a pickup needs at least 2 bars, and `setPickup` adds or removes that bar so the score keeps its length. Scores stored with a pickup before this read with the bar added (`closing_bar` in the notation JSON).
- [x] **19.16. Fixed tools panel:** the transport, the palette (values, dot, tie, sharp and flat, the selected note) and the settings (tempo, time signature, bars, pickup, repeat, speed, zoom) are all in a panel at the left side that stays in view (`position: sticky`) while a long score scrolls; only the title and the score's actions (challenge, undo, redo, delete) stay above. On narrow windows the panel becomes a bar that sticks to the top.
- [x] **19.17. Collapsible app menu and a cleaner tools panel:** the side menu folds to a 64 px bar of icons (names on hover, keyboard status, settings) and the choice is remembered (`UiPrefsStore.sidebarCollapsed`); the tools panel of the score editor no longer shows scrollbars (when the window is lower than the panel it scrolls without a bar, and it cannot scroll sideways).
- [ ] **19.10. Manual check with `npm run tauri dev`** (the editor was already exercised in headless Chrome with a simulated IPC: clicking and dragging notes, the palette drop, arrow keys, moving a note to the other hand and Delete; the desktop app and the tablet still need a pass):
  - Create a score in 4/4, drop two half notes, then four quarters, then eight eighths in the right hand and a whole note in the left: each bar fills exactly and a fifth quarter does not fit.
  - Switch to 3/4 and 2/4 and check the capacities; dotted values and rests.
  - Sharps and flats with the shortcuts; the staff and playback agree; playback follows the playhead.
  - Save: the fragment appears in the composer's library under the scores session; place it on two tracks with different instruments and play.
  - Edit the score while a composition using it plays (clips keep working), shorten it below a clip's window (the clip is clamped, not lost), undo.
  - The sessions list and the statistics do not show the system session; reopen the vault and check the score is still there; open a v5 vault: it migrates and nothing is lost.
  - Put a 90 BPM score next to a recorded fragment in a 120 BPM composition: the score is placed at ×1.33, keeps its pitch and lines up with the beat; change the composition's tempo and the score clips follow; "Match tempo" on the recorded fragment; old compositions sound the same.
  - Use the score as a challenge; export MIDI and open it in another program; try it with touch on the Android tablet.
  - Known limits to look at here: the glyph offsets of the clefs, rests and accidentals were calibrated in Chrome, not in WebKitGTK; on touch screens a swipe on the staff scrolls it (placing a note is a tap) but a note is dragged with `touch-action: none` on its group, which SVG elements may not honour in every webview.

Open questions: none (all four were answered: one fragment, own tempo that adapts in the composer, system session, MVP scope as listed).

## Phase 20: Scores in the Repertoire and Collections
- [x] **20.1. Schema v8 (`db.rs`):** `scores.piece_id` (`ON DELETE SET NULL`), `collections` and `collection_pieces` (many-to-many, cascades on both sides). Tests: the v7 → v8 migration, scores filed under a piece without becoming takes (counts, `last_practiced`, library grouping, saving from the editor keeps the link), collections (replace, rename, delete, deleting a piece).
- [x] **20.2. Commands:** `assign_score_piece`, `get_collections`, `create_collection`, `rename_collection`, `delete_collection`, `set_piece_collections`; `PieceSummaryDto.score_count`, `PieceDetailDto.scores`, `ScoreSummaryDto.piece_id`.
- [x] **20.3. Score editor:** `score-piece-select` in the header (no piece / a piece / "new piece from this score", which creates it named after the score in one step).
- [x] **20.4. Repertoire view:** a *Scores* section in the piece (open in the editor, take out, add an existing one) and the collection chips of the piece with an inline "new collection".
- [x] **20.5. Sidebar:** a collection filter next to the search, `+` for a new collection (chosen so its name can be typed at once), rename and delete of the chosen one; scores counted on each piece.
- [x] **20.6. Order and PDF of a piece (schema v9):** `scores.piece_position`, `reorder_piece_scores`, up / down buttons on each score of the piece, and "Export scores (PDF)" in the piece: one PDF with the piece's title, composer and notes first and then its scores in order (no takes, no fragments).
- [ ] **20.7. Manual check with `npm run tauri dev`:** write a score, "New piece from this score" in its header and see it in Repertoire; add a second score to the same piece; make two collections, put a piece in both, filter by each, rename and delete one (the pieces stay); delete a piece (its scores stay in Scores); move scores up and down and export the PDF (intro first, order kept, a long note spills onto a second page); open a v7 vault (it migrates to v9).
