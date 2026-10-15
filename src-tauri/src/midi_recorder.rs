//! MIDI capture engine (section 4.1 of the specification).
//!
//! - Lists input ports with `midir` (ALSA on Linux). If ALSA is not available, only the
//!   built-in simulator is offered; it always comes last.
//! - Records NoteOn/NoteOff/ControlChange/PitchBend messages with a µs timestamp relative to the
//!   `Instant` t0 (plus the raw take's offset when resuming).
//! - Every accepted message is forwarded to `sink` (the app wires it to the live synthesizer,
//!   which decides whether it sounds).
//! - On stop it closes open notes and the pedal, and writes SMF format 0 (480 TPQ).

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::midi_slicer::{
    as_note_off, as_note_on, midi_duration_ms, note_off_msg, read_timed_events, sustain_msg, write_smf,
    TimedMidiEvent,
};
use crate::models::MidiPortInfo;

pub const SIMULATOR_PORT_ID: &str = "simulator";
pub const SIMULATOR_PORT_NAME: &str = "MIDI simulator (no keyboard)";
const MIDIR_PREFIX: &str = "midir:";
const CLIENT_NAME: &str = "piano-tracker";

/// Destination of the captured MIDI messages (live monitoring).
pub type MidiSink = Arc<dyn Fn(&[u8]) + Send + Sync>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Lists the MIDI input ports. It never fails: if ALSA is not available it returns only the
/// simulator, which always comes last.
pub fn list_ports() -> Vec<MidiPortInfo> {
    let mut ports: Vec<MidiPortInfo> = Vec::new();
    match midir::MidiInput::new(CLIENT_NAME) {
        Ok(input) => {
            for port in input.ports() {
                match input.port_name(&port) {
                    Ok(name) => {
                        if name.starts_with(CLIENT_NAME) {
                            continue; // our own ports
                        }
                        let is_virtual = name.contains("Through");
                        ports.push(MidiPortInfo { id: format!("{MIDIR_PREFIX}{name}"), name, is_virtual });
                    }
                    Err(e) => log::warn!("midi_recorder: could not read a port name: {e}"),
                }
            }
        }
        Err(e) => log::warn!("midi_recorder: system MIDI not available ({e}); simulator only"),
    }
    ports.push(MidiPortInfo { id: SIMULATOR_PORT_ID.to_string(), name: SIMULATOR_PORT_NAME.to_string(), is_virtual: true });
    ports
}

/// State shared between the capture thread and the recorder.
struct RecShared {
    t0: Instant,
    offset_us: u64,
    events: Mutex<Vec<TimedMidiEvent>>,
    sink: MidiSink,
}

impl RecShared {
    fn now_us(&self) -> u64 {
        self.offset_us + self.t0.elapsed().as_micros() as u64
    }

    /// Common path for real and simulator messages.
    fn handle_message(&self, bytes: &[u8]) {
        let Some(&status) = bytes.first() else { return };
        // Filters out system messages (clock 0xF8, active sensing 0xFE, sysex 0xF0...) and stray data bytes.
        if !(0x80..0xF0).contains(&status) {
            return;
        }
        let needed = match status & 0xF0 {
            0x80 | 0x90 | 0xB0 | 0xE0 => 3,
            _ => return, // aftertouch / program change are not recorded
        };
        if bytes.len() < needed {
            return;
        }
        let msg = bytes[..needed].to_vec();
        let t = self.now_us();
        lock(&self.events).push(TimedMidiEvent::new(t, msg.clone()));
        (self.sink)(&msg);
    }
}

enum Source {
    Simulator,
    Midir,
}

struct ActiveRecording {
    shared: Arc<RecShared>,
    base_events: Vec<TimedMidiEvent>,
    stop_tx: Sender<()>,
    thread: Option<JoinHandle<()>>,
    _source: Source,
}

/// MIDI recorder. Safe to share between threads (Tauri managed state).
pub struct MidiRecorder {
    active: Mutex<Option<ActiveRecording>>,
    bpm: Arc<AtomicU32>,
}

impl Default for MidiRecorder {
    fn default() -> Self {
        Self::new()
    }
}

impl MidiRecorder {
    pub fn new() -> Self {
        MidiRecorder { active: Mutex::new(None), bpm: Arc::new(AtomicU32::new(120)) }
    }

    /// Starts recording from `port_id` (`"simulator"` or `"midir:<name>"`).
    /// If `resume_from` exists, its events are kept and the new ones are shifted by its duration.
    pub fn start(&self, port_id: &str, bpm: u32, resume_from: Option<&Path>, sink: MidiSink) -> Result<(), String> {
        let mut active = lock(&self.active);
        if active.is_some() {
            return Err(t!("backend.recorder.alreadyRunning"));
        }
        let (base_events, offset_ms) = match resume_from {
            Some(p) if p.exists() => read_timed_events(p)?,
            _ => (Vec::new(), 0),
        };
        self.bpm.store(bpm.max(1), Ordering::SeqCst);
        let shared = Arc::new(RecShared {
            t0: Instant::now(),
            offset_us: offset_ms * 1000,
            events: Mutex::new(Vec::new()),
            sink,
        });
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let (thread, source) = if port_id == SIMULATOR_PORT_ID {
            let sh = Arc::clone(&shared);
            let bpm = Arc::clone(&self.bpm);
            let handle = std::thread::Builder::new()
                .name("midi-simulator".into())
                .spawn(move || run_simulator(sh, bpm, stop_rx))
                .map_err(|e| t!("backend.recorder.simulatorFailed", e = e))?;
            (handle, Source::Simulator)
        } else {
            let wanted = port_id.strip_prefix(MIDIR_PREFIX).unwrap_or(port_id).to_string();
            let sh = Arc::clone(&shared);
            let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
            let handle = std::thread::Builder::new()
                .name("midi-input".into())
                .spawn(move || run_midir_connection(wanted, sh, stop_rx, ready_tx))
                .map_err(|e| t!("backend.recorder.captureFailed", e = e))?;
            match ready_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    let _ = handle.join();
                    return Err(e);
                }
                Err(_) => {
                    let _ = stop_tx.send(());
                    return Err(t!("backend.recorder.timeout"));
                }
            }
            (handle, Source::Midir)
        };

        *active = Some(ActiveRecording { shared, base_events, stop_tx, thread: Some(thread), _source: source });
        log::info!("midi_recorder: recording started on {port_id} at {bpm} BPM (offset {offset_ms} ms)");
        Ok(())
    }

    pub fn set_bpm(&self, bpm: u32) {
        self.bpm.store(bpm.max(1), Ordering::SeqCst);
    }

    pub fn bpm(&self) -> u32 {
        self.bpm.load(Ordering::SeqCst)
    }

    pub fn is_recording(&self) -> bool {
        lock(&self.active).is_some()
    }

    /// Elapsed time of the current take (without the resume offset).
    pub fn elapsed_ms(&self) -> u64 {
        lock(&self.active).as_ref().map(|a| a.shared.t0.elapsed().as_millis() as u64).unwrap_or(0)
    }

    /// Stops recording, closes notes/pedal at the stop instant, writes the SMF (active BPM) and
    /// returns the total duration in ms.
    pub fn stop(&self, output_path: &Path) -> Result<u64, String> {
        let mut rec = lock(&self.active).take().ok_or_else(|| t!("backend.recorder.notRunning"))?;
        let _ = rec.stop_tx.send(());
        if let Some(t) = rec.thread.take() {
            if t.join().is_err() {
                log::error!("midi_recorder: the capture thread panicked");
            }
        }
        let shared = rec.shared;
        let mut events = std::mem::take(&mut *lock(&shared.events));
        let stop_us = shared.now_us().max(events.iter().map(|e| e.time_us).max().unwrap_or(0));

        // Close open notes and the pedal at the stop instant.
        let mut open: Vec<(u8, u8)> = Vec::new();
        let mut channels: BTreeSet<u8> = BTreeSet::new();
        for ev in &events {
            if let Some(&s) = ev.bytes.first() {
                channels.insert(s & 0x0F);
            }
            if let Some((ch, key, _)) = as_note_on(&ev.bytes) {
                open.push((ch, key));
            } else if let Some((ch, key)) = as_note_off(&ev.bytes) {
                if let Some(pos) = open.iter().position(|n| *n == (ch, key)) {
                    open.remove(pos);
                }
            }
        }
        if channels.is_empty() {
            channels.insert(0);
        }
        let mut closing: Vec<Vec<u8>> = open.into_iter().map(|(ch, key)| note_off_msg(ch, key)).collect();
        closing.extend(channels.into_iter().map(|ch| sustain_msg(ch, 0)));
        for msg in closing {
            (shared.sink)(&msg);
            events.push(TimedMidiEvent::new(stop_us, msg));
        }

        let mut all = rec.base_events;
        all.extend(events);
        let bpm = self.bpm.load(Ordering::SeqCst);
        write_smf(output_path, &all, bpm)?;
        let duration = midi_duration_ms(output_path)?;
        log::info!("midi_recorder: recording saved to {} ({duration} ms)", output_path.display());
        Ok(duration)
    }
}

impl Drop for MidiRecorder {
    fn drop(&mut self) {
        if let Some(mut rec) = lock(&self.active).take() {
            let _ = rec.stop_tx.send(());
            if let Some(t) = rec.thread.take() {
                let _ = t.join();
            }
        }
    }
}

/// Thread that owns the `midir` connection (the connection lives and is closed on this thread).
fn run_midir_connection(
    wanted: String,
    shared: Arc<RecShared>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: Sender<Result<(), String>>,
) {
    let mut input = match midir::MidiInput::new(CLIENT_NAME) {
        Ok(i) => i,
        Err(e) => {
            let _ = ready_tx.send(Err(t!("backend.recorder.midiUnavailable", e = e)));
            return;
        }
    };
    input.ignore(midir::Ignore::All);
    let ports = input.ports();
    let names: Vec<(usize, String)> =
        ports.iter().enumerate().filter_map(|(i, p)| input.port_name(p).ok().map(|n| (i, n))).collect();
    // Exact match; otherwise, ignoring ALSA's "client:port" suffix (it can change).
    let strip = |s: &str| s.rsplit_once(' ').map(|(a, _)| a.to_string()).unwrap_or_else(|| s.to_string());
    let idx = names
        .iter()
        .find(|(_, n)| *n == wanted)
        .or_else(|| names.iter().find(|(_, n)| strip(n) == strip(&wanted)))
        .map(|(i, _)| *i);
    let Some(port) = idx.and_then(|i| ports.get(i)) else {
        let _ = ready_tx.send(Err(t!("backend.recorder.portNotFound", port = wanted)));
        return;
    };
    let sh = Arc::clone(&shared);
    let conn = input.connect(port, "piano-tracker-in", move |_ts, msg, _| sh.handle_message(msg), ());
    match conn {
        Ok(conn) => {
            let _ = ready_tx.send(Ok(()));
            let _ = stop_rx.recv(); // waits for stop (or for the sender to be dropped)
            conn.close();
        }
        Err(e) => {
            let _ = ready_tx.send(Err(t!("backend.recorder.connectFailed", port = wanted, e = e)));
        }
    }
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % ((hi - lo + 1).max(1) as u64)) as i64
    }
}

/// Generates one bar: list of (offset_us, message). I-vi-IV-V progression in C major: sustained
/// bass + eighth-note arpeggio + pedal released and pressed again on each chord change.
fn simulator_bar(bar: u64, bpm: u32, rng: &mut Rng) -> (Vec<(u64, Vec<u8>)>, u64) {
    const CHORDS: [[u8; 4]; 4] = [[48, 60, 64, 67], [45, 57, 60, 64], [41, 57, 60, 65], [43, 55, 59, 62]];
    let beat_us = 60_000_000 / bpm.clamp(20, 400) as u64;
    let bar_us = beat_us * 4;
    let eighth = beat_us / 2;
    let chord = CHORDS[(bar % 4) as usize];
    let mut ev: Vec<(u64, Vec<u8>)> = Vec::new();
    ev.push((0, sustain_msg(0, 0)));
    ev.push((eighth / 4, sustain_msg(0, 127)));
    let bass_vel = rng.range(60, 95) as u8;
    ev.push((0, vec![0x90, chord[0], bass_vel]));
    ev.push((bar_us - eighth / 8, note_off_msg(0, chord[0])));
    let pattern: [usize; 8] = [1, 2, 3, 2, 1, 2, 3, 2];
    let octave_up = bar % 8 >= 4;
    for (i, idx) in pattern.iter().enumerate() {
        let key = chord[*idx] + if octave_up && i >= 4 { 12 } else { 0 };
        let t = i as u64 * eighth;
        let accent = if i % 2 == 0 { 12 } else { 0 };
        let vel = (rng.range(50, 85) + accent).clamp(1, 127) as u8;
        ev.push((t, vec![0x90, key, vel]));
        ev.push((t + eighth * 9 / 10, note_off_msg(0, key)));
    }
    ev.sort_by_key(|e| e.0);
    (ev, bar_us)
}

fn run_simulator(shared: Arc<RecShared>, bpm: Arc<AtomicU32>, stop_rx: mpsc::Receiver<()>) {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seed = 0x2545_F491_4F6C_DD1D ^ nanos ^ std::process::id() as u64;
    let mut rng = Rng(seed | 1);
    let start = Instant::now();
    let mut bar_start_us = 0u64;
    let mut bar: u64 = 0;
    let mut open: HashMap<u8, u32> = HashMap::new();
    // Waits until `target_us` (relative to the simulator start). Returns false if it must stop.
    let wait_until = |target_us: u64| -> bool {
        loop {
            let now = start.elapsed().as_micros() as u64;
            if now >= target_us {
                return true;
            }
            match stop_rx.recv_timeout(Duration::from_micros((target_us - now).min(20_000))) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => return false,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    };
    'outer: loop {
        let current_bpm = bpm.load(Ordering::SeqCst);
        // Occasional 1–2 s silence (never in the first bars).
        if bar >= 3 && bar % 6 == 5 && rng.range(0, 1) == 1 {
            let pause = rng.range(1_000_000, 2_000_000) as u64;
            bar_start_us += pause;
            if !wait_until(bar_start_us) {
                break 'outer;
            }
        }
        let (events, bar_len) = simulator_bar(bar, current_bpm, &mut rng);
        for (off, msg) in events {
            if !wait_until(bar_start_us + off) {
                break 'outer;
            }
            if let Some((_, key, _)) = as_note_on(&msg) {
                *open.entry(key).or_default() += 1;
            } else if let Some((_, key)) = as_note_off(&msg) {
                match open.get_mut(&key) {
                    Some(c) if *c > 0 => *c -= 1,
                    _ => continue,
                }
            }
            shared.handle_message(&msg);
        }
        bar_start_us += bar_len;
        bar += 1;
    }
    // Notes still open are closed by `MidiRecorder::stop` at the stop instant.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi_slicer::as_sustain;
    use std::sync::atomic::AtomicUsize;

    fn assert_clean(events: &[TimedMidiEvent]) {
        let mut open: HashMap<(u8, u8), i32> = HashMap::new();
        let mut pedal: HashMap<u8, u8> = HashMap::new();
        for e in events {
            if let Some((ch, k, _)) = as_note_on(&e.bytes) {
                *open.entry((ch, k)).or_default() += 1;
            } else if let Some((ch, k)) = as_note_off(&e.bytes) {
                let c = open.entry((ch, k)).or_default();
                assert!(*c > 0, "orphan NoteOff");
                *c -= 1;
            } else if let Some((ch, v)) = as_sustain(&e.bytes) {
                pedal.insert(ch, v);
            }
        }
        assert!(open.values().all(|c| *c == 0), "hanging notes: {open:?}");
        assert!(pedal.values().all(|v| *v < 64));
    }

    fn counting_sink() -> (MidiSink, Arc<AtomicUsize>) {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = Arc::clone(&n);
        (Arc::new(move |_b: &[u8]| {
            n2.fetch_add(1, Ordering::SeqCst);
        }), n)
    }

    #[test]
    fn recorder_is_send_sync() {
        fn check<T: Send + Sync>() {}
        check::<MidiRecorder>();
    }

    #[test]
    fn list_ports_always_includes_simulator_last() {
        let ports = list_ports();
        let last = ports.last().expect("at least the simulator");
        assert_eq!(last.id, SIMULATOR_PORT_ID);
        assert_eq!(last.name, SIMULATOR_PORT_NAME);
        assert!(last.is_virtual);
        assert_eq!(ports.iter().filter(|p| p.id == SIMULATOR_PORT_ID).count(), 1);
    }

    #[test]
    fn records_with_simulator_and_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("raw_session_test.mid");
        let rec = MidiRecorder::new();
        let (sink, count) = counting_sink();
        assert!(!rec.is_recording());
        rec.start(SIMULATOR_PORT_ID, 240, None, Arc::clone(&sink)).unwrap();
        assert!(rec.is_recording());
        assert!(rec.start(SIMULATOR_PORT_ID, 240, None, Arc::clone(&sink)).is_err(), "cannot record twice");
        std::thread::sleep(Duration::from_millis(1200));
        assert!(rec.elapsed_ms() >= 1000);
        let dur = rec.stop(&out).unwrap();
        assert!(!rec.is_recording());
        assert_eq!(rec.elapsed_ms(), 0);
        assert!(out.is_file());
        assert!((1150..2500).contains(&dur), "duration {dur}");
        assert!(count.load(Ordering::SeqCst) > 0, "the sink must receive messages");
        let (evs, d) = read_timed_events(&out).unwrap();
        assert_eq!(d, dur);
        assert!(evs.iter().any(|e| as_note_on(&e.bytes).is_some()));
        assert!(evs.iter().any(|e| as_sustain(&e.bytes).is_some()));
        assert_clean(&evs);
        assert!(rec.stop(&out).is_err(), "stop without a recording is an error");

        // Resuming: the second take is shifted by the duration of the first.
        rec.start(SIMULATOR_PORT_ID, 240, Some(&out), sink).unwrap();
        std::thread::sleep(Duration::from_millis(600));
        let dur2 = rec.stop(&out).unwrap();
        assert!(dur2 >= dur + 550, "dur2={dur2} dur={dur}");
        let (evs2, _) = read_timed_events(&out).unwrap();
        assert_clean(&evs2);
        let n_first = evs.len();
        assert!(evs2.len() > n_first);
        // The first take's events are kept and the new ones start after `dur`.
        let new_note_ons: Vec<_> =
            evs2.iter().filter(|e| e.time_us > dur * 1000 + 1500 && as_note_on(&e.bytes).is_some()).collect();
        assert!(!new_note_ons.is_empty());
        assert!(evs2.iter().filter(|e| e.time_us <= dur * 1000 + 1500).count() >= n_first);
    }

    #[test]
    fn unknown_port_fails_gracefully() {
        let rec = MidiRecorder::new();
        let (sink, _) = counting_sink();
        assert!(rec.start("midir:__no_existe__", 120, None, sink).is_err());
        assert!(!rec.is_recording());
    }

    #[test]
    fn filters_system_messages() {
        let (sink, count) = counting_sink();
        let shared = RecShared { t0: Instant::now(), offset_us: 5_000, events: Mutex::new(Vec::new()), sink };
        shared.handle_message(&[0xF8]);
        shared.handle_message(&[0xFE]);
        shared.handle_message(&[0xF0, 0x7E, 0x7F, 0xF7]);
        shared.handle_message(&[0x90, 60]); // incomplete
        shared.handle_message(&[0xC0, 1]); // program change: not recorded
        shared.handle_message(&[0x90, 60, 100]);
        shared.handle_message(&[0xB0, 64, 127]);
        shared.handle_message(&[0xE0, 0, 64]);
        let evs = lock(&shared.events);
        assert_eq!(evs.len(), 3);
        assert!(evs.iter().all(|e| e.time_us >= 5_000));
        assert_eq!(count.load(Ordering::SeqCst), 3);
    }
}
