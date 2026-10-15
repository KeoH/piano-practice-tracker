# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Piano Practice Tracker: app de escritorio para Ubuntu (Tauri v2 + Angular 22) que graba sesiones de piano por USB-MIDI, recorta la pista bruta en fragmentos, reproduce con un sintetizador SoundFont, ancla comentarios a la línea de tiempo y hace backup offline-first en Google Drive. La especificación funcional está en `SPECIFICATIONS.md` y el plan en `TASKS.md`. Código, comentarios, mensajes de error y UI están en español; mantén ese idioma.

## Comandos

```bash
npm run tauri dev          # app completa (lanza `ng serve` en :4200 + binario Rust)
npm run build              # solo frontend (dist/piano-tracker/browser)
npm run tauri build        # paquetes .deb / AppImage

cd src-tauri
cargo test --lib                                   # todos los tests Rust
cargo test --lib midi_slicer::                     # tests de un módulo
cargo test --lib midi_slicer::tests::<nombre>      # un test concreto
cargo test --lib -- --ignored --nocapture output_latency   # tests #[ignore] que usan audio real / FluidR3 del sistema
cargo check
```

No hay tests de frontend ni linter configurado (hay `.prettierrc`; clippy no está instalado).

Entorno de esta máquina:
- `src-tauri/.cargo/config.toml` limita cargo a `jobs = 4` y `Cargo.toml` quita debuginfo de dependencias: el equipo se quedaba sin RAM. No subas el paralelismo ni lances varios builds pesados a la vez.
- `~/.local/piano-sysroot/env.sh` es un toolchain local de respaldo (gcc y librerías `-dev` extraídas sin sudo). Ya no hace falta porque las dependencias del sistema están instaladas. Nunca pongas `gcc-ar` en el PATH con el nombre `ar`: se invoca a sí mismo y provocó una fork bomb que tumbó el equipo.
- `angular.json` tiene `"analytics": false`; sin eso `ng serve` se bloquea en una pregunta interactiva dentro de `tauri dev`.

## Arquitectura

### Contrato IPC (lo más fácil de romper)
- `src-tauri/src/models.rs` y `src/app/core/models.ts` son espejos exactos. Los campos de los DTO van en **snake_case** en ambos lados (sin `serde(rename)`).
- Los argumentos de `invoke` van en **camelCase** (convención de Tauri v2: `{ sessionId, startMs }`), salvo `extract_midi_fragment`, que recibe `{ req: ExtractFragmentReq }` con campos snake_case.
- Para añadir un comando hay que tocar tres sitios:
  1. una función `async` en `commands.rs`;
  2. registrarla en `generate_handler!` en `lib.rs`;
  3. un método en `TauriApiService` (`src/app/core/tauri-api.service.ts`), que es el único punto de entrada IPC del frontend.
- Eventos backend → frontend: `playback-progress` (`PlaybackProgress`, cada 50 ms) y `sync-status` (`SyncStatusDto`).

### Backend (`src-tauri/src`)
- **Módulos independientes de Tauri:** `db`, `drive_sync`, `midi_recorder`, `midi_slicer`, `audio_engine`, `sf2_builder`, `soundfont` y `paths` no importan `tauri::`, para poder testearlos sin app. Emiten hacia fuera mediante callbacks (`ProgressEmitter`, `SyncStatusEmitter`, `MidiSink`) que `lib.rs` conecta a `AppHandle::emit`.
- **`commands.rs`** define `AppState`, el estado gestionado de Tauri. Sus comandos son `async` para no bloquear el hilo de UI; el trabajo pesado (recorte y análisis MIDI) va en `spawn_blocking`.
- **Arranque (`lib.rs::init_state`):**
  1. directorios;
  2. SoundFont integrado;
  3. SQLite;
  4. `AudioEngine`;
  5. `DriveSync` y su worker (`tauri::async_runtime::spawn`);
  6. carga en segundo plano del SoundFont preferido.
- **Datos locales** (`paths.rs`), bajo `~/.local/share/piano-tracker/`:
  - `piano_tracker.sqlite`;
  - `midi/raw/raw_session_<id>.mid`;
  - `midi/fragments/frag_<id>.mid`;
  - `media/`;
  - `assets/default_piano.sf2`.

  Las imágenes del Markdown se guardan con ruta absoluta y se sirven por el asset protocol: su alcance (`assetProtocol.scope`) está en `tauri.conf.json`.
- **`db.rs`** encola en `sync_queue` dentro de las propias mutaciones (fragmentos → `MIDI_FRAGMENT`, imágenes → `MEDIA_IMAGE`, pista bruta → `RAW_MIDI`, más un `DB_SNAPSHOT` deduplicado) y marca las sesiones como `PENDING`.
  - Los comandos solo tienen que llamar después a `state.sync.notify_change()`.
  - `delete_session` y `delete_fragment` devuelven las rutas locales; borrar los ficheros le toca a quien llama.
  - Los `drive_file_id` de la pista bruta y del snapshot van en `app_settings` (`drive_file_id:<TYPE>:<id>`).
- **`drive_sync.rs`:**
  - OAuth2 loopback en `127.0.0.1:0` con PKCE.
  - Carpetas `PianoTracker/{midi,media}` y subidas `multipart/related` hechas a mano.
  - Los fallos de red usan `defer_sync_item` y no consumen reintentos; los 4xx reales usan `fail_sync_item` y la entidad pasa a `ERROR` tras 5 reintentos.
- **`midi_slicer.rs`** trabaja con `TimedMidiEvent { time_us, bytes }` en tiempo absoluto, respetando el mapa de tempos, y escribe SMF formato 0 a 480 TPQ con escritura atómica (tmp + rename).
  - El recorte quita el intervalo `[start, end)`: un evento justo en `end` se conserva.
  - Al extraer cierra las notas abiertas y preserva o cierra el pedal (CC64).
  - `midi_recorder` lo reutiliza (`write_smf`, `read_timed_events`) para escribir la pista bruta y reanudar grabaciones añadiendo al final.
- **`midi_recorder.rs`:** el puerto `"simulator"` siempre está presente y genera notas sin teclado físico. Los puertos reales tienen id `midir:<nombre>`.
- **`audio_engine.rs`:**
  - **Hilos:** el `cpal::Stream` (que no es `Send`) vive en un hilo dedicado; el estado compartido es `Arc<Mutex<AudioState>>`.
  - **Reproductor:** hay un único reproductor global: synth + secuenciador + metrónomo.
  - **Sin dispositivo de audio:** un "reloj nulo" avanza el tiempo igual. `new_headless` + `render_offline` sirven para testear sin hardware.
  - **Búfer:** se pide `BufferSize::Fixed(256)` para tener baja latencia en el monitoreo en vivo; si el dispositivo lo rechaza, se usa el búfer por defecto.
  - **Medidas:** `callback_frames()` y `output_latency_us()` exponen lo medido. La salida Bluetooth añade unos 200 ms que la app no puede evitar.
- **SoundFont (`soundfont.rs` + `sf2_builder.rs`):**
  - **Orden de preferencia:**
    1. el elegido en Ajustes (`app_settings.soundfont_path`);
    2. uno GM del sistema (`/usr/share/sounds/sf2/FluidR3_GM.sf2`…);
    3. el piano sintético generado por `sf2_builder` como último recurso (suena poco realista).
  - **Formato:** solo se admite `.sf2`; `rustysynth` no lee `.sf3`.
  - **Rendimiento:** `rustysynth`, `cpal` y `midly` se compilan con `opt-level = 3` también en el perfil dev, para que el render llegue a tiempo real.

### Frontend (`src/app`)
- **Angular 22 standalone y zoneless** (no hay zone.js): todo estado que pinte la UI debe estar en signals o `computed`; los callbacks de eventos Tauri escriben en signals.
- **Stores en `core/`:**
  - `SessionStore`: lista, sesión seleccionada y detalle.
  - `PlaybackStore`: un único reproductor global, con la posición indexada por `file_path`; cada línea de tiempo solo reacciona al progreso de su fichero.
  - `RecordingStore`: puerto, BPM, toggles y cronómetro.
  - `SyncStore`.
- **Detalles de comportamiento:**
  - Reanudar después de una pausa es volver a llamar a `play_midi_file(file, current_ms)`.
  - La preescucha del recortador se para desde el frontend al llegar a `end_ms`.
  - `update_live_recording_settings` también se usa fuera de grabación, para previsualizar el metrónomo.
- **Vista de sesión:** `session-header` (título, resumen y menú) y tres pestañas (`SessionStore.tab`): *Grabar y recortar* (`recorder-deck` + `midi-slicer`), *Fragmentos* y *Notas*. Las pestañas se ocultan con `hidden` en vez de destruirse, para no perder la selección del recortador ni el estado del editor.
- **Componentes de línea de tiempo:** `timeline-canvas` es el canvas compartido (devicePixelRatio, ResizeObserver, bloques de actividad, selección, progreso) que usan `midi-slicer` y `fragment-player`. Su regla mide `RULER_H` (18 px): los overlays del padre usan `bottom-[18px]`.
- **Sin Tauri** (`ng serve` en un navegador normal), `TauriApiService.available` es `false` y las llamadas devuelven `IpcError` en lugar de romper.
- **Estilos:** Tailwind v4 vía `@tailwindcss/postcss` (`.postcssrc.json`).
  - Los colores son tokens de `@theme` en `src/styles.css` (`ink-*`, `line`, `fg`, `muted`, `faint`, `accent` latón, `rec`, `ok`, `ivory`); no uses la paleta `zinc`/`amber` de Tailwind.
  - Las clases propias (`.btn`, `.btn-primary`, `.btn-lg`, `.field`, `.panel`, `.label`, `.chip`, `.dot`, `.switch`, `.tabular`) también están ahí. El canvas no lee CSS: sus colores están duplicados como constantes en `timeline-canvas`.
  - Las fuentes (Hanken Grotesk y JetBrains Mono) van empaquetadas con `@fontsource-variable/*` desde `angular.json`, porque la app funciona sin conexión.
  - `rem` es 16 px; el texto base del `body` es 14 px.
