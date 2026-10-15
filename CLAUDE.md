# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Piano Practice Tracker: app de escritorio para Ubuntu (Tauri v2 + Angular 22) que graba sesiones de piano por USB-MIDI, recorta la pista bruta en fragmentos, reproduce con un sintetizador SoundFont, ancla comentarios a la línea de tiempo y guarda todo en una bóveda: una carpeta elegida por el usuario, al estilo de Obsidian (la app no sincroniza nada; si la bóveda está en Dropbox, lo hace Dropbox). La especificación funcional está en `SPECIFICATIONS.md` y el plan en `TASKS.md`. El código, los comentarios, los logs y los tests están en español; mantén ese idioma. Los textos que ve el usuario no van en el código: están en `src/locales/*.json` (inglés por defecto y español; ver «Internacionalización»).

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
- Evento backend → frontend: `playback-progress` (`PlaybackProgress`, cada 50 ms).

### Backend (`src-tauri/src`)
- **Módulos independientes de Tauri:** `db`, `vault`, `midi_recorder`, `midi_slicer`, `audio_engine`, `sf2_builder`, `soundfont` y `paths` no importan `tauri::`, para poder testearlos sin app. Emiten hacia fuera mediante callbacks (`ProgressEmitter`, `MidiSink`) que `lib.rs` conecta a `AppHandle::emit`.
- **`commands.rs`** define `AppState`, el estado gestionado de Tauri. Sus comandos son `async` para no bloquear el hilo de UI; el trabajo pesado (recorte y análisis MIDI) va en `spawn_blocking`.
  - La bóveda abierta está en `AppState.vault: RwLock<Option<Arc<Vault>>>` y puede cambiar en caliente. Los comandos de datos empiezan con `let vault = state.vault()?;` (error «No hay ninguna bóveda abierta» si no hay) y usan `vault.db` / `vault.paths`.
  - `activate_vault` es el único camino para abrir una: comprueba el lock antes de cerrar la actual, guarda la configuración y añade la carpeta al alcance del asset protocol.
- **Arranque (`lib.rs::init_state`):**
  1. directorios de la app (`AppDirs`);
  2. SoundFont integrado;
  3. `AudioEngine`;
  4. configuración (`AppConfig`), idioma del backend (`i18n::set_language`) y reapertura de la última bóveda; si falla o está bloqueada, se arranca sin bóveda y el frontend muestra la bienvenida;
  5. carga en segundo plano del SoundFont preferido.

  Al salir (`RunEvent::Exit`) se borra el lock de la bóveda.
- **Rutas (`paths.rs`):**
  - `AppPaths` es la estructura de una bóveda: `piano_tracker.sqlite`, `midi/raw/raw_session_<id>.mid`, `midi/fragments/frag_<id>.mid`, `media/` y el marcador `.piano-tracker/` (`vault.json` y `lock`).
  - `AppDirs` es lo que depende del equipo: `~/.config/piano-tracker/config.json` y `~/.local/share/piano-tracker/assets/default_piano.sf2`. En `~/.local/share/piano-tracker/` vivían los datos antes de las bóvedas.
- **`vault.rs`:**
  - `AppConfig` guarda la bóveda actual, las recientes, el SoundFont elegido y el idioma (`language`, `None` = el del sistema); depende del equipo, por eso no va en la bóveda.
  - Crear exige carpeta nueva o vacía. Abrir acepta el marcador o una carpeta con `piano_tracker.sqlite` (la de la versión anterior).
  - El lock `{ host, pid, opened_at }` hace que abrir una bóveda en uso en otro equipo pida confirmación (`open_vault(path, force)`). Un lock de este equipo con el pid muerto se ignora.
  - `import_legacy` mueve la base de datos, `midi/` y `media/` de la carpeta antigua tras volcar su WAL.
- **`db.rs`** (esquema v2):
  - Las rutas se guardan **relativas a la bóveda** y la API pública las devuelve absolutas (`store_path` / `load_path`). El frontend y el audio solo ven rutas absolutas.
  - `journal_mode = DELETE`, no WAL: en reposo la base de datos es un único fichero, más seguro dentro de una carpeta sincronizada.
  - La migración v1 → v2 quita `sync_queue`, `sync_status`, `drive_file_id` y los ajustes de Google, y convierte las rutas absolutas antiguas en relativas, también las de las imágenes en `markdown_notes`.
  - `delete_session` y `delete_fragment` devuelven las rutas; borrar los ficheros le toca a quien llama.
- **Imágenes del Markdown:** `save_session_image` devuelve la ruta relativa (`media/…`) y es lo que se inserta en las notas. El frontend la resuelve contra la raíz de la bóveda y la sirve por el asset protocol. `assetProtocol.scope` está vacío en `tauri.conf.json`: cada bóveda se permite en tiempo de ejecución.
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
    1. el elegido en Ajustes (`AppConfig.soundfont_path`; las bóvedas antiguas lo tenían en `app_settings` y se traslada al abrirlas);
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
  - `VaultStore`: bóveda abierta, recientes, crear / abrir / importar / cerrar y el diálogo de Ajustes (`settingsOpen`). Sin bóveda, `app.html` muestra `vault-welcome` en lugar del layout.
  - `LanguageStore`: preferencia de idioma (o automático) e idioma del sistema; la guarda el backend (o `localStorage` sin Tauri).
- **Detalles de comportamiento:**
  - Reanudar después de una pausa es volver a llamar a `play_midi_file(file, current_ms)`.
  - La preescucha del recortador se para desde el frontend al llegar a `end_ms`.
  - `update_live_recording_settings` también se usa fuera de grabación, para previsualizar el metrónomo.
- **Vista de sesión:** `session-header` (título, resumen y menú) y tres pestañas (`SessionStore.tab`): *Grabar y recortar* (`recorder-deck` + `midi-slicer`), *Fragmentos* y *Notas*. Las pestañas se ocultan con `hidden` en vez de destruirse, para no perder la selección del recortador ni el estado del editor.
- **Componentes de línea de tiempo:** `timeline-canvas` es el canvas compartido (devicePixelRatio, ResizeObserver, bloques de actividad, selección, progreso) que usan `midi-slicer` y `fragment-player`. Su regla mide `RULER_H` (18 px): los overlays del padre usan `bottom-[18px]`.
- **Sin Tauri** (`ng serve` en un navegador normal), `TauriApiService.available` es `false` y las llamadas devuelven `IpcError` en lugar de romper.
- **Textos enriquecidos:** una frase con palabras en negrita es una sola clave con `**…**`, que pinta `<app-rich-text [text]="'clave' | t" />`.
- **Estilos:** Tailwind v4 vía `@tailwindcss/postcss` (`.postcssrc.json`).
  - Los colores son tokens de `@theme` en `src/styles.css` (`ink-*`, `line`, `fg`, `muted`, `faint`, `accent` latón, `rec`, `ok`, `ivory`); no uses la paleta `zinc`/`amber` de Tailwind.
  - Las clases propias (`.btn`, `.btn-primary`, `.btn-lg`, `.field`, `.panel`, `.label`, `.chip`, `.dot`, `.switch`, `.tabular`) también están ahí. El canvas no lee CSS: sus colores están duplicados como constantes en `timeline-canvas`.
  - Las fuentes (Hanken Grotesk y JetBrains Mono) van empaquetadas con `@fontsource-variable/*` desde `angular.json`, porque la app funciona sin conexión.
  - `rem` es 16 px; el texto base del `body` es 14 px.

### Internacionalización
- **Un único juego de ficheros para todo:** `src/locales/en.json` (la referencia) y `src/locales/es.json`. Angular los importa y Rust los incrusta al compilar (`include_str!` en `i18n.rs`); Rust solo usa las claves `backend.*`.
- **Idioma por defecto:** el del sistema si está disponible (Rust lo lee de `LANGUAGE`, `LC_ALL`, `LC_MESSAGES` y `LANG`); si no, inglés. El usuario lo cambia en Ajustes → General o en la pantalla de bienvenida; `set_language` lo guarda en `AppConfig` y cambia también el idioma de los mensajes del backend.
- **Formato de los textos:** huecos `{nombre}`, iguales en los dos lados. Plurales con sufijos `_one` / `_other` (y `_zero` opcional), elegidos con `Intl.PluralRules`.
- **Frontend (`core/i18n/`):**
  - `| t` en plantillas (`{{ 'sidebar.newSession' | t }}`, `[attr.aria-label]="'x.y' | t"`), `| tp: n` para plurales e `I18nService.t()` / `.plural()` en TypeScript (toasts, confirmaciones, `computed`).
  - Las claves están tipadas (`MessageKey`, derivado de `en.json`): una clave mal escrita no compila, también en plantillas.
  - Fechas y números van con `I18nService` (`longDate`, `shortDate`, `dateGroup`, `dateTime`, `locale()`); no escribas `'es-ES'` ni `'en-US'` a mano.
  - Los pipes son impuros a propósito, para releer el signal del idioma: el cambio se aplica sin recargar.
- **Backend:** `t!("backend.vault.notEmpty", path = dir.display())` devuelve el `String` del error. Los `log::*` siguen en español y sin traducir.
- **Tests:** `i18n::tests` comprueba que todos los idiomas tienen las mismas claves y los mismos huecos, así que una traducción incompleta rompe `cargo test`. Los tests usan `tr_in(lang, …)` y nunca cambian el idioma global, porque se ejecutan en paralelo.
- **Añadir un idioma:**
  1. copia `src/locales/en.json` a `src/locales/<código>.json` y tradúcelo (incluido `backend.vault.lockDateFormat`, en formato `strftime`);
  2. añade su entrada en `LANGUAGES` (`src/app/core/i18n/languages.ts`);
  3. añade su línea en `LOCALES` (`src-tauri/src/i18n.rs`).
