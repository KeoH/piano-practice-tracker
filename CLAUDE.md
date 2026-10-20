# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Piano Practice Tracker: a desktop app for Ubuntu (Tauri v2 + Angular 22) that records piano sessions over USB-MIDI, slices the raw take into fragments, plays back with a SoundFont synthesizer, anchors comments to the timeline and stores everything in a vault: a folder chosen by the user, Obsidian-style (the app syncs nothing itself; if the vault is in Dropbox, Dropbox does it). The functional specification is in `SPECIFICATIONS.md` and the plan in `TASKS.md`.

**English is the project's official language:** code, comments, logs, tests and documentation are in English. User-facing text never goes in the code: it lives in `src/locales/*.json` (English is the reference, Spanish is a translation; see "Internationalization").

## Commands

```bash
npm run tauri dev          # full app (starts `ng serve` on :4200 + the Rust binary)
npm run build              # frontend only (dist/piano-tracker/browser)
npm run tauri build        # .deb / AppImage packages
npm test                   # frontend tests (Vitest via `ng test`, watch mode in a TTY)
npm run test:ci            # frontend tests once, with coverage in coverage/piano-tracker/
npx ng test --include src/app/core/format.spec.ts  # a single spec file

cd src-tauri
cargo test --lib                                   # all Rust tests
cargo test --lib midi_slicer::                     # tests of one module
cargo test --lib midi_slicer::tests::<name>        # a single test
cargo test --lib -- --ignored --nocapture output_latency   # #[ignore] tests that use real audio / the system's FluidR3
cargo llvm-cov --lib --summary-only                # Rust coverage (needs `cargo install cargo-llvm-cov`)
cargo check
```

Frontend specs are `*.spec.ts` next to the code (Vitest globals, jsdom; `TestBed` for services). So far they cover only pure code (`format`, `markdown`, `I18nService`). No linter is configured (there is a `.prettierrc`; clippy is not installed).

Environment on this machine:
- `src-tauri/.cargo/config.toml` limits cargo to `jobs = 4` and `Cargo.toml` strips debuginfo from dependencies: the machine was running out of RAM. Don't raise the parallelism or run several heavy builds at once.
- `~/.local/piano-sysroot/env.sh` is a fallback local toolchain (gcc and `-dev` libraries extracted without sudo). It is no longer needed because the system dependencies are installed. Never put `gcc-ar` on the PATH under the name `ar`: it calls itself and caused a fork bomb that took the machine down.
- `angular.json` has `"analytics": false`; without it `ng serve` hangs on an interactive prompt inside `tauri dev`.

## CI & releases

- **`.github/workflows/ci.yml`** runs on every PR:
  - `frontend`: build plus `npm run test:ci`;
  - `backend`: `cargo llvm-cov --lib`, with a placeholder `dist/` because `generate_context!` needs one to compile;
  - `coverage`: joins both summaries with `.github/scripts/coverage-summary.mjs` into the job summary and a sticky PR comment.

  The apt packages live in the composite action `.github/actions/setup-linux`.
- **`.github/workflows/release.yml`** runs on every push to `main`:
  1. it calls `ci.yml`;
  2. **release-please** updates the release PR;
  3. when that PR is merged, it creates the `vX.Y.Z` tag and the GitHub Release, and the `bundle` job (ubuntu-22.04, for an older glibc) uploads the `.deb`, the `.AppImage` and `SHA256SUMS.txt`.
- **Versioning:**
  - Commits on `main` (squash-merge PR titles) follow **Conventional Commits**: `feat:` bumps the minor while on 0.x, `fix:` the patch, and `feat!:` or `BREAKING CHANGE` bumps the major.
  - Never edit the version by hand. release-please keeps it in sync in `.release-please-manifest.json`, `version.txt`, `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json` (see `release-please-config.json`), and writes `CHANGELOG.md`.
- **Packaging metadata:** the `.deb` metadata (maintainer, homepage, license, descriptions, category) lives in `bundle` in `tauri.conf.json` and in `src-tauri/Cargo.toml`. `src-tauri/linux/` holds the AppStream metainfo and the Debian `copyright`, installed through `bundle.linux.deb.files`. The metainfo has no `<releases>`: the version stays with release-please. The *About* tab in Settings reads the same `Cargo.toml` fields through `env!("CARGO_PKG_*")` (`commands::app_info`), so author, license and URLs are edited only there. `ci.yml` validates it with `appstreamcli`. Keep these texts in plain ASCII, because the App Center shows non-ASCII characters in the package description as `?`.

## Architecture

### IPC contract (the easiest thing to break)
- `src-tauri/src/models.rs` and `src/app/core/models.ts` are exact mirrors. DTO fields are in **snake_case** on both sides (no `serde(rename)`).
- `invoke` arguments are in **camelCase** (Tauri v2 convention: `{ sessionId, startMs }`), except `extract_midi_fragment`, which takes `{ req: ExtractFragmentReq }` with snake_case fields.
- Adding a command means touching three places:
  1. an `async` function in `commands.rs`;
  2. registering it in `generate_handler!` in `lib.rs`;
  3. a method in `TauriApiService` (`src/app/core/tauri-api.service.ts`), which is the frontend's only IPC entry point.
- Backend → frontend event: `playback-progress` (`PlaybackProgress`, every 50 ms).

### Backend (`src-tauri/src`)
- **Tauri-independent modules:** `db`, `vault`, `i18n`, `midi_recorder`, `midi_slicer`, `audio_engine`, `sf2_builder`, `soundfont` and `paths` don't import `tauri::`, so they can be tested without the app. They emit outwards through callbacks (`ProgressEmitter`, `MidiSink`) that `lib.rs` wires to `AppHandle::emit`.
- **`commands.rs`** defines `AppState`, Tauri's managed state. Its commands are `async` so they don't block the UI thread; heavy work (MIDI slicing and analysis) goes in `spawn_blocking`.
  - The open vault lives in `AppState.vault: RwLock<Option<Arc<Vault>>>` and can change at runtime. Data commands start with `let vault = state.vault()?;` (error "No vault is open" if there is none) and use `vault.db` / `vault.paths`.
  - `activate_vault` is the only way to open one: it checks the lock before closing the current one, saves the configuration and adds the folder to the asset protocol scope.
- **Startup (`lib.rs::init_state`):**
  1. app directories (`AppDirs`);
  2. built-in SoundFont;
  3. `AudioEngine`;
  4. configuration (`AppConfig`), backend language (`i18n::set_language`) and reopening of the last vault; if that fails or the vault is locked, the app starts without a vault and the frontend shows the welcome screen;
  5. background loading of the preferred SoundFont.

  On exit (`RunEvent::Exit`) the vault lock is deleted.
- **Paths (`paths.rs`):**
  - `AppPaths` is the layout of a vault: `piano_tracker.sqlite`, `midi/raw/raw_session_<id>.mid`, `midi/fragments/frag_<id>.mid`, `media/` and the `.piano-tracker/` marker (`vault.json` and `lock`).
  - `AppDirs` is what depends on the machine: `~/.config/piano-tracker/config.json` and `~/.local/share/piano-tracker/assets/default_piano.sf2`. The data lived in `~/.local/share/piano-tracker/` before vaults existed.
- **`vault.rs`:**
  - `AppConfig` stores the current vault, the recent ones, the chosen SoundFont and the language (`language`, `None` = the system language); it depends on the machine, which is why it doesn't go in the vault.
  - Creating requires a new or empty folder. Opening accepts the marker or a folder with `piano_tracker.sqlite` (the previous version's folder).
  - The lock `{ host, pid, opened_at }` makes opening a vault in use on another computer ask for confirmation (`open_vault(path, force)`). A lock from this computer with a dead pid is ignored.
  - `import_legacy` moves the database, `midi/` and `media/` from the old folder after flushing its WAL.
- **`db.rs`** (schema v2):
  - Paths are stored **relative to the vault** and the public API returns them absolute (`store_path` / `load_path`). The frontend and the audio engine only see absolute paths.
  - `journal_mode = DELETE`, not WAL: at rest the database is a single file, which is safer inside a synced folder.
  - The v1 → v2 migration drops `sync_queue`, `sync_status`, `drive_file_id` and the Google settings, and turns the old absolute paths into relative ones, including those of the images in `markdown_notes`.
  - `delete_session` and `delete_fragment` return the paths; deleting the files is the caller's job.
- **Markdown images:** `save_session_image` returns the relative path (`media/…`), which is what gets inserted into the notes. The frontend resolves it against the vault root and serves it through the asset protocol. `assetProtocol.scope` is empty in `tauri.conf.json`: each vault is allowed at runtime.
- **`midi_slicer.rs`** works with `TimedMidiEvent { time_us, bytes }` in absolute time, honouring the tempo map, and writes SMF format 0 at 480 TPQ with atomic writes (tmp + rename).
  - Slicing removes the `[start, end)` interval: an event exactly at `end` is kept.
  - When extracting, it closes open notes and keeps or closes the pedal (CC64).
  - `midi_recorder` reuses it (`write_smf`, `read_timed_events`) to write the raw take and to resume recordings by appending at the end.
- **`midi_recorder.rs`:** the `"simulator"` port is always present and generates notes without a physical keyboard. Real ports have the id `midir:<name>`.
- **`audio_engine.rs`:**
  - **Threads:** the `cpal::Stream` (which is not `Send`) lives on a dedicated thread; the shared state is `Arc<Mutex<AudioState>>`.
  - **Player:** there is a single global player: synth + sequencer + metronome.
  - **No audio device:** a "null clock" advances time anyway. `new_headless` + `render_offline` are used to test without hardware.
  - **Buffer:** `BufferSize::Fixed(256)` is requested for low latency in live monitoring; if the device rejects it, the default buffer is used.
  - **Measurements:** `callback_frames()` and `output_latency_us()` expose what was measured. Bluetooth output adds about 200 ms that the app cannot avoid.
- **SoundFont (`soundfont.rs` + `sf2_builder.rs`):**
  - **Order of preference:**
    1. the one chosen in Settings (`AppConfig.soundfont_path`; old vaults kept it in `app_settings` and it is moved over when they are opened);
    2. a system GM one (`/usr/share/sounds/sf2/FluidR3_GM.sf2`…);
    3. the synthetic piano generated by `sf2_builder` as a last resort (it doesn't sound very realistic).
  - **Format:** only `.sf2` is supported; `rustysynth` cannot read `.sf3`.
  - **Performance:** `rustysynth`, `cpal` and `midly` are compiled with `opt-level = 3` in the dev profile too, so rendering keeps up with real time.

### Frontend (`src/app`)
- **Angular 22 standalone and zoneless** (there is no zone.js): any state the UI renders must be in signals or `computed`; Tauri event callbacks write to signals.
- **Stores in `core/`:**
  - `SessionStore`: list, selected session and detail.
  - `PlaybackStore`: a single global player, with the position indexed by `file_path`; each timeline only reacts to the progress of its own file.
  - `RecordingStore`: port, BPM, toggles and timer.
  - `VaultStore`: open vault, recent ones, create / open / import / close and the Settings dialog (`settingsOpen`). Without a vault, `app.html` shows `vault-welcome` instead of the layout.
  - `LanguageStore`: language preference (or automatic) and the system language; the backend stores it (or `localStorage` without Tauri).
- **Behaviour details:**
  - Resuming after a pause means calling `play_midi_file(file, current_ms)` again.
  - The slicer's preview is stopped from the frontend when it reaches `end_ms`.
  - `update_live_recording_settings` is also used outside recording, to preview the metronome.
- **Session view:** `session-header` (title, summary and menu) and three tabs (`SessionStore.tab`): *Record & trim* (`recorder-deck` + `midi-slicer`), *Fragments* and *Notes*. Tabs are hidden with `hidden` instead of being destroyed, so the slicer's selection and the editor's state are not lost.
- **Timeline components:** `timeline-canvas` is the shared canvas (devicePixelRatio, ResizeObserver, activity blocks, selection, progress) used by `midi-slicer` and `fragment-player`. Its ruler is `RULER_H` (18 px) tall: the parent's overlays use `bottom-[18px]`.
- **Without Tauri** (`ng serve` in a regular browser), `TauriApiService.available` is `false` and calls return an `IpcError` instead of breaking.
- **Rich text:** a sentence with bold words is a single key using `**…**`, rendered by `<app-rich-text [text]="'key' | t" />`.
- **Styles:** Tailwind v4 via `@tailwindcss/postcss` (`.postcssrc.json`).
  - Colours are `@theme` tokens in `src/styles.css` (`ink-*`, `line`, `fg`, `muted`, `faint`, brass `accent`, `rec`, `ok`, `ivory`); don't use Tailwind's `zinc`/`amber` palette.
  - The custom classes (`.btn`, `.btn-primary`, `.btn-lg`, `.field`, `.panel`, `.label`, `.chip`, `.dot`, `.switch`, `.tabular`) live there too. The canvas doesn't read CSS: its colours are duplicated as constants in `timeline-canvas`.
  - The fonts (Hanken Grotesk and JetBrains Mono) are bundled with `@fontsource-variable/*` from `angular.json`, because the app works offline.
  - `rem` is 16 px; the `body` base text is 14 px.

### Internationalization
- **One set of files for everything:** `src/locales/en.json` (the reference) and `src/locales/es.json`. Angular imports them and Rust embeds them at compile time (`include_str!` in `i18n.rs`); Rust only uses the `backend.*` keys.
- **Default language:** the system language if available (Rust reads it from `LANGUAGE`, `LC_ALL`, `LC_MESSAGES` and `LANG`); otherwise English. The user changes it in Settings → General or on the welcome screen; `set_language` stores it in `AppConfig` and also switches the language of the backend messages.
- **Text format:** `{name}` placeholders, the same on both sides. Plurals use `_one` / `_other` suffixes (and an optional `_zero`), chosen with `Intl.PluralRules`.
- **Frontend (`core/i18n/`):**
  - `| t` in templates (`{{ 'sidebar.newSession' | t }}`, `[attr.aria-label]="'x.y' | t"`), `| tp: n` for plurals, and `I18nService.t()` / `.plural()` in TypeScript (toasts, confirmations, `computed`).
  - Keys are typed (`MessageKey`, derived from `en.json`): a misspelled key doesn't compile, in templates too.
  - Dates and numbers go through `I18nService` (`longDate`, `shortDate`, `dateGroup`, `dateTime`, `locale()`); don't hard-code `'es-ES'` or `'en-US'`.
  - The pipes are impure on purpose, so they re-read the language signal: a change applies without reloading.
- **Backend:** `t!("backend.vault.notEmpty", path = dir.display())` returns the error `String`. `log::*` messages are not translated.
- **Tests:** `i18n::tests` checks that every language has the same keys and the same placeholders, so an incomplete translation breaks `cargo test`. Tests use `tr_in(lang, …)` and never change the global language, because they run in parallel.
- **Adding a language:**
  1. copy `src/locales/en.json` to `src/locales/<code>.json` and translate it (including `backend.vault.lockDateFormat`, in `strftime` format);
  2. add its entry to `LANGUAGES` (`src/app/core/i18n/languages.ts`);
  3. add its line to `LOCALES` (`src-tauri/src/i18n.rs`).
