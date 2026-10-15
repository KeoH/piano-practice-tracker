//! Audio engine: SoundFont synthesizer (`rustysynth`), internal MIDI sequencer, metronome and
//! `cpal` output (section 4.3 of the specification).
//!
//! - A dedicated thread creates and keeps alive the `cpal::Stream` (which is not `Send`).
//! - The shared state (`Arc<Mutex<AudioState>>`) holds the synthesizer, sequencer, metronome and
//!   flags; the audio callback locks it briefly and renders in blocks of 64 frames.
//! - If there is no output device (or it fails), a "null clock" thread advances the engine in
//!   real time discarding the samples, so playback and progress work the same way.
//! - A progress thread calls the `ProgressEmitter` every 50 ms while playing, and once more on
//!   pause/stop/seek/end.
//! - It never panics: any audio or SF2 failure is logged and degrades to null output or to an
//!   empty synthesizer (the metronome and the clock keep working).

use std::f32::consts::PI;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};

use crate::midi_slicer::{read_timed_events, TimedMidiEvent};
use crate::models::PlaybackProgress;

pub type ProgressEmitter = Arc<dyn Fn(PlaybackProgress) + Send + Sync>;

const PREFERRED_SAMPLE_RATE: u32 = 44_100;
/// Block size requested from the sound card (~5 ms at 48 kHz): low latency for live monitoring.
const TARGET_BUFFER_FRAMES: u32 = 256;
const BLOCK_FRAMES: usize = 64;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
const MASTER_VOLUME: f32 = 0.6;
const METRONOME_GAIN: f32 = 0.45;
const CLICK_SECS: f32 = 0.05;
const CLICK_DECAY_SECS: f32 = 0.012;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Sequencer {
    file_path: Option<String>,
    events: Vec<TimedMidiEvent>,
    duration_us: u64,
    next_idx: usize,
    pos_frames: u64,
    is_playing: bool,
}

struct Metronome {
    enabled: bool,
    bpm: u32,
    /// Frames elapsed since it was (re)enabled.
    pos: u64,
}

impl Metronome {
    fn next_sample(&mut self, sr: f32) -> f32 {
        let spb = sr * 60.0 / self.bpm.clamp(20, 400) as f32;
        let p = self.pos as f64;
        let beat = (p / spb as f64).floor();
        let offset = (p - beat * spb as f64) as f32 / sr; // seconds into the beat
        self.pos += 1;
        if offset >= CLICK_SECS {
            return 0.0;
        }
        let freq = if (beat as u64) % 4 == 0 { 880.0 } else { 440.0 };
        // Short exponential envelope with a slight final fade to avoid clicks.
        let tail = ((CLICK_SECS - offset) / 0.005).min(1.0);
        (2.0 * PI * freq * offset).sin() * (-offset / CLICK_DECAY_SECS).exp() * tail
    }
}

struct AudioState {
    synth: Option<Synthesizer>,
    sound_font: Option<Arc<SoundFont>>,
    sample_rate: u32,
    seq: Sequencer,
    metronome: Metronome,
    live_synth: bool,
    /// Asks the progress thread for an extra emission (pause/stop/end/seek).
    emit_pending: bool,
    left: Vec<f32>,
    right: Vec<f32>,
}

fn new_synth(sf: &Arc<SoundFont>, sample_rate: u32) -> Option<Synthesizer> {
    let settings = SynthesizerSettings::new(sample_rate as i32);
    match Synthesizer::new(sf, &settings) {
        Ok(mut s) => {
            s.set_master_volume(MASTER_VOLUME);
            for ch in 0..16 {
                s.process_midi_message(ch, 0xC0, 0, 0);
            }
            Some(s)
        }
        Err(e) => {
            log::error!("audio_engine: could not create the synthesizer at {sample_rate} Hz: {e}");
            None
        }
    }
}

fn load_sound_font(path: &Path) -> Option<Arc<SoundFont>> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            log::error!("audio_engine: could not read the SoundFont {}: {e}", path.display());
            return None;
        }
    };
    match SoundFont::new(&mut Cursor::new(bytes)) {
        Ok(sf) => Some(Arc::new(sf)),
        Err(e) => {
            log::error!("audio_engine: invalid SoundFont {}: {e}", path.display());
            None
        }
    }
}

impl AudioState {
    fn new(sound_font: Option<Arc<SoundFont>>, sample_rate: u32) -> Self {
        let synth = sound_font.as_ref().and_then(|sf| new_synth(sf, sample_rate));
        AudioState {
            synth,
            sound_font,
            sample_rate,
            seq: Sequencer::default(),
            metronome: Metronome { enabled: false, bpm: 120, pos: 0 },
            live_synth: false,
            emit_pending: false,
            left: vec![0.0; BLOCK_FRAMES],
            right: vec![0.0; BLOCK_FRAMES],
        }
    }

    /// Recreates the synthesizer for the device's actual sample rate.
    fn set_sample_rate(&mut self, sample_rate: u32) {
        if sample_rate == self.sample_rate {
            return;
        }
        let pos_us = self.pos_us();
        self.sample_rate = sample_rate;
        self.synth = self.sound_font.as_ref().and_then(|sf| new_synth(sf, sample_rate));
        self.seq.pos_frames = self.us_to_frames(pos_us);
    }

    fn us_to_frames(&self, us: u64) -> u64 {
        (us as u128 * self.sample_rate as u128 / 1_000_000) as u64
    }

    fn pos_us(&self) -> u64 {
        (self.seq.pos_frames as u128 * 1_000_000 / self.sample_rate.max(1) as u128) as u64
    }

    fn pos_ms(&self) -> u64 {
        self.pos_us() / 1000
    }

    fn send(&mut self, bytes: &[u8]) {
        let Some(synth) = self.synth.as_mut() else { return };
        let Some(&status) = bytes.first() else { return };
        if !(0x80..0xF0).contains(&status) {
            return;
        }
        let d1 = bytes.get(1).copied().unwrap_or(0) as i32;
        let d2 = bytes.get(2).copied().unwrap_or(0) as i32;
        synth.process_midi_message((status & 0x0F) as i32, (status & 0xF0) as i32, d1, d2);
    }

    /// Immediate silence + controller reset (All Sound Off / Reset All Controllers / All Notes Off).
    fn reset_synth(&mut self) {
        if let Some(s) = self.synth.as_mut() {
            for ch in 0..16 {
                s.process_midi_message(ch, 0xB0, 120, 0);
                s.process_midi_message(ch, 0xB0, 121, 0);
                s.process_midi_message(ch, 0xB0, 123, 0);
            }
            s.note_off_all(true);
            s.reset_all_controllers();
            // Clears voices and reverb/chorus tails for truly immediate silence.
            s.reset();
            for ch in 0..16 {
                s.process_midi_message(ch, 0xC0, 0, 0);
            }
        }
    }

    /// Positions the sequencer at `ms`, applying the preceding controller state (pedal, program, pitch bend).
    fn position_at(&mut self, ms: u64) {
        let target_us = ms.saturating_mul(1000).min(self.seq.duration_us);
        self.reset_synth();
        let idx = self.seq.events.partition_point(|e| e.time_us < target_us);
        let chase: Vec<Vec<u8>> = self.seq.events[..idx]
            .iter()
            .filter(|e| matches!(e.bytes.first().map(|s| s & 0xF0), Some(0xB0) | Some(0xC0) | Some(0xE0)))
            .map(|e| e.bytes.clone())
            .collect();
        for b in chase {
            self.send(&b);
        }
        self.seq.next_idx = idx;
        self.seq.pos_frames = self.us_to_frames(target_us);
    }

    fn dispatch_until(&mut self, until_us: u64) {
        while self.seq.next_idx < self.seq.events.len() && self.seq.events[self.seq.next_idx].time_us <= until_us {
            let bytes = std::mem::take(&mut self.seq.events[self.seq.next_idx].bytes);
            self.send(&bytes);
            self.seq.events[self.seq.next_idx].bytes = bytes;
            self.seq.next_idx += 1;
        }
    }

    /// Renders `out.len() / 2` interleaved stereo frames.
    fn render_interleaved(&mut self, out: &mut [f32]) {
        let frames = out.len() / 2;
        let sr = self.sample_rate as f32;
        let mut done = 0;
        while done < frames {
            let n = BLOCK_FRAMES.min(frames - done);
            if self.seq.is_playing && self.seq.file_path.is_some() {
                let pos = self.pos_us();
                self.dispatch_until(pos);
            }
            let (left, right) = (&mut self.left[..n], &mut self.right[..n]);
            match self.synth.as_mut() {
                Some(s) => s.render(left, right),
                None => {
                    left.fill(0.0);
                    right.fill(0.0);
                }
            }
            for i in 0..n {
                let click = if self.metronome.enabled { self.metronome.next_sample(sr) * METRONOME_GAIN } else { 0.0 };
                let o = (done + i) * 2;
                out[o] = (self.left[i] + click).clamp(-1.0, 1.0);
                out[o + 1] = (self.right[i] + click).clamp(-1.0, 1.0);
            }
            if self.seq.is_playing && self.seq.file_path.is_some() {
                self.seq.pos_frames += n as u64;
                if self.pos_us() >= self.seq.duration_us {
                    let end = self.seq.duration_us;
                    self.dispatch_until(end);
                    self.seq.pos_frames = self.us_to_frames(end);
                    self.seq.is_playing = false;
                    self.emit_pending = true;
                }
            }
            done += n;
        }
    }

    fn progress(&self) -> Option<PlaybackProgress> {
        self.seq.file_path.as_ref().map(|p| PlaybackProgress {
            file_path: p.clone(),
            current_ms: self.pos_ms(),
            duration_ms: self.seq.duration_us / 1000,
            is_playing: self.seq.is_playing,
        })
    }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/// Audio engine. `Send + Sync`: it can be stored in Tauri's managed state.
pub struct AudioEngine {
    state: Arc<Mutex<AudioState>>,
    output_available: Arc<AtomicBool>,
    /// Frames the sound card requests per callback (0 without output): it determines the latency.
    callback_frames: Arc<AtomicU32>,
    /// Output latency measured in the last callback (µs between rendering and playing).
    output_latency_us: Arc<AtomicU32>,
    shutdown: Arc<AtomicBool>,
    audio_stop: Mutex<Option<Sender<()>>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

impl AudioEngine {
    /// Creates the engine with `cpal` output. It never fails: without a device or a valid SF2 it
    /// falls back to "null output" mode (real-time clock) and/or an empty synthesizer.
    pub fn new(sf2_path: &Path, emitter: ProgressEmitter) -> Self {
        let engine = Self::build(sf2_path, emitter);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();
        let state = Arc::clone(&engine.state);
        let available = Arc::clone(&engine.output_available);
        let meters = OutputMeters {
            frames: Arc::clone(&engine.callback_frames),
            latency_us: Arc::clone(&engine.output_latency_us),
        };
        let spawn = std::thread::Builder::new()
            .name("audio-output".into())
            .spawn(move || audio_thread(state, available, meters, stop_rx, ready_tx));
        match spawn {
            Ok(handle) => {
                lock(&engine.threads).push(handle);
                *lock(&engine.audio_stop) = Some(stop_tx);
                match ready_rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(true) => log::info!("audio_engine: audio output active"),
                    Ok(false) => log::warn!("audio_engine: no audio device; null output mode"),
                    Err(_) => log::warn!("audio_engine: the audio device is slow to respond"),
                }
            }
            Err(e) => log::error!("audio_engine: could not create the audio thread: {e}"),
        }
        engine
    }

    /// Engine without an audio thread or clock (tests/diagnostics): time only advances with `render_offline`.
    pub fn new_headless(sf2_path: &Path, emitter: ProgressEmitter) -> Self {
        Self::build(sf2_path, emitter)
    }

    fn build(sf2_path: &Path, emitter: ProgressEmitter) -> Self {
        let sf = load_sound_font(sf2_path);
        let state = Arc::new(Mutex::new(AudioState::new(sf, PREFERRED_SAMPLE_RATE)));
        let shutdown = Arc::new(AtomicBool::new(false));
        let engine = AudioEngine {
            state: Arc::clone(&state),
            output_available: Arc::new(AtomicBool::new(false)),
            callback_frames: Arc::new(AtomicU32::new(0)),
            output_latency_us: Arc::new(AtomicU32::new(0)),
            shutdown: Arc::clone(&shutdown),
            audio_stop: Mutex::new(None),
            threads: Mutex::new(Vec::new()),
        };
        let spawn = std::thread::Builder::new()
            .name("audio-progress".into())
            .spawn(move || progress_thread(state, emitter, shutdown));
        match spawn {
            Ok(h) => lock(&engine.threads).push(h),
            Err(e) => log::error!("audio_engine: could not create the progress thread: {e}"),
        }
        engine
    }

    pub fn output_available(&self) -> bool {
        self.output_available.load(Ordering::SeqCst)
    }

    /// Frames per callback of the real output (0 if there is no audio yet or no device).
    pub fn callback_frames(&self) -> u32 {
        self.callback_frames.load(Ordering::Relaxed)
    }

    /// Output latency (rendering → speaker) of the last callback, in microseconds.
    pub fn output_latency_us(&self) -> u32 {
        self.output_latency_us.load(Ordering::Relaxed)
    }

    /// `true` if the SoundFont loaded and the synthesizer is working.
    pub fn synth_available(&self) -> bool {
        lock(&self.state).synth.is_some()
    }

    pub fn sample_rate(&self) -> u32 {
        lock(&self.state).sample_rate
    }

    /// Swaps the SoundFont while running. Reading it (slow for large files) happens outside the
    /// lock; then the synthesizer is recreated and the current playback is repositioned.
    pub fn load_soundfont(&self, path: &Path) -> Result<(), String> {
        let sf = load_sound_font(path).ok_or_else(|| t!("backend.soundfont.loadFailed", path = path.display()))?;
        let mut st = lock(&self.state);
        let synth = new_synth(&sf, st.sample_rate)
            .ok_or_else(|| t!("backend.soundfont.incompatible", path = path.display()))?;
        st.sound_font = Some(sf);
        st.synth = Some(synth);
        if st.seq.file_path.is_some() {
            let pos = st.pos_ms();
            st.position_at(pos);
        }
        log::info!("audio_engine: active SoundFont {}", path.display());
        Ok(())
    }

    pub fn is_playing(&self) -> bool {
        lock(&self.state).seq.is_playing
    }

    pub fn position_ms(&self) -> u64 {
        lock(&self.state).pos_ms()
    }

    pub fn current_progress(&self) -> Option<PlaybackProgress> {
        lock(&self.state).progress()
    }

    /// Plays `path` from `start_ms`. If it is the same paused file and `start_ms` matches the
    /// current position, it just resumes.
    pub fn play_file(&self, path: &Path, start_ms: u64) -> Result<(), String> {
        let path_str = path.to_string_lossy().into_owned();
        {
            let mut st = lock(&self.state);
            if st.seq.file_path.as_deref() == Some(path_str.as_str()) && !st.seq.is_playing {
                let pos = st.pos_ms();
                if pos.abs_diff(start_ms) <= 5 && pos < st.seq.duration_us / 1000 {
                    st.seq.is_playing = true;
                    st.emit_pending = true;
                    return Ok(());
                }
            }
        }
        let (events, duration_ms) = read_timed_events(path)?;
        let duration_us = (duration_ms * 1000).max(events.last().map(|e| e.time_us).unwrap_or(0));
        let mut st = lock(&self.state);
        st.seq = Sequencer {
            file_path: Some(path_str),
            events,
            duration_us,
            next_idx: 0,
            pos_frames: 0,
            is_playing: false,
        };
        let start = if start_ms.saturating_mul(1000) >= duration_us { 0 } else { start_ms };
        st.position_at(start);
        st.seq.is_playing = duration_us > 0;
        st.emit_pending = true;
        Ok(())
    }

    pub fn pause(&self) -> Result<(), String> {
        let mut st = lock(&self.state);
        if st.seq.is_playing {
            st.seq.is_playing = false;
            if let Some(s) = st.synth.as_mut() {
                s.note_off_all(false);
            }
        }
        st.emit_pending = st.seq.file_path.is_some();
        Ok(())
    }

    /// Repositions (note_off_all + controller reset) keeping the play/pause state.
    pub fn seek(&self, ms: u64) -> Result<(), String> {
        let mut st = lock(&self.state);
        if st.seq.file_path.is_none() {
            return Err(t!("backend.playback.noFile"));
        }
        st.position_at(ms);
        st.emit_pending = true;
        Ok(())
    }

    /// Position 0, `is_playing = false` and immediate silence.
    pub fn stop(&self) -> Result<(), String> {
        let mut st = lock(&self.state);
        st.seq.is_playing = false;
        st.reset_synth();
        st.seq.next_idx = 0;
        st.seq.pos_frames = 0;
        st.emit_pending = st.seq.file_path.is_some();
        Ok(())
    }

    /// Turns the metronome on/off (independent of playback). When it is enabled or the BPM changes,
    /// the first beat (accented, 880 Hz) sounds immediately.
    pub fn set_metronome(&self, enabled: bool, bpm: u32) {
        let mut st = lock(&self.state);
        let bpm = bpm.clamp(20, 400);
        if enabled && (!st.metronome.enabled || st.metronome.bpm != bpm) {
            st.metronome.pos = 0;
        }
        st.metronome.enabled = enabled;
        st.metronome.bpm = bpm;
    }

    pub fn set_live_synth(&self, enabled: bool) {
        let mut st = lock(&self.state);
        if st.live_synth && !enabled && !st.seq.is_playing {
            if let Some(s) = st.synth.as_mut() {
                s.note_off_all(false);
            }
        }
        st.live_synth = enabled;
    }

    pub fn live_synth_enabled(&self) -> bool {
        lock(&self.state).live_synth
    }

    /// Sends a live MIDI message to the synthesizer (no-op if monitoring is disabled).
    pub fn send_live_midi(&self, bytes: &[u8]) {
        let mut st = lock(&self.state);
        if st.live_synth {
            st.send(bytes);
        }
    }

    /// Tests/diagnostics ONLY: advances the engine by `frames` frames without a device and returns
    /// the interleaved stereo samples (`frames * 2` values).
    pub fn render_offline(&self, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; frames * 2];
        lock(&self.state).render_interleaved(&mut out);
        out
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(tx) = lock(&self.audio_stop).take() {
            let _ = tx.send(());
        }
        for h in lock(&self.threads).drain(..) {
            let _ = h.join();
        }
    }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

fn progress_thread(state: Arc<Mutex<AudioState>>, emitter: ProgressEmitter, shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::SeqCst) {
        std::thread::sleep(PROGRESS_INTERVAL);
        let progress = {
            let mut st = lock(&state);
            if st.seq.is_playing || st.emit_pending {
                st.emit_pending = false;
                st.progress()
            } else {
                None
            }
        };
        if let Some(p) = progress {
            emitter(p);
        }
    }
}

/// Advances the engine in real time discarding the samples (no output device).
fn run_null_clock(state: &Arc<Mutex<AudioState>>, stop_rx: &mpsc::Receiver<()>) {
    let start = Instant::now();
    let mut rendered: u64 = 0;
    let mut scratch: Vec<f32> = vec![0.0; 4096 * 2];
    loop {
        match stop_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let mut st = lock(state);
        let sr = st.sample_rate as u64;
        let target = (start.elapsed().as_micros() as u64).saturating_mul(sr) / 1_000_000;
        // If we fall far behind (e.g. after suspend), don't try to catch up more than 1 s.
        if target > rendered + sr {
            rendered = target - sr;
        }
        while rendered < target {
            let n = ((target - rendered) as usize).min(4096);
            st.render_interleaved(&mut scratch[..n * 2]);
            rendered += n as u64;
        }
    }
}

/// Measurements the audio callback publishes for diagnostics.
#[derive(Clone)]
struct OutputMeters {
    frames: Arc<AtomicU32>,
    latency_us: Arc<AtomicU32>,
}

fn audio_thread(
    state: Arc<Mutex<AudioState>>,
    available: Arc<AtomicBool>,
    frames: OutputMeters,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: Sender<bool>,
) {
    let failed = Arc::new(AtomicBool::new(false));
    match open_output_stream(&state, &failed, &frames) {
        Ok(stream) => {
            available.store(true, Ordering::SeqCst);
            let _ = ready_tx.send(true);
            loop {
                match stop_rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                        drop(stream);
                        return;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if failed.load(Ordering::SeqCst) {
                            log::error!("audio_engine: the audio device failed; switching to null output");
                            drop(stream);
                            available.store(false, Ordering::SeqCst);
                            run_null_clock(&state, &stop_rx);
                            return;
                        }
                    }
                }
            }
        }
        Err(e) => {
            log::warn!("audio_engine: audio output not available: {e}");
            available.store(false, Ordering::SeqCst);
            let _ = ready_tx.send(false);
            run_null_clock(&state, &stop_rx);
        }
    }
}

fn choose_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
    use cpal::traits::DeviceTrait;
    use cpal::SampleFormat;
    let supported = |f: SampleFormat| matches!(f, SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16 | SampleFormat::I32);
    let default = device.default_output_config().ok();
    // Device's native rate (e.g. 48 kHz on PipeWire): avoids resampling, which adds latency.
    let rate = default.as_ref().map(|d| d.sample_rate().0).unwrap_or(PREFERRED_SAMPLE_RATE);
    if let Ok(configs) = device.supported_output_configs() {
        let mut candidates: Vec<cpal::SupportedStreamConfigRange> = configs
            .filter(|c| {
                supported(c.sample_format())
                    && c.channels() >= 1
                    && c.min_sample_rate().0 <= rate
                    && c.max_sample_rate().0 >= rate
            })
            .collect();
        // Preference: stereo, then f32.
        candidates.sort_by_key(|c| (c.channels() != 2, c.sample_format() != SampleFormat::F32, c.channels()));
        if let Some(c) = candidates.into_iter().next() {
            return Ok(c.with_sample_rate(cpal::SampleRate(rate)));
        }
    }
    let def = default.ok_or_else(|| "no output configuration".to_string())?;
    if supported(def.sample_format()) {
        Ok(def)
    } else {
        Err(format!("unsupported sample format: {:?}", def.sample_format()))
    }
}

/// Small fixed buffer within the range the device supports (`None` = use the default one).
fn low_latency_buffer(supported: &cpal::SupportedStreamConfig) -> Option<cpal::BufferSize> {
    match supported.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } if *min <= *max => {
            Some(cpal::BufferSize::Fixed(TARGET_BUFFER_FRAMES.clamp(*min, *max)))
        }
        cpal::SupportedBufferSize::Range { .. } => None,
        cpal::SupportedBufferSize::Unknown => Some(cpal::BufferSize::Fixed(TARGET_BUFFER_FRAMES)),
    }
}

fn open_output_stream(
    state: &Arc<Mutex<AudioState>>,
    failed: &Arc<AtomicBool>,
    frames: &OutputMeters,
) -> Result<cpal::Stream, String> {
    use cpal::traits::{HostTrait, StreamTrait};
    use cpal::SampleFormat;

    let host = cpal::default_host();
    let device = host.default_output_device().ok_or_else(|| "no output device".to_string())?;
    let supported = choose_config(&device)?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.config();
    let sr = config.sample_rate.0;
    if !(16_000..=192_000).contains(&sr) {
        return Err(format!("unsupported sample rate: {sr} Hz"));
    }
    lock(state).set_sample_rate(sr);
    let channels = config.channels as usize;
    let build = |config: &cpal::StreamConfig| match format {
        SampleFormat::F32 => build_stream::<f32>(&device, config, channels, state, failed, frames),
        SampleFormat::I16 => build_stream::<i16>(&device, config, channels, state, failed, frames),
        SampleFormat::U16 => build_stream::<u16>(&device, config, channels, state, failed, frames),
        SampleFormat::I32 => build_stream::<i32>(&device, config, channels, state, failed, frames),
        other => Err(format!("unsupported sample format: {other:?}")),
    };
    // First a small buffer (low latency); if the device rejects it, the default one.
    let low_latency = low_latency_buffer(&supported).and_then(|buffer_size| {
        let cfg = cpal::StreamConfig { buffer_size, ..config.clone() };
        match build(&cfg) {
            Ok(stream) => Some(stream),
            Err(e) => {
                log::warn!("audio_engine: low-latency buffer rejected ({e}); using the default one");
                None
            }
        }
    });
    let stream = match low_latency {
        Some(stream) => stream,
        None => build(&config)?,
    };
    stream.play().map_err(|e| format!("could not start the stream: {e}"))?;
    log::info!("audio_engine: output {} Hz, {channels} channels, {format:?}", sr);
    Ok(stream)
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    state: &Arc<Mutex<AudioState>>,
    failed: &Arc<AtomicBool>,
    frames_out: &OutputMeters,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
{
    use cpal::traits::DeviceTrait;
    let st = Arc::clone(state);
    let failed_cb = Arc::clone(failed);
    let meters = frames_out.clone();
    let mut scratch: Vec<f32> = Vec::new();
    let channels = channels.max(1);
    device
        .build_output_stream(
            config,
            move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
                let frames = data.len() / channels;
                meters.frames.store(frames as u32, Ordering::Relaxed);
                let ts = info.timestamp();
                if let Some(lat) = ts.playback.duration_since(&ts.callback) {
                    meters.latency_us.store(lat.as_micros().min(u32::MAX as u128) as u32, Ordering::Relaxed);
                }
                if scratch.len() < frames * 2 {
                    scratch.resize(frames * 2, 0.0);
                }
                lock(&st).render_interleaved(&mut scratch[..frames * 2]);
                for (f, frame) in data.chunks_mut(channels).enumerate() {
                    let l = scratch[f * 2];
                    let r = scratch[f * 2 + 1];
                    if channels == 1 {
                        frame[0] = T::from_sample(0.5 * (l + r));
                    } else {
                        for (c, s) in frame.iter_mut().enumerate() {
                            let v = match c {
                                0 => l,
                                1 => r,
                                _ => 0.0,
                            };
                            *s = T::from_sample(v);
                        }
                    }
                }
            },
            move |err| {
                log::error!("audio_engine: audio stream error: {err}");
                if matches!(err, cpal::StreamError::DeviceNotAvailable) {
                    failed_cb.store(true, Ordering::SeqCst);
                }
            },
            None,
        )
        .map_err(|e| format!("could not create the output stream: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi_slicer::write_smf;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    fn sf2_path() -> &'static PathBuf {
        static P: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
        &P.get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("default_piano.sf2");
            crate::sf2_builder::ensure_soundfont(&path).unwrap();
            (dir, path)
        })
        .1
    }

    fn collecting_emitter() -> (ProgressEmitter, Arc<Mutex<Vec<PlaybackProgress>>>) {
        let v = Arc::new(Mutex::new(Vec::new()));
        let v2 = Arc::clone(&v);
        (Arc::new(move |p| v2.lock().unwrap().push(p)), v)
    }

    /// 2 s file: chords every 250 ms with pedal.
    fn test_midi(dir: &Path) -> PathBuf {
        let p = dir.join("test.mid");
        let mut evs = vec![TimedMidiEvent::new(0, vec![0xB0, 64, 127])];
        for i in 0..8u64 {
            let t = i * 250_000;
            for k in [60u8, 64, 67] {
                evs.push(TimedMidiEvent::new(t, vec![0x90, k + (i % 3) as u8, 100]));
                evs.push(TimedMidiEvent::new(t + 200_000, vec![0x80, k + (i % 3) as u8, 0]));
            }
        }
        evs.push(TimedMidiEvent::new(2_000_000, vec![0xB0, 64, 0]));
        write_smf(&p, &evs, 120).unwrap();
        p
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0f32, |m, v| m.max(v.abs()))
    }

    #[test]
    fn engine_is_send_sync() {
        fn check<T: Send + Sync>() {}
        check::<AudioEngine>();
    }

    #[test]
    fn plays_file_and_advances_position() {
        let dir = tempfile::tempdir().unwrap();
        let mid = test_midi(dir.path());
        let (em, _) = collecting_emitter();
        let eng = AudioEngine::new_headless(sf2_path(), em);
        assert!(!eng.output_available());
        assert!(eng.synth_available());
        assert_eq!(eng.sample_rate(), 44_100);
        eng.play_file(&mid, 0).unwrap();
        assert!(eng.is_playing());
        let out = eng.render_offline(22_050);
        assert_eq!(out.len(), 44_100);
        assert!(rms(&out) > 0.01, "rms={}", rms(&out));
        assert!(out.iter().all(|v| v.is_finite() && v.abs() <= 1.0));
        let pos = eng.position_ms();
        assert!((495..=505).contains(&pos), "pos={pos}");

        // Seek while keeping playback.
        eng.seek(1_500).unwrap();
        assert_eq!(eng.position_ms(), 1_500);
        assert!(eng.is_playing());
        // Reaches the end: stops at the duration.
        eng.render_offline(44_100);
        assert!(!eng.is_playing());
        assert_eq!(eng.position_ms(), 2_000);
        let p = eng.current_progress().unwrap();
        assert_eq!(p.duration_ms, 2_000);
        assert!(!p.is_playing);

        // Stop: position 0 and immediate silence.
        eng.play_file(&mid, 0).unwrap();
        eng.render_offline(4_410);
        eng.stop().unwrap();
        assert!(!eng.is_playing());
        assert_eq!(eng.position_ms(), 0);
        let after = eng.render_offline(4_410);
        assert!(peak(&after[2_000..]) < 0.05, "peak after stop {}", peak(&after[2_000..]));
        assert_eq!(eng.position_ms(), 0, "does not advance while stopped");
    }

    #[test]
    fn pause_resume_and_seek_while_paused() {
        let dir = tempfile::tempdir().unwrap();
        let mid = test_midi(dir.path());
        let (em, _) = collecting_emitter();
        let eng = AudioEngine::new_headless(sf2_path(), em);
        eng.play_file(&mid, 250).unwrap();
        assert_eq!(eng.position_ms(), 250);
        eng.render_offline(4_410);
        eng.pause().unwrap();
        let pos = eng.position_ms();
        assert!((345..=355).contains(&pos), "{pos}");
        eng.render_offline(4_410);
        assert_eq!(eng.position_ms(), pos, "does not advance while paused");
        eng.seek(1_000).unwrap();
        assert!(!eng.is_playing(), "seek keeps the pause");
        assert_eq!(eng.position_ms(), 1_000);
        // Resume: same file and same position.
        eng.play_file(&mid, 1_000).unwrap();
        assert!(eng.is_playing());
        assert_eq!(eng.position_ms(), 1_000);
        eng.render_offline(4_410);
        assert!(eng.position_ms() > 1_000);
        assert!(eng.seek(500).is_ok());
        assert!(eng.play_file(&dir.path().join("no_existe.mid"), 0).is_err());
    }

    #[test]
    fn metronome_clicks_with_empty_synth() {
        let (em, _) = collecting_emitter();
        let eng = AudioEngine::new_headless(sf2_path(), em);
        let silent = eng.render_offline(4_410);
        assert!(peak(&silent) < 1e-4);
        eng.set_metronome(true, 120);
        let out = eng.render_offline(44_100);
        let left: Vec<f32> = out.iter().step_by(2).copied().collect();
        // Clicks at 0 and 0.5 s (120 BPM), silence in between.
        assert!(peak(&left[..2_205]) > 0.1);
        assert!(peak(&left[22_050..22_050 + 2_205]) > 0.1);
        assert!(peak(&left[3_000..21_000]) < 1e-3);
        // 880 Hz on the first beat, 440 Hz on the second: zero crossings in 40 ms.
        let crossings = |s: &[f32]| s.windows(2).filter(|w| (w[0] <= 0.0) != (w[1] <= 0.0)).count();
        let c1 = crossings(&left[..1_764]);
        let c2 = crossings(&left[22_050..22_050 + 1_764]);
        assert!((60..=80).contains(&c1), "c1={c1}");
        assert!((28..=42).contains(&c2), "c2={c2}");
        eng.set_metronome(false, 120);
        assert!(peak(&eng.render_offline(44_100)) < 1e-4);
    }

    #[test]
    fn live_synth_only_when_enabled() {
        let (em, _) = collecting_emitter();
        let eng = AudioEngine::new_headless(sf2_path(), em);
        eng.send_live_midi(&[0x90, 60, 100]);
        assert!(peak(&eng.render_offline(4_410)) < 1e-4);
        eng.set_live_synth(true);
        assert!(eng.live_synth_enabled());
        eng.send_live_midi(&[0xF8]);
        eng.send_live_midi(&[0x90, 64, 100]);
        assert!(rms(&eng.render_offline(8_820)) > 0.005);
        eng.send_live_midi(&[0x80, 64, 0]);
        eng.set_live_synth(false);
        eng.render_offline(88_200);
        assert!(peak(&eng.render_offline(4_410)) < 1e-3);
    }

    #[test]
    fn emitter_receives_progress() {
        let dir = tempfile::tempdir().unwrap();
        let mid = test_midi(dir.path());
        let (em, got) = collecting_emitter();
        let eng = AudioEngine::new_headless(sf2_path(), em);
        eng.play_file(&mid, 0).unwrap();
        eng.render_offline(4_410);
        std::thread::sleep(Duration::from_millis(180));
        {
            let v = got.lock().unwrap();
            assert!(!v.is_empty());
            let last = v.last().unwrap();
            assert!(last.is_playing);
            assert_eq!(last.duration_ms, 2_000);
            assert_eq!(last.file_path, mid.to_string_lossy());
        }
        eng.stop().unwrap();
        std::thread::sleep(Duration::from_millis(180));
        let v = got.lock().unwrap();
        let last = v.last().unwrap();
        assert!(!last.is_playing);
        assert_eq!(last.current_ms, 0);
    }

    /// Manual test with the real device (or null output if there is none): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn real_device_smoke() {
        let dir = tempfile::tempdir().unwrap();
        let mid = test_midi(dir.path());
        let (em, got) = collecting_emitter();
        let eng = AudioEngine::new(sf2_path(), em);
        println!("output_available={} sample_rate={}", eng.output_available(), eng.sample_rate());
        eng.play_file(&mid, 0).unwrap();
        std::thread::sleep(Duration::from_millis(600));
        let pos = eng.position_ms();
        assert!(pos >= 300, "the clock (real or null) must advance: {pos}");
        assert!(!got.lock().unwrap().is_empty());
        eng.stop().unwrap();
    }

    /// Latency diagnostics with the real device: `cargo test --lib -- --ignored --nocapture output_latency`.
    #[test]
    #[ignore]
    fn output_latency_report() {
        let (em, _) = collecting_emitter();
        let eng = AudioEngine::new(sf2_path(), em);
        let t0 = std::time::Instant::now();
        for ms in [50u64, 100, 200, 400, 800, 1500, 3000, 6000] {
            std::thread::sleep(Duration::from_millis(ms).saturating_sub(t0.elapsed()));
            let (frames, sr) = (eng.callback_frames(), eng.sample_rate());
            println!(
                "t={ms:>5} ms  sample_rate={sr} frames/callback={frames:>5}  output latency={:>6.1} ms",
                eng.output_latency_us() as f64 / 1000.0
            );
        }
    }

    #[test]
    fn missing_soundfont_degrades_gracefully() {
        let dir = tempfile::tempdir().unwrap();
        let mid = test_midi(dir.path());
        let (em, _) = collecting_emitter();
        let eng = AudioEngine::new_headless(&dir.path().join("nope.sf2"), em);
        assert!(!eng.synth_available());
        eng.play_file(&mid, 0).unwrap();
        let out = eng.render_offline(22_050);
        assert!(peak(&out) < 1e-6);
        assert!(eng.position_ms() >= 495, "the sequencer advances even without a synth");
        eng.set_metronome(true, 100);
        assert!(peak(&eng.render_offline(4_410)) > 0.1);
    }
}
