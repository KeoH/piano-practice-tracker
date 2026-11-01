//! USB-MIDI input on Android.
//!
//! `midir` has no Android backend, so the ports come from the system `MidiManager`, wrapped by a
//! Kotlin plugin (`android/`). This crate only exposes it to Rust: [`AndroidMidi`] lists the
//! ports and delivers the raw bytes of the open one to a callback. It knows nothing about the
//! recorder; the app adapts it to `midi_recorder::NativeMidi`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "dev.fmanzano.pianotracker.midi";

/// A MIDI input port: `id` is `<deviceId>:<portNumber>`.
#[derive(Debug, Clone, Deserialize)]
pub struct Port {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct PortsResponse {
    ports: Vec<Port>,
}

/// What Kotlin sends through the channel: the bytes of one `MidiReceiver.onSend` call.
#[derive(Deserialize)]
struct Chunk {
    data: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenArgs<'a> {
    id: &'a str,
    on_message: Channel,
}

/// Raw bytes received from the open port.
pub type OnBytes = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// Handle to the Kotlin plugin.
pub struct AndroidMidi<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AndroidMidi<R> {
    pub fn list_ports(&self) -> Result<Vec<Port>, String> {
        self.0
            .run_mobile_plugin::<PortsResponse>("listPorts", ())
            .map(|r| r.ports)
            .map_err(|e| e.to_string())
    }

    /// Connects to `id`; `on_bytes` is called from a Tauri thread for every chunk until [`Self::close`].
    pub fn open(&self, id: &str, on_bytes: OnBytes) -> Result<(), String> {
        let on_message = Channel::new(move |body| {
            match body {
                InvokeResponseBody::Json(json) => match serde_json::from_str::<Chunk>(&json) {
                    Ok(chunk) => on_bytes(&chunk.data),
                    Err(e) => log::warn!("android-midi: unexpected message {json}: {e}"),
                },
                InvokeResponseBody::Raw(bytes) => on_bytes(&bytes),
            }
            Ok(())
        });
        self.0.run_mobile_plugin::<()>("openPort", OpenArgs { id, on_message }).map_err(|e| e.to_string())
    }

    pub fn close(&self) {
        if let Err(e) = self.0.run_mobile_plugin::<()>("closePort", ()) {
            log::warn!("android-midi: could not close the port: {e}");
        }
    }
}

/// Extension to reach the plugin from an `AppHandle`.
pub trait AndroidMidiExt<R: Runtime> {
    fn android_midi(&self) -> &AndroidMidi<R>;
}

impl<R: Runtime, T: Manager<R>> AndroidMidiExt<R> for T {
    fn android_midi(&self) -> &AndroidMidi<R> {
        self.state::<AndroidMidi<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-midi")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MidiPlugin")?;
                app.manage(AndroidMidi(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}
