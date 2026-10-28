//! Challenge mode: playing a reference melody at an adjustable tempo and scoring the attempt.
//!
//! Timeline of an attempt: `t = 0` is the first note of the melody (its leading silence is
//! trimmed) and the expected times are scaled by `100 / tempo_pct`. Played times are converted to
//! that timeline by the caller (count-in and latency compensation subtracted), so they can be
//! negative for a note played slightly before the first one.
//!
//! A played note-on is a hit if an expected note with the same key is still unmatched within
//! ±`window`; the closest one is taken, so chords work on their own. Otherwise it is `Wrong` if
//! another expected note was due within the window, or `Extra` if nothing was. An expected note
//! whose window has passed unmatched is missed. The same [`Matcher`] scores live (note by note)
//! and offline ([`score_attempt`]), so both always agree.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::midi_recorder::MidiSink;
use crate::midi_slicer::{as_note_off, as_note_on, note_off_msg, read_initial_bpm, read_timed_events, write_smf, TimedMidiEvent};
use crate::models::{
    AttemptDetails, ChallengeNoteEvent, ChallengeNoteKind, ChallengeProgress, NoteDto, NoteOutcome, NoteStatus,
    PlayedError, PlayedErrorKind,
};

pub const TEMPO_PCT_MIN: u32 = 40;
pub const TEMPO_PCT_MAX: u32 = 150;
/// Hit window at 100 %, before clamping.
const BASE_WINDOW_US: i64 = 150_000;
const MIN_WINDOW_US: i64 = 100_000;
const MAX_WINDOW_US: i64 = 250_000;
/// A note is missed a bit after its window closes, so a note-on timestamped just before an
/// `advance` but processed after it can still hit.
const MISS_GRACE_US: i64 = 50_000;

/// A note of a melody with absolute times in µs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub key: u8,
    pub ch: u8,
    pub start_us: u64,
    pub end_us: u64,
    pub vel: u8,
}

/// Pairs note-ons with note-offs (FIFO per channel and key) and trims the leading silence: the
/// first note starts at 0. Notes left open end at the last event. Sorted by start and key.
pub fn extract_notes(events: &[TimedMidiEvent]) -> Vec<Note> {
    let mut open: HashMap<(u8, u8), Vec<usize>> = HashMap::new();
    let mut notes: Vec<Note> = Vec::new();
    let last_us = events.iter().map(|e| e.time_us).max().unwrap_or(0);
    for e in events {
        if let Some((ch, key, vel)) = as_note_on(&e.bytes) {
            open.entry((ch, key)).or_default().push(notes.len());
            notes.push(Note { key, ch, start_us: e.time_us, end_us: last_us, vel });
        } else if let Some((ch, key)) = as_note_off(&e.bytes) {
            if let Some(queue) = open.get_mut(&(ch, key)) {
                if !queue.is_empty() {
                    let i = queue.remove(0);
                    notes[i].end_us = e.time_us;
                }
            }
        }
    }
    let first = notes.iter().map(|n| n.start_us).min().unwrap_or(0);
    for n in &mut notes {
        n.start_us -= first;
        n.end_us = n.end_us.saturating_sub(first).max(n.start_us);
    }
    notes.sort_by_key(|n| (n.start_us, n.key));
    notes
}

/// Notes of a melody file.
pub fn load_notes(path: &Path) -> Result<Vec<Note>, String> {
    read_timed_events(path).map(|(events, _)| extract_notes(&events))
}

/// What `freeze_melody` found in the source file.
#[derive(Clone, Debug, PartialEq)]
pub struct FrozenMelody {
    pub bpm: u32,
    pub duration_ms: u64,
    pub note_count: u32,
}

/// Copies `source` to `dest` with its leading silence removed, so the file and the notes share
/// the same timeline (the first note at 0). Controller and program changes before the first
/// note move to 0. Fails if the file has no notes.
pub fn freeze_melody(source: &Path, dest: &Path) -> Result<FrozenMelody, String> {
    let (events, _) = read_timed_events(source)?;
    let bpm = read_initial_bpm(source).unwrap_or(120);
    let notes = extract_notes(&events);
    let Some(first) = events.iter().filter(|e| as_note_on(&e.bytes).is_some()).map(|e| e.time_us).min() else {
        return Err(t!("backend.challenge.noNotes"));
    };
    let shifted: Vec<TimedMidiEvent> = events
        .into_iter()
        .filter(|e| e.time_us >= first || as_note_off(&e.bytes).is_none())
        .map(|e| TimedMidiEvent::new(e.time_us.saturating_sub(first), e.bytes))
        .collect();
    write_smf(dest, &shifted, bpm)?;
    Ok(FrozenMelody {
        bpm,
        duration_ms: (notes.iter().map(|n| n.end_us).max().unwrap_or(0) + 500) / 1000,
        note_count: notes.len() as u32,
    })
}

pub fn note_dtos(notes: &[Note]) -> Vec<NoteDto> {
    notes
        .iter()
        .map(|n| NoteDto { key: n.key, start_ms: n.start_us / 1000, end_ms: n.end_us / 1000, velocity: n.vel })
        .collect()
}

pub fn clamp_tempo_pct(tempo_pct: u32) -> u32 {
    tempo_pct.clamp(TEMPO_PCT_MIN, TEMPO_PCT_MAX)
}

/// Converts an original time to the attempt's timeline.
pub fn scale_us(us: u64, tempo_pct: u32) -> i64 {
    (us as u128 * 100 / clamp_tempo_pct(tempo_pct) as u128) as i64
}

/// Half-width of the hit window: wider when slower, within 100-250 ms.
pub fn window_us(tempo_pct: u32) -> i64 {
    (BASE_WINDOW_US * 100 / clamp_tempo_pct(tempo_pct) as i64).clamp(MIN_WINDOW_US, MAX_WINDOW_US)
}

/// Effective BPM of a melody at `tempo_pct`.
pub fn effective_bpm(bpm: u32, tempo_pct: u32) -> u32 {
    ((bpm as u64 * clamp_tempo_pct(tempo_pct) as u64 + 50) / 100).max(1) as u32
}

/// What a played note-on turned out to be.
#[derive(Clone, Debug, PartialEq)]
pub enum Played {
    Hit { index: usize, offset_us: i64, perfect: bool },
    Wrong { expected_key: u8 },
    Extra,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    Pending,
    Hit { offset_us: i64, perfect: bool },
    Missed,
}

/// Totals of a finished attempt.
#[derive(Clone, Debug, PartialEq)]
pub struct AttemptResult {
    pub score: u32,
    pub accuracy: f64,
    pub hits: u32,
    pub perfect: u32,
    pub misses: u32,
    pub wrong: u32,
    pub extra: u32,
    pub mean_offset_ms: i32,
    pub mean_abs_offset_ms: u32,
    pub details: AttemptDetails,
}

/// Incremental scorer of one attempt.
pub struct Matcher {
    /// `(key, expected time)` in the attempt's timeline, sorted by time.
    expected: Vec<(u8, i64)>,
    states: Vec<State>,
    errors: Vec<PlayedError>,
    window_us: i64,
    /// Every expected note before this index has been resolved by `advance`.
    miss_cursor: usize,
}

impl Matcher {
    pub fn new(notes: &[Note], tempo_pct: u32) -> Self {
        let expected: Vec<(u8, i64)> = notes.iter().map(|n| (n.key, scale_us(n.start_us, tempo_pct))).collect();
        Matcher {
            states: vec![State::Pending; expected.len()],
            expected,
            errors: Vec::new(),
            window_us: window_us(tempo_pct),
            miss_cursor: 0,
        }
    }

    pub fn window_us(&self) -> i64 {
        self.window_us
    }

    /// Expected time of the last note (0 if the melody is empty).
    pub fn last_expected_us(&self) -> i64 {
        self.expected.last().map(|e| e.1).unwrap_or(0)
    }

    /// Classifies a played note-on at `time_us` (attempt timeline).
    pub fn on_note_on(&mut self, time_us: i64, key: u8) -> Played {
        let w = self.window_us;
        let from = self.expected.partition_point(|e| e.1 < time_us - w);
        let to = self.expected.partition_point(|e| e.1 <= time_us + w);
        let mut best: Option<(usize, i64)> = None;
        let mut nearest_other: Option<(u8, i64)> = None;
        for i in from..to {
            if self.states[i] != State::Pending {
                continue;
            }
            let (k, t) = self.expected[i];
            let d = time_us - t;
            if k == key {
                if best.is_none_or(|(_, bd)| d.abs() < bd.abs()) {
                    best = Some((i, d));
                }
            } else if nearest_other.is_none_or(|(_, od)| d.abs() < od.abs()) {
                nearest_other = Some((k, d));
            }
        }
        if let Some((index, offset_us)) = best {
            let perfect = offset_us.abs() * 3 <= w;
            self.states[index] = State::Hit { offset_us, perfect };
            return Played::Hit { index, offset_us, perfect };
        }
        let (kind, expected_key, played) = match nearest_other {
            Some((k, _)) => (PlayedErrorKind::Wrong, Some(k), Played::Wrong { expected_key: k }),
            None => (PlayedErrorKind::Extra, None, Played::Extra),
        };
        self.errors.push(PlayedError { time_ms: time_us.div_euclid(1000), kind, played_key: key, expected_key });
        played
    }

    /// Marks as missed the notes whose window has closed by `now_us`; returns their indices.
    pub fn advance(&mut self, now_us: i64) -> Vec<usize> {
        let mut missed = Vec::new();
        while let Some(&(_, t)) = self.expected.get(self.miss_cursor) {
            if t + self.window_us + MISS_GRACE_US >= now_us {
                break;
            }
            if self.states[self.miss_cursor] == State::Pending {
                self.states[self.miss_cursor] = State::Missed;
                missed.push(self.miss_cursor);
            }
            self.miss_cursor += 1;
        }
        missed
    }

    pub fn hits(&self) -> u32 {
        self.states.iter().filter(|s| matches!(s, State::Hit { .. })).count() as u32
    }

    pub fn misses(&self) -> u32 {
        self.states.iter().filter(|s| matches!(s, State::Missed)).count() as u32
    }

    pub fn error_count(&self) -> u32 {
        self.errors.len() as u32
    }

    /// Closes the attempt: every note still pending counts as missed.
    pub fn finish(mut self) -> AttemptResult {
        self.advance(i64::MAX / 2);
        let n = self.expected.len();
        let w = self.window_us as f64;
        let (mut hits, mut perfect, mut misses) = (0u32, 0u32, 0u32);
        let (mut quality, mut sum_off, mut sum_abs) = (0.0f64, 0i64, 0i64);
        let mut notes = Vec::with_capacity(n);
        for s in &self.states {
            match *s {
                State::Hit { offset_us, perfect: p } => {
                    hits += 1;
                    perfect += p as u32;
                    quality += 1.0 - 0.5 * (offset_us.abs() as f64 / w).min(1.0);
                    sum_off += offset_us;
                    sum_abs += offset_us.abs();
                    let status = if p { NoteStatus::Perfect } else { NoteStatus::Good };
                    notes.push(NoteOutcome { status, offset_ms: Some((offset_us as f64 / 1000.0).round() as i32) });
                }
                _ => {
                    misses += 1;
                    notes.push(NoteOutcome { status: NoteStatus::Missed, offset_ms: None });
                }
            }
        }
        let wrong = self.errors.iter().filter(|e| e.kind == PlayedErrorKind::Wrong).count() as u32;
        let extra = self.errors.len() as u32 - wrong;
        let denominator = n as f64 + 0.5 * (wrong + extra) as f64;
        let score = if denominator > 0.0 { (1000.0 * quality / denominator).round() as u32 } else { 0 };
        let mean = |sum: i64| if hits > 0 { (sum as f64 / hits as f64 / 1000.0).round() as i64 } else { 0 };
        AttemptResult {
            score: score.min(1000),
            accuracy: if n > 0 { hits as f64 / n as f64 } else { 0.0 },
            hits,
            perfect,
            misses,
            wrong,
            extra,
            mean_offset_ms: mean(sum_off) as i32,
            mean_abs_offset_ms: mean(sum_abs) as u32,
            details: AttemptDetails { notes, errors: self.errors },
        }
    }
}

/// Scores a whole attempt offline. `played` holds the raw events with their capture times;
/// `shift_us` (count-in + latency compensation) is subtracted to move them to the attempt's
/// timeline.
pub fn score_attempt(notes: &[Note], played: &[TimedMidiEvent], tempo_pct: u32, shift_us: i64) -> AttemptResult {
    let mut m = Matcher::new(notes, tempo_pct);
    let mut ons: Vec<(i64, u8)> = played
        .iter()
        .filter_map(|e| as_note_on(&e.bytes).map(|(_, key, _)| (e.time_us as i64 - shift_us, key)))
        .collect();
    ons.sort_by_key(|o| o.0);
    for (t, key) in ons {
        m.advance(t);
        m.on_note_on(t, key);
    }
    m.finish()
}

// ---------------------------------------------------------------------------
// Live runner
// ---------------------------------------------------------------------------

/// Beats of count-in before the first note.
pub const COUNT_IN_BEATS: u64 = 4;
/// The attempt ends on its own this long after the last note's window closes.
const END_TAIL_US: i64 = 1_500_000;
const TICK: Duration = Duration::from_millis(50);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Count-in length at `bpm`.
pub fn count_in_us(bpm: u32) -> u64 {
    COUNT_IN_BEATS * 60_000_000 / bpm.max(1) as u64
}

/// Where the runner reports to (the app wires these to Tauri events).
#[derive(Clone)]
pub struct ChallengeEmitter {
    pub note: Arc<dyn Fn(ChallengeNoteEvent) + Send + Sync>,
    pub progress: Arc<dyn Fn(ChallengeProgress) + Send + Sync>,
    /// The count-in is over: the first note is due now.
    pub go: Arc<dyn Fn() + Send + Sync>,
    /// The attempt reached its end on its own. Called once, from the ticker thread.
    pub time_up: Arc<dyn Fn() + Send + Sync>,
}

struct RunShared {
    start: Instant,
    count_in_us: u64,
    /// Count-in + latency compensation: capture clock → attempt timeline.
    shift_us: i64,
    end_us: i64,
    matcher: Mutex<Matcher>,
    /// Everything captured, with the capture clock (µs since `start`).
    played: Mutex<Vec<TimedMidiEvent>>,
    stopped: AtomicBool,
    emitter: ChallengeEmitter,
}

impl RunShared {
    fn clock_us(&self) -> u64 {
        self.start.elapsed().as_micros() as u64
    }

    fn on_midi(&self, bytes: &[u8]) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let clock = self.clock_us();
        lock(&self.played).push(TimedMidiEvent::new(clock, bytes.to_vec()));
        let Some((_, key, _)) = as_note_on(bytes) else { return };
        let t = clock as i64 - self.shift_us;
        let played = lock(&self.matcher).on_note_on(t, key);
        let (kind, expected_index, offset_ms) = match played {
            Played::Hit { index, offset_us, perfect } => (
                if perfect { ChallengeNoteKind::Perfect } else { ChallengeNoteKind::Good },
                Some(index as u32),
                Some((offset_us as f64 / 1000.0).round() as i32),
            ),
            Played::Wrong { .. } => (ChallengeNoteKind::Wrong, None, None),
            Played::Extra => (ChallengeNoteKind::Extra, None, None),
        };
        (self.emitter.note)(ChallengeNoteEvent { time_ms: t.div_euclid(1000), key, kind, expected_index, offset_ms });
    }
}

fn run_ticker(sh: Arc<RunShared>) {
    let mut went = false;
    loop {
        if sh.stopped.load(Ordering::SeqCst) {
            return;
        }
        let clock = sh.clock_us();
        if !went && clock >= sh.count_in_us {
            went = true;
            (sh.emitter.go)();
        }
        let t = clock as i64 - sh.shift_us;
        let progress = {
            let mut m = lock(&sh.matcher);
            let missed = m.advance(t);
            ChallengeProgress {
                elapsed_ms: t.div_euclid(1000),
                hits: m.hits(),
                misses: m.misses(),
                errors: m.error_count(),
                missed: missed.into_iter().map(|i| i as u32).collect(),
            }
        };
        (sh.emitter.progress)(progress);
        if t >= sh.end_us {
            if !sh.stopped.load(Ordering::SeqCst) {
                (sh.emitter.time_up)();
            }
            return;
        }
        // Wakes up exactly at the end of the count-in, so the guide starts on time.
        let mut sleep = TICK;
        if !went {
            sleep = sleep.min(Duration::from_micros(sh.count_in_us.saturating_sub(clock)));
        }
        std::thread::sleep(sleep);
    }
}

/// What a stopped run leaves behind.
pub struct RunOutcome {
    pub result: AttemptResult,
    /// Captured events with the capture clock (count-in included).
    pub played: Vec<TimedMidiEvent>,
    pub duration_ms: u64,
}

/// One attempt in progress: the clock starts when it is created (count-in first).
pub struct ChallengeRunner {
    shared: Arc<RunShared>,
    notes: Vec<Note>,
    tempo_pct: u32,
}

impl ChallengeRunner {
    /// Starts the clock and the ticker. `bpm` is the effective one (count-in length).
    pub fn start(notes: Vec<Note>, tempo_pct: u32, bpm: u32, latency_us: u64, emitter: ChallengeEmitter) -> Self {
        let matcher = Matcher::new(&notes, tempo_pct);
        let count_in = count_in_us(bpm);
        let end_us = matcher.last_expected_us() + matcher.window_us() + END_TAIL_US;
        let shared = Arc::new(RunShared {
            start: Instant::now(),
            count_in_us: count_in,
            shift_us: (count_in + latency_us) as i64,
            end_us,
            matcher: Mutex::new(matcher),
            played: Mutex::new(Vec::new()),
            stopped: AtomicBool::new(false),
            emitter,
        });
        let sh = Arc::clone(&shared);
        if let Err(e) = std::thread::Builder::new().name("challenge-ticker".into()).spawn(move || run_ticker(sh)) {
            log::error!("challenge: could not start the ticker: {e}");
        }
        ChallengeRunner { shared, notes, tempo_pct }
    }

    /// Sink for the MIDI capture: scores every note-on as it arrives.
    pub fn sink(&self) -> MidiSink {
        let sh = Arc::clone(&self.shared);
        Arc::new(move |bytes: &[u8]| sh.on_midi(bytes))
    }

    pub fn count_in_us(&self) -> u64 {
        self.shared.count_in_us
    }

    pub fn window_us(&self) -> i64 {
        lock(&self.shared.matcher).window_us()
    }

    /// The melody played exactly on time, with the capture clock (for the simulator).
    pub fn script(&self) -> Vec<TimedMidiEvent> {
        let shift = self.shared.shift_us;
        let at = |us: u64| (scale_us(us, self.tempo_pct) + shift).max(0) as u64;
        let mut script: Vec<TimedMidiEvent> = self
            .notes
            .iter()
            .flat_map(|n| {
                [
                    TimedMidiEvent::new(at(n.start_us), vec![0x90 | n.ch, n.key, n.vel.max(1)]),
                    TimedMidiEvent::new(at(n.end_us).max(at(n.start_us) + 1), note_off_msg(n.ch, n.key)),
                ]
            })
            .collect();
        script.sort_by_key(|e| e.time_us);
        script
    }

    /// Stops the clock and scores what was played (pending notes count as missed). The ticker is
    /// not joined, so this can be called from `time_up`.
    pub fn stop(&self) -> RunOutcome {
        self.shared.stopped.store(true, Ordering::SeqCst);
        let duration_ms = self.shared.start.elapsed().as_millis() as u64;
        let matcher = std::mem::replace(&mut *lock(&self.shared.matcher), Matcher::new(&[], 100));
        let played = std::mem::take(&mut *lock(&self.shared.played));
        RunOutcome { result: matcher.finish(), played, duration_ms }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(key: u8, start_ms: u64) -> Note {
        Note { key, ch: 0, start_us: start_ms * 1000, end_us: start_ms * 1000 + 200_000, vel: 80 }
    }

    fn on(t_ms: i64, key: u8) -> TimedMidiEvent {
        TimedMidiEvent::new((t_ms * 1000) as u64, vec![0x90, key, 90])
    }

    /// C-D-E-F, one every 500 ms.
    fn scale() -> Vec<Note> {
        vec![note(60, 0), note(62, 500), note(64, 1000), note(65, 1500)]
    }

    #[test]
    fn extracts_and_trims_notes() {
        let evs = vec![
            TimedMidiEvent::new(2_000_000, vec![0x90, 60, 80]),
            TimedMidiEvent::new(2_000_000, vec![0x90, 64, 70]),
            TimedMidiEvent::new(2_400_000, vec![0x80, 60, 0]),
            TimedMidiEvent::new(2_500_000, vec![0x90, 60, 90]),
            TimedMidiEvent::new(2_600_000, vec![0x90, 64, 0]),
            TimedMidiEvent::new(2_700_000, vec![0xB0, 64, 127]),
            TimedMidiEvent::new(3_000_000, vec![0x80, 60, 0]),
        ];
        let notes = extract_notes(&evs);
        assert_eq!(
            notes,
            vec![
                Note { key: 60, ch: 0, start_us: 0, end_us: 400_000, vel: 80 },
                Note { key: 64, ch: 0, start_us: 0, end_us: 600_000, vel: 70 },
                Note { key: 60, ch: 0, start_us: 500_000, end_us: 1_000_000, vel: 90 },
            ]
        );
        assert!(extract_notes(&[]).is_empty());
    }

    #[test]
    fn unclosed_note_ends_at_last_event() {
        let evs = vec![TimedMidiEvent::new(1_000_000, vec![0x90, 60, 80]), TimedMidiEvent::new(1_800_000, vec![0xB0, 64, 0])];
        assert_eq!(extract_notes(&evs)[0].end_us, 800_000);
    }

    #[test]
    fn window_scales_with_tempo() {
        assert_eq!(window_us(100), 150_000);
        assert_eq!(window_us(150), 100_000);
        assert_eq!(window_us(50), 250_000);
        assert_eq!(window_us(75), 200_000);
        assert_eq!(window_us(10), 250_000); // clamped to 40 %
    }

    #[test]
    fn perfect_run() {
        let played: Vec<_> = [(0, 60), (500, 62), (1000, 64), (1500, 65)].iter().map(|&(t, k)| on(t, k)).collect();
        let r = score_attempt(&scale(), &played, 100, 0);
        assert_eq!((r.hits, r.perfect, r.misses, r.wrong, r.extra), (4, 4, 0, 0, 0));
        assert_eq!(r.score, 1000);
        assert_eq!(r.accuracy, 1.0);
        assert_eq!(r.mean_offset_ms, 0);
        assert!(r.details.notes.iter().all(|n| n.status == NoteStatus::Perfect));
    }

    #[test]
    fn misses_wrong_and_extra() {
        let played = vec![
            on(30, 60),   // hit, perfect (30 ms)
            on(600, 61),  // wrong: 62 was due at 500
            on(1080, 64), // hit, good (80 ms > 50 ms)
            on(3000, 70), // extra: nothing due
        ];
        let r = score_attempt(&scale(), &played, 100, 0);
        assert_eq!((r.hits, r.perfect, r.misses, r.wrong, r.extra), (2, 1, 2, 1, 1));
        assert_eq!(r.accuracy, 0.5);
        let statuses: Vec<_> = r.details.notes.iter().map(|n| n.status).collect();
        assert_eq!(statuses, vec![NoteStatus::Perfect, NoteStatus::Missed, NoteStatus::Good, NoteStatus::Missed]);
        assert_eq!(r.details.notes[2].offset_ms, Some(80));
        assert_eq!(r.details.errors[0], PlayedError { time_ms: 600, kind: PlayedErrorKind::Wrong, played_key: 61, expected_key: Some(62) });
        assert_eq!(r.details.errors[1].kind, PlayedErrorKind::Extra);
        // quality: 1 - 0.5·30/150 = 0.9 and 1 - 0.5·80/150 ≈ 0.733 → 1633 / (4 + 1) ≈ 327
        assert_eq!(r.score, 327);
        assert_eq!(r.mean_offset_ms, 55);
    }

    #[test]
    fn window_edge_is_inclusive() {
        let r = score_attempt(&[note(60, 1000)], &[on(1150, 60)], 100, 0);
        assert_eq!(r.hits, 1);
        let r = score_attempt(&[note(60, 1000)], &[on(1151, 60)], 100, 0);
        assert_eq!((r.hits, r.extra), (0, 1));
        let r = score_attempt(&[note(60, 1000)], &[on(850, 60)], 100, 0);
        assert_eq!(r.hits, 1);
    }

    #[test]
    fn chords_and_repeated_notes() {
        // C+E+G chord, then C twice.
        let notes = vec![note(60, 0), note(64, 0), note(67, 0), note(60, 400), note(60, 800)];
        let played = vec![on(10, 67), on(15, 60), on(20, 64), on(390, 60), on(830, 60), on(840, 60)];
        let r = score_attempt(&notes, &played, 100, 0);
        assert_eq!((r.hits, r.misses, r.extra), (5, 0, 1));
        // The repeated C is matched to the closest expected one, not to an earlier one.
        assert_eq!(r.details.notes[3].offset_ms, Some(-10));
        assert_eq!(r.details.notes[4].offset_ms, Some(30));
    }

    #[test]
    fn tempo_scaling_and_shift() {
        // At 50 % the notes are at 0, 1000, 2000, 3000 ms. The capture includes a 2 s count-in.
        let played: Vec<_> = [0, 1000, 2000, 3000].iter().zip([60, 62, 64, 65]).map(|(&t, k)| on(t + 2000, k)).collect();
        let r = score_attempt(&scale(), &played, 50, 2_000_000);
        assert_eq!((r.hits, r.perfect), (4, 4));
        // Same capture at 100 % misses everything but the first note's neighbourhood.
        let r = score_attempt(&scale(), &played, 100, 2_000_000);
        assert!(r.hits < 4);
    }

    #[test]
    fn latency_compensation_removes_bias() {
        // The user plays exactly on what they hear, which comes 40 ms late.
        let played: Vec<_> = [(40, 60), (540, 62), (1040, 64), (1540, 65)].iter().map(|&(t, k)| on(t, k)).collect();
        assert_eq!(score_attempt(&scale(), &played, 100, 0).mean_offset_ms, 40);
        assert_eq!(score_attempt(&scale(), &played, 100, 40_000).mean_offset_ms, 0);
    }

    #[test]
    fn early_note_before_first_one() {
        let r = score_attempt(&scale(), &[on(0, 60)], 100, 100_000);
        assert_eq!(r.details.notes[0].offset_ms, Some(-100));
    }

    #[test]
    fn live_matching_reports_misses_once() {
        let mut m = Matcher::new(&scale(), 100);
        assert_eq!(m.on_note_on(10_000, 60), Played::Hit { index: 0, offset_us: 10_000, perfect: true });
        assert!(m.advance(600_000).is_empty()); // 62's window closes at 650 ms (+ grace)
        assert_eq!(m.advance(800_000), vec![1]);
        assert!(m.advance(800_000).is_empty());
        // A missed note can no longer be hit.
        assert_eq!(m.on_note_on(640_000, 62), Played::Extra);
        assert_eq!((m.hits(), m.misses(), m.error_count()), (1, 1, 1));
        let r = m.finish();
        assert_eq!((r.hits, r.misses, r.extra), (1, 3, 1));
    }

    #[test]
    fn freezes_a_melody_without_leading_silence() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.mid");
        let dest = dir.path().join("melody.mid");
        let evs = vec![
            TimedMidiEvent::new(0, vec![0xB0, 64, 127]),
            TimedMidiEvent::new(100_000, vec![0x80, 50, 0]), // orphan note-off before the first note
            TimedMidiEvent::new(1_000_000, vec![0x90, 60, 80]),
            TimedMidiEvent::new(1_500_000, vec![0x80, 60, 0]),
            TimedMidiEvent::new(1_500_000, vec![0x90, 62, 80]),
            TimedMidiEvent::new(2_250_000, vec![0x80, 62, 0]),
        ];
        write_smf(&src, &evs, 90).unwrap();
        let frozen = freeze_melody(&src, &dest).unwrap();
        assert_eq!(frozen, FrozenMelody { bpm: 90, duration_ms: 1250, note_count: 2 });
        let (out, _) = read_timed_events(&dest).unwrap();
        assert_eq!(out.len(), 5);
        assert_eq!(out[0].bytes, vec![0xB0, 64, 127]);
        assert_eq!(out.iter().find(|e| as_note_on(&e.bytes).is_some()).unwrap().time_us, 0);
        let notes = load_notes(&dest).unwrap();
        assert_eq!(notes.len(), 2);
        assert!(notes[1].start_us.abs_diff(500_000) <= 1000);

        let empty = dir.path().join("empty.mid");
        write_smf(&empty, &[TimedMidiEvent::new(0, vec![0xB0, 64, 0])], 120).unwrap();
        assert!(freeze_melody(&empty, &dir.path().join("x.mid")).is_err());
    }

    #[test]
    fn effective_bpm_and_count_in() {
        assert_eq!(effective_bpm(90, 80), 72);
        assert_eq!(effective_bpm(100, 75), 75);
        assert_eq!(count_in_us(120), 2_000_000);
    }

    #[test]
    fn runner_scores_live_and_ends_on_its_own() {
        use std::sync::mpsc;
        let notes = vec![note(60, 0), note(62, 200)];
        let (tx, rx) = mpsc::channel::<&'static str>();
        let notes_seen: Arc<Mutex<Vec<ChallengeNoteEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let progress_seen: Arc<Mutex<Vec<ChallengeProgress>>> = Arc::new(Mutex::new(Vec::new()));
        let (n2, p2) = (Arc::clone(&notes_seen), Arc::clone(&progress_seen));
        let (go_tx, up_tx) = (tx.clone(), tx);
        let emitter = ChallengeEmitter {
            note: Arc::new(move |e| lock(&n2).push(e)),
            progress: Arc::new(move |p| lock(&p2).push(p)),
            go: Arc::new(move || go_tx.send("go").unwrap()),
            time_up: Arc::new(move || up_tx.send("up").unwrap()),
        };
        // 240 BPM → 1 s of count-in.
        let runner = ChallengeRunner::start(notes, 100, 240, 0, emitter);
        assert_eq!(runner.count_in_us(), 1_000_000);
        let script = runner.script();
        assert_eq!(script[0].time_us, 1_000_000);
        let sink = runner.sink();

        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "go");
        sink(&[0x90, 60, 80]); // right on time
        sink(&[0x80, 60, 0]);
        assert_eq!(rx.recv_timeout(Duration::from_secs(4)).unwrap(), "up");

        let out = runner.stop();
        assert_eq!((out.result.hits, out.result.misses), (1, 1));
        assert_eq!(out.played.len(), 2);
        assert!(out.duration_ms >= 2_800);
        let seen = lock(&notes_seen);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].expected_index, Some(0));
        assert!(matches!(seen[0].kind, ChallengeNoteKind::Perfect | ChallengeNoteKind::Good));
        let progress = lock(&progress_seen);
        assert!(progress.first().unwrap().elapsed_ms < -900);
        assert_eq!(progress.iter().flat_map(|p| p.missed.clone()).collect::<Vec<_>>(), vec![1]);
        // Once stopped, the sink ignores everything.
        sink(&[0x90, 62, 80]);
        assert!(runner.stop().played.is_empty());
    }

    #[test]
    fn empty_melody() {
        let r = score_attempt(&[], &[on(0, 60)], 100, 0);
        assert_eq!((r.score, r.accuracy, r.extra), (0, 0.0, 1));
        assert!(r.details.notes.is_empty());
    }
}
