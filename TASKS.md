# Plan de Tareas de Implementación (Piano Practice Tracker)

Este documento desglosa las tareas secuenciales y paralelizables para construir el MVP completo.

## Fase 1: Inicialización y Entorno del Proyecto
- [x] **1.1. Verificación de dependencias del sistema en Ubuntu:** Comprobar que `cargo`, `node`, `npm`, `pkg-config`, `libasound2-dev` y `libwebkit2gtk-4.1-dev` están instalados.
- [x] **1.2. Scaffolding de Angular + Tauri v2:**
  - Inicializar el proyecto Angular (Standalone, SCSS/TailwindCSS) y configurar `@tauri-apps/cli` y `@tauri-apps/api`.
  - Configurar `src-tauri/Cargo.toml` con todas las dependencias (`tauri`, `midir`, `midly`, `rustysynth`, `cpal`, `rusqlite`, `tokio`, `reqwest`, `serde`, `uuid`, `chrono`).
- [x] **1.3. Generador / Provisionador de SoundFont (`.sf2`):**
  - Crear un módulo en Rust (`sf2_builder.rs`) que verifique si existe `~/.local/share/piano-tracker/assets/default_piano.sf2` al iniciar la app y, si no existe, construya programáticamente un archivo SoundFont `.sf2` válido con muestras de ondas armónicas de piano acústico (o lo copie desde recursos empaquetados) para garantizar que `rustysynth` funcione al 100% *offline* desde el primer arranque sin depender de descargas externas que puedan fallar.

## Fase 2: Capa de Persistencia SQLite y Cola Offline-First
- [x] **2.1. Inicialización de Base de Datos (`db.rs`):**
  - Crear directorios en `~/.local/share/piano-tracker/` (`midi/raw`, `midi/fragments`, `media`, `assets`).
  - Ejecutar las migraciones DDL para `sessions`, `midi_fragments`, `timeline_comments`, `session_media`, `sync_queue` y `app_settings`.
- [x] **2.2. Repositorios CRUD y Encolado Automático:**
  - Implementar funciones para gestionar sesiones, fragmentos, comentarios de línea de tiempo e imágenes.
  - Asegurar que cada creación/modificación de archivo `.mid`, imagen o sesión inserte automáticamente una tarea en `sync_queue` y actualice `sync_status = 'PENDING'`.
- [x] **2.3. Tests Unitarios de Base de Datos:**
  - Escribir tests en Rust (`#[cfg(test)]`) verificando la creación de sesiones, inserción en cascada de fragmentos y comentarios, y el registro automático en `sync_queue`.

## Fase 3: Motor MIDI Nativo y Recorte Destructivo (Slicing)
- [x] **3.1. Captura MIDI con `midir` (`midi_recorder.rs`):**
  - Implementar enumeración de puertos ALSA MIDI y un puerto virtual/simulador de prueba por si no hay teclado físico conectado al testear.
  - Implementar hilo de grabación que capture eventos con marca de tiempo relativa en microsegundos y los guarde en un archivo `.mid` válido usando `midly`.
- [x] **3.2. Analizador de Actividad MIDI (`midi_slicer.rs`):**
  - Implementar `analyze_midi_activity(path)` que parsee el `.mid` con `midly` y devuelva los bloques de actividad (`Vec<ActivityBlock>`) y la duración total en milisegundos.
- [x] **3.3. Motor de Recorte Destructivo (`midi_slicer.rs`):**
  - Implementar `extract_fragment_and_trim(source_path, start_ms, end_ms, dest_path)`:
    - Extraer el rango al nuevo archivo `.mid` con tiempos normalizados a $0$, estado de pedal sustain (`CC 64`) preservado al inicio, y cierre limpio de notas (`NoteOff`) al final.
    - Recortar ese mismo rango del archivo maestro `source_path` desplazando los eventos posteriores hacia atrás.
  - Implementar `discard_range(source_path, start_ms, end_ms)` para borrar tramos no deseados del archivo bruto.
- [x] **3.4. Tests Unitarios de Recorte MIDI:**
  - Crear tests unitarios que generen un archivo `.mid` de prueba de 60 segundos con notas y pedal de sustain, extraigan un fragmento del segundo 10 al 25, y comprueben que el fragmento dura 15 segundos y la pista original pasa a durar 45 segundos sin notas colgadas.

## Fase 4: Motor de Audio, Sintetizador (`rustysynth`) y Metrónomo (`cpal`)
- [x] **4.1. Sintetizador y Salida de Audio (`audio_engine.rs`):**
  - Inicializar el stream de audio `cpal` en un hilo dedicado controlado por canales/estado compartido (`Arc<Mutex<AudioState>>`).
  - Cargar el SoundFont en `rustysynth::Synthesizer`.
- [x] **4.2. Generador de Metrónomo:**
  - Implementar el generador de pulsos audibles según el BPM configurado (activo durante la grabación si el usuario lo habilita).
- [x] **4.3. Secuenciador de Reproducción MIDI:**
  - Implementar la reproducción de archivos `.mid` en `audio_engine.rs` con soporte para `play`, `pause`, `stop` y `seek(ms)`.
  - Emitir eventos `playback-progress` hacia el frontend de Angular cada $50\text{ ms}$.

## Fase 5: Sincronización con Google Drive (OAuth2 + Worker)
> Sustituida por las bóvedas de la Fase 10: `drive_sync.rs` y la cola `sync_queue` se eliminaron.

- [x] **5.1. Flujo OAuth2 Loopback (`drive_sync.rs`):**
  - Implementar servidor local efímero en `127.0.0.1` para capturar el callback de Google OAuth2, intercambiar el código por tokens (`access_token`, `refresh_token`) y persistirlos en `app_settings`.
- [x] **5.2. Cliente de Google Drive API v3:**
  - Implementar resolución/creación de la estructura de carpetas visibles: `PianoTracker/`, `PianoTracker/midi/` y `PianoTracker/media/`.
  - Implementar subida de archivos (`multipart/related`) y respaldo de `piano_tracker_backup.sqlite`.
- [x] **5.3. Worker Asíncrono Offline-First:**
  - Crear tarea en segundo plano (`tokio::spawn`) que procese `sync_queue` cuando haya red y credenciales configuradas, emitiendo el estado de sincronización al frontend.

## Fase 6: Integración de Comandos IPC en Tauri (`lib.rs` / `main.rs`)
- [x] **6.1. Exposición de Comandos Tauri:**
  - Conectar todos los módulos (`db`, `midi_recorder`, `midi_slicer`, `audio_engine`, `drive_sync`) en el estado gestionado de Tauri (`tauri::State`).
  - Registrar todos los comandos `@tauri::command` definidos en `specification.md`.
- [x] **6.2. Verificación de Compilación Backend:**
  - Ejecutar `cargo test` y `cargo check` dentro de `src-tauri` asegurando cero errores.

## Fase 7: Frontend Angular - Servicios, Sesiones y Editor Markdown
- [x] **7.1. Servicios IPC y Modelos TypeScript:**
  - Crear `TauriApiService` con tipado estricto para todos los comandos y suscripción a los eventos `playback-progress` y `sync-status`.
- [x] **7.2. Layout Principal, Sidebar y Modal de Google Drive:**
  - Construir la barra lateral de sesiones con filtros, estado de sincronización en la nube, selector de dispositivo MIDI (incluido modo simulador) y modal de configuración de Google Drive.
- [x] **7.3. Cabecera de Grabación y Metrónomo:**
  - Construir el panel de control de grabación con selector de BPM, toggle de metrónomo, toggle de monitoreo en vivo y botón de grabación con indicador de tiempo en vivo.
- [x] **7.4. Editor Markdown con Soporte de Imágenes:**
  - Construir el editor de notas de la sesión con vista dividida/previa, interceptando el pegado (`paste`) y arrastrado (`drop`) de imágenes para guardarlas localmente mediante `save_session_image` y renderizarlas en el Markdown.

## Fase 8: Frontend Angular - Recortador Visual y Reproductor con Comentarios
- [x] **8.1. Componente Recortador de Pista Bruta (`MidiSlicerComponent`):**
  - Dibujar en `<canvas>` los bloques de actividad MIDI devueltos por el backend.
  - Implementar selectores arrastrables de inicio y fin de recorte (`start_ms`, `end_ms`), preescucha del tramo seleccionado, botón **"Extraer Fragmento"** (con formulario de título y explicación) y botón **"Descartar Tramo"**.
- [x] **8.2. Componente de Fragmento y Línea de Tiempo (`FragmentPlayerComponent`):**
  - Construir el reproductor interactivo para cada fragmento con barra de progreso, controles `Play/Pause/Stop` y bloques de actividad.
  - Renderizar los **marcadores (pins)** en la línea de tiempo para cada comentario.
  - Mostrar el **popup flotante** automático sobre la línea de tiempo cuando la reproducción pasa por el segundo del comentario o al pasar el cursor sobre el pin.
  - Construir el **listado lateral de comentarios** ordenado por segundo (con salto directo al hacer clic) y el input rápido para insertar nuevos comentarios en el instante actual.

## Fase 9: Validación End-to-End y Pulido Final
- [x] **9.1. Compilación Completa Frontend y Backend:**
  - Ejecutar `npm run build` para validar la compilación de Angular sin errores de plantillas ni tipos.
  - Ejecutar `cargo test` y `cargo build` en `src-tauri` para validar que el binario de escritorio en Linux compila limpiamente.
- [x] **9.2. Revisión del Checklist:**
  - Marcar todas las tareas completadas en `task.md`.

## Fase 10: Bóvedas en lugar de Google Drive
- [x] **10.1. Eliminar la sincronización con Google Drive:**
  - Borrar `drive_sync.rs`, sus comandos, el evento `sync-status`, `SyncStatusDto` y las dependencias `reqwest`, `url`, `sha2`, `rand`, `tokio` y `tauri-plugin-shell`.
- [x] **10.2. Base de datos v2 (`db.rs`):**
  - Migración que elimina `sync_queue`, `sync_status`, `drive_file_id` y los ajustes de Google.
  - Rutas relativas a la bóveda en la base de datos y en las imágenes del Markdown; la API las devuelve absolutas.
  - `journal_mode = DELETE` para que la base de datos sea un único fichero en reposo.
- [x] **10.3. Módulo `vault.rs`:**
  - Configuración del equipo en `~/.config/piano-tracker/config.json` (bóveda actual, recientes, SoundFont).
  - Crear, abrir y cerrar bóvedas, lock por equipo y pid, aviso de copias en conflicto e importación de los datos de la versión anterior.
- [x] **10.4. Frontend:**
  - `VaultStore`, pantalla de bienvenida (`vault-welcome`) y pestaña *Bóveda* en Ajustes (`settings-dialog`).
  - Quitar los indicadores de nube de la barra lateral, la cabecera de sesión y los fragmentos.
  - Imágenes del Markdown con rutas relativas a la bóveda.
- [ ] **10.5. Verificación manual con `npm run tauri dev`:**
  - Importar los datos antiguos a una bóveda dentro de Dropbox y comprobar sesiones, reproducción e imágenes.
  - Grabar con el simulador, recortar y pegar una imagen: todo debe quedar dentro de la bóveda.
  - Copiar la bóveda a otra ruta, abrirla con «Abrir otra bóveda…» y comprobar que todo funciona.
  - Abrir la misma bóveda en dos instancias: la segunda debe avisar del lock.

## Fase 11: Multi-idioma (inglés y español)
- [x] **11.1. Ficheros de idioma compartidos:** `src/locales/en.json` (referencia) y `es.json`, usados por Angular y por Rust.
- [x] **11.2. Backend (`i18n.rs`):**
  - Macro `t!`, idioma del sistema por variables de entorno con inglés de reserva, y preferencia en `AppConfig.language`.
  - Comandos `get_language` / `set_language`.
  - Mensajes de error traducidos y tests de paridad de claves y huecos.
- [x] **11.3. Frontend:**
  - `I18nService`, pipes `t` / `tp`, `LanguageStore`, claves tipadas y fechas con `Intl` según el idioma.
  - Todos los componentes traducidos.
  - Selector de idioma en Ajustes → General y en la pantalla de bienvenida.
- [ ] **11.4. Verificación manual con `npm run tauri dev`:**
  - Arrancar con `LANG=es_ES.UTF-8` (español) y con `LANG=fr_FR.UTF-8` (inglés).
  - Cambiar de idioma en Ajustes sin recargar y comprobar que se mantiene al reiniciar.
  - Provocar un error del backend (p. ej. crear una bóveda en una carpeta no vacía) y verlo en el idioma elegido.

