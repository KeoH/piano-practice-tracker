//! Adapts the Kotlin MIDI plugin (`plugins/android-midi`) to the recorder's [`NativeMidi`] trait.

use std::sync::Arc;

use tauri::{AppHandle, Runtime};
use tauri_plugin_android_midi::AndroidMidiExt;

use crate::midi_recorder::{NativeMidi, NativeMidiHandler};

pub struct AndroidMidiBackend<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> NativeMidi for AndroidMidiBackend<R> {
    fn list_ports(&self) -> Result<Vec<(String, String)>, String> {
        Ok(self.0.android_midi().list_ports()?.into_iter().map(|p| (p.id, p.name)).collect())
    }

    fn open(&self, id: &str, on_message: NativeMidiHandler) -> Result<(), String> {
        self.0.android_midi().open(id, Arc::from(on_message))
    }

    fn close(&self) {
        self.0.android_midi().close();
    }
}
