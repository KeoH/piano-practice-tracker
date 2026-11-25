//! Scores written on a grand staff: validation, length and the MIDI they turn into.
//!
//! A score is notation (`ScoreDto`: ticks at 480 per quarter note, two staves of notes, rests are
//! the gaps); its `.mid` is derived output. A staff has one rhythm: notes never overlap, except a
//! chord (notes that start together, last the same and have different keys). A note never crosses a bar
//! line, but it can be tied to the note of the same key that starts where it ends, and the two sound as
//! one. The first bar can be a shorter pickup (anacrusis): it is the end of a bar, so beats keep their place.
//! A bar can end with a repeat sign (`repeat_bar`): after it the score goes back to the start and is played
//! through again, in the MIDI too. Slurs (`slurs`) are notation only. Saving a score regenerates a real fragment, so
//! the composer, the exports and the challenge mode treat it like any recorded fragment.
//!
//! The checks mirror `validateScore` in `src/app/core/score.ts`.

use std::path::Path;

use crate::midi_slicer::{write_smf_with_end, TimedMidiEvent};
use crate::models::{ScoreDto, ScoreNoteDto, ScoreSlurDto, ScoreSummaryDto};

pub const TICKS_PER_QUARTER: u32 = 480;
pub const TICKS_PER_WHOLE: u32 = TICKS_PER_QUARTER * 4;
/// Lowest and highest key of a piano (A0 and C8).
pub const MIN_KEY: u8 = 21;
pub const MAX_KEY: u8 = 108;
pub const MAX_BARS: u32 = 64;
pub const MIN_BPM: u32 = 30;
pub const MAX_BPM: u32 = 240;
pub const DEFAULT_BPM: u32 = 90;
pub const DEFAULT_BARS: u32 = 4;
/// Note values a score can hold: whole, dotted half, half, dotted quarter, quarter, dotted eighth,
/// eighth, dotted sixteenth and sixteenth.
const NOTATED_TICKS: [u32; 9] = [1920, 1440, 960, 720, 480, 360, 240, 180, 120];
const VELOCITY: u8 = 80;
const CHANNEL: u8 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Staff {
    Treble,
    Bass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueCode {
    Bpm,
    TimeSignature,
    Bars,
    Pickup,
    DuplicateId,
    Key,
    Accidental,
    Duration,
    Tick,
    CrossesBar,
    Overlap,
    Tie,
    Repeat,
    Slur,
}

impl IssueCode {
    /// Key of the translated message (`backend.scores.issue.*`).
    fn message_key(self) -> &'static str {
        match self {
            IssueCode::Bpm => "backend.scores.issue.bpm",
            IssueCode::TimeSignature => "backend.scores.issue.timeSignature",
            IssueCode::Bars => "backend.scores.issue.bars",
            IssueCode::Pickup => "backend.scores.issue.pickup",
            IssueCode::DuplicateId => "backend.scores.issue.duplicateId",
            IssueCode::Key => "backend.scores.issue.key",
            IssueCode::Accidental => "backend.scores.issue.accidental",
            IssueCode::Duration => "backend.scores.issue.duration",
            IssueCode::Tick => "backend.scores.issue.tick",
            IssueCode::CrossesBar => "backend.scores.issue.crossesBar",
            IssueCode::Overlap => "backend.scores.issue.overlap",
            IssueCode::Tie => "backend.scores.issue.tie",
            IssueCode::Repeat => "backend.scores.issue.repeat",
            IssueCode::Slur => "backend.scores.issue.slur",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: IssueCode,
    pub staff: Option<Staff>,
    pub note_id: Option<String>,
}

fn issue(code: IssueCode) -> Issue {
    Issue { code, staff: None, note_id: None }
}

/// Key of a score in the player (`PlaybackProgress::file_path`).
pub fn playback_key(score_id: &str) -> String {
    format!("score:{score_id}")
}

/// Key of a single note preview in the player.
pub fn note_key(key: u8) -> String {
    format!("note:{key}")
}

/// One piano key held for 600 ms (piano program first), and its length in µs.
pub fn note_events(key: u8) -> (Vec<TimedMidiEvent>, u64) {
    let events = vec![
        TimedMidiEvent::new(0, vec![0xC0 | CHANNEL, 0]),
        TimedMidiEvent::new(0, vec![0x90 | CHANNEL, key, VELOCITY]),
        TimedMidiEvent::new(600_000, vec![0x80 | CHANNEL, key, 0]),
    ];
    (events, 800_000)
}

pub fn bar_ticks(score: &ScoreDto) -> u32 {
    score.beats * TICKS_PER_WHOLE / score.beat_unit.max(1)
}

/// Ticks the first bar is short by: a pickup of `L` ticks is the last `L` of a bar, so it lacks `bar - L`.
pub fn missing_ticks(score: &ScoreDto) -> u32 {
    if score.pickup_ticks > 0 {
        bar_ticks(score).saturating_sub(score.pickup_ticks)
    } else {
        0
    }
}

/// Length of the whole score. With a pickup the first bar is short and so is the last one (it holds what
/// the pickup lacks), so they add up to one whole bar.
pub fn score_ticks(score: &ScoreDto) -> u32 {
    let bar = bar_ticks(score);
    if score.pickup_ticks > 0 {
        if score.bars >= 2 {
            (score.bars - 1) * bar
        } else {
            score.pickup_ticks
        }
    } else {
        score.bars * bar
    }
}

/// The fewest bars a score can have: a pickup needs its closing bar.
fn min_bars(score: &ScoreDto) -> u32 {
    if score.pickup_ticks > 0 {
        2
    } else {
        1
    }
}

/// Tick where the bar `index` ends (the last bar ends with the score).
pub fn bar_end(score: &ScoreDto, index: u32) -> u32 {
    let virtual_start = i64::from(index) * i64::from(bar_ticks(score)) - i64::from(missing_ticks(score));
    let end = virtual_start + i64::from(bar_ticks(score));
    u32::try_from(end.max(0)).unwrap_or(u32::MAX).min(score_ticks(score))
}

/// Tick where the repeat sign is: the end of its bar. `None` if there is none (or it is not on a bar of the score).
pub fn repeat_tick(score: &ScoreDto) -> Option<u32> {
    score.repeat_bar.filter(|b| *b < score.bars).map(|b| bar_end(score, b))
}

/// Length of what is played: the score once, plus the part up to the repeat sign when there is one.
pub fn play_ticks(score: &ScoreDto) -> u32 {
    score_ticks(score) + repeat_tick(score).unwrap_or(0)
}

/// Index of the bar a tick is in.
fn bar_of(score: &ScoreDto, tick: u32) -> u32 {
    (tick + missing_ticks(score)) / bar_ticks(score).max(1)
}

/// The note a tied note is tied to: same key, starting where it ends.
fn tie_target(notes: &[&ScoreNoteDto], i: usize) -> Option<usize> {
    let n = notes[i];
    let end = n.tick.saturating_add(n.duration_ticks);
    notes.iter().position(|m| !std::ptr::eq(*m, n) && m.key == n.key && m.tick == end)
}

/// Microseconds from the start of the score at `bpm`.
pub fn ticks_to_us(ticks: u32, bpm: u32) -> u64 {
    // 60_000_000 µs per minute / 480 ticks per quarter = 125_000.
    u64::from(ticks) * 125_000 / u64::from(bpm.max(1))
}

/// Length of what is played (its bars, trailing rests and the repeat included), in milliseconds.
pub fn duration_ms(score: &ScoreDto) -> u64 {
    (ticks_to_us(play_ticks(score), score.bpm) + 500) / 1000
}

pub fn note_count(score: &ScoreDto) -> u32 {
    u32::try_from(score.treble.len() + score.bass.len()).unwrap_or(u32::MAX)
}

pub fn summary(score: &ScoreDto) -> ScoreSummaryDto {
    ScoreSummaryDto {
        id: score.id.clone(),
        title: score.title.clone(),
        bpm: score.bpm,
        beats: score.beats,
        beat_unit: score.beat_unit,
        bars: score.bars,
        note_count: note_count(score),
        duration_ms: duration_ms(score),
        fragment_id: score.fragment_id.clone(),
        piece_id: None,
        updated_at: score.updated_at.clone(),
    }
}

/// A new score: four empty 4/4 bars at the default tempo.
pub fn new_score(id: String, title: String, now: String) -> ScoreDto {
    ScoreDto {
        id,
        title,
        bpm: DEFAULT_BPM,
        beats: 4,
        beat_unit: 4,
        bars: DEFAULT_BARS,
        pickup_ticks: 0,
        repeat_bar: None,
        treble: Vec::new(),
        bass: Vec::new(),
        slurs: Vec::new(),
        fragment_id: None,
        created_at: now.clone(),
        updated_at: now,
    }
}

fn is_black(key: u8) -> bool {
    matches!(key % 12, 1 | 3 | 6 | 8 | 10)
}

fn is_time_signature(beats: u32, beat_unit: u32) -> bool {
    (1..=12).contains(&beats) && matches!(beat_unit, 2 | 4 | 8)
}

/// Whether `accidental` is what a note of `key` must carry: a black key is spelled sharp or flat,
/// a white one has none.
fn accidental_ok(key: u8, accidental: Option<&str>) -> bool {
    if is_black(key) {
        matches!(accidental, Some("sharp" | "flat"))
    } else {
        accidental.is_none()
    }
}

/// Whether `ticks` is a valid pickup: none, or a bar shorter than a whole one, in sixteenths.
fn is_pickup(score: &ScoreDto) -> bool {
    let t = score.pickup_ticks;
    t == 0 || (t < bar_ticks(score) && t % 120 == 0)
}

/// Slurs that do not join two notes of one staff, the first before the second (or that share an id).
fn slur_issues(score: &ScoreDto, out: &mut Vec<Issue>) {
    let mut ids = std::collections::HashSet::new();
    for slur in &score.slurs {
        let start_of = |id: &str| {
            [&score.treble, &score.bass]
                .iter()
                .enumerate()
                .find_map(|(staff, notes)| notes.iter().find(|n| n.id == id).map(|n| (staff, n.tick)))
        };
        let ok = match (start_of(&slur.from), start_of(&slur.to)) {
            (Some((a, from)), Some((b, to))) => a == b && from < to,
            _ => false,
        };
        let repeated = !ids.insert(slur.id.as_str());
        if !ok || repeated {
            out.push(issue(IssueCode::Slur));
        }
    }
}

/// Reads a score stored as JSON (a melody's frozen copy). Copies made when the repeat sign could only close
/// the score say `"repeat": true`: the sign is then on the last bar.
pub fn from_stored_json(json: &str) -> Result<ScoreDto, String> {
    let mut value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if let Some(obj) = value.as_object_mut() {
        let legacy = obj.remove("repeat").and_then(|v| v.as_bool()).unwrap_or(false);
        if legacy && obj.get("repeat_bar").map_or(true, |v| v.is_null()) {
            let bars = obj.get("bars").and_then(|v| v.as_u64()).unwrap_or(1);
            obj.insert("repeat_bar".into(), serde_json::json!(bars.saturating_sub(1)));
        }
    }
    serde_json::from_value(value).map_err(|e| e.to_string())
}

/// Everything wrong with a score (empty when it can be saved).
pub fn issues(score: &ScoreDto) -> Vec<Issue> {
    let mut out = Vec::new();
    if !(MIN_BPM..=MAX_BPM).contains(&score.bpm) {
        out.push(issue(IssueCode::Bpm));
    }
    if !is_time_signature(score.beats, score.beat_unit) {
        out.push(issue(IssueCode::TimeSignature));
        return out;
    }
    if !(min_bars(score)..=MAX_BARS).contains(&score.bars) {
        out.push(issue(IssueCode::Bars));
    }
    if !is_pickup(score) {
        out.push(issue(IssueCode::Pickup));
        return out;
    }
    let total = score_ticks(score);
    let mut ids = std::collections::HashSet::new();
    for (staff, notes) in [(Staff::Treble, &score.treble), (Staff::Bass, &score.bass)] {
        let mut sorted: Vec<&ScoreNoteDto> = notes.iter().collect();
        sorted.sort_by_key(|n| (n.tick, n.key));
        let mut prev_end = 0u32;
        // The notes that started the current rhythm: a note that overlaps it must be a chord mate.
        let mut group: (u32, u32, Vec<u8>) = (u32::MAX, 0, Vec::new());
        for (i, n) in sorted.iter().enumerate() {
            let at = |code| Issue { code, staff: Some(staff), note_id: Some(n.id.clone()) };
            if !ids.insert(n.id.clone()) {
                out.push(at(IssueCode::DuplicateId));
            }
            if !(MIN_KEY..=MAX_KEY).contains(&n.key) {
                out.push(at(IssueCode::Key));
            } else if !accidental_ok(n.key, n.accidental.as_deref()) {
                out.push(at(IssueCode::Accidental));
            }
            if !NOTATED_TICKS.contains(&n.duration_ticks) {
                out.push(at(IssueCode::Duration));
            }
            if n.tie && tie_target(&sorted, i).is_none() {
                out.push(at(IssueCode::Tie));
            }
            let end = n.tick.saturating_add(n.duration_ticks);
            if n.duration_ticks == 0 || end > total {
                out.push(at(IssueCode::Tick));
                continue;
            }
            if bar_of(score, n.tick) != bar_of(score, end - 1) {
                out.push(at(IssueCode::CrossesBar));
            }
            if n.tick >= prev_end {
                group = (n.tick, end, vec![n.key]);
            } else if n.tick == group.0 && end == group.1 && !group.2.contains(&n.key) {
                group.2.push(n.key); // a chord mate
            } else {
                out.push(at(IssueCode::Overlap));
            }
            prev_end = prev_end.max(end);
        }
    }
    if score.repeat_bar.is_some_and(|b| b >= score.bars) {
        out.push(issue(IssueCode::Repeat));
    }
    slur_issues(score, &mut out);
    out
}

/// `Ok` if the score can be saved; otherwise the translated message of the first problem.
pub fn check(score: &ScoreDto) -> Result<(), String> {
    match issues(score).first() {
        None => Ok(()),
        Some(first) => Err(crate::i18n::tr(first.code.message_key(), &[])),
    }
}

/// Note-offs before everything else at the same instant, so a repeated key is struck again.
fn priority(bytes: &[u8]) -> u8 {
    if bytes[0] & 0xF0 == 0x80 {
        0
    } else {
        1
    }
}

/// The MIDI events of both hands on one channel, sorted by time (note-offs first), and the length of
/// what is played in µs. Notes sound for their whole value and a chain of tied notes sounds as one note.
/// With a repeat sign the performance is the notes that start before it (cut at the sign) followed by the
/// whole score again, so a bar after the sign is played once and the ones before it twice.
pub fn build_events(score: &ScoreDto) -> (Vec<TimedMidiEvent>, u64) {
    // Every sounding note as (start, end, key) in ticks.
    let mut sounding: Vec<(u32, u32, u8)> = Vec::with_capacity(score.treble.len() + score.bass.len());
    for notes in [&score.treble, &score.bass] {
        let refs: Vec<&ScoreNoteDto> = notes.iter().collect();
        let mut continued = vec![false; refs.len()];
        for i in 0..refs.len() {
            if refs[i].tie {
                if let Some(j) = tie_target(&refs, i) {
                    continued[j] = true;
                }
            }
        }
        for (i, n) in refs.iter().enumerate() {
            if continued[i] {
                continue; // it is the tail of an earlier note
            }
            let mut end = n.tick + n.duration_ticks;
            let mut cur = i;
            while refs[cur].tie {
                let Some(next) = tie_target(&refs, cur) else { break };
                end = refs[next].tick + refs[next].duration_ticks;
                cur = next;
            }
            sounding.push((n.tick, end, n.key));
        }
    }
    let mut events: Vec<TimedMidiEvent> = Vec::with_capacity(sounding.len() * 4);
    let mut push = |start: u32, end: u32, key: u8| {
        events.push(TimedMidiEvent::new(ticks_to_us(start, score.bpm), vec![0x90 | CHANNEL, key, VELOCITY]));
        events.push(TimedMidiEvent::new(ticks_to_us(end, score.bpm), vec![0x80 | CHANNEL, key, 0]));
    };
    let repeat_at = repeat_tick(score);
    for &(start, end, key) in &sounding {
        match repeat_at {
            Some(r) => {
                if start < r {
                    push(start, end.min(r), key);
                }
                push(start + r, end + r, key);
            }
            None => push(start, end, key),
        }
    }
    events.sort_by_key(|e| (e.time_us, priority(&e.bytes)));
    (events, ticks_to_us(play_ticks(score), score.bpm))
}

/// Writes the score as a standard MIDI file whose length is the whole score (atomic write).
pub fn write_midi(score: &ScoreDto, path: &Path) -> Result<u64, String> {
    let (events, length_us) = build_events(score);
    write_smf_with_end(path, &events, score.bpm, Some(length_us))?;
    Ok(duration_ms(score))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi_slicer::read_timed_events;

    const Q: u32 = 480;

    fn note(id: &str, tick: u32, duration: u32, key: u8) -> ScoreNoteDto {
        ScoreNoteDto { id: id.into(), tick, duration_ticks: duration, key, accidental: None, tie: false }
    }

    fn tied(mut n: ScoreNoteDto) -> ScoreNoteDto {
        n.tie = true;
        n
    }

    fn score(treble: Vec<ScoreNoteDto>, bass: Vec<ScoreNoteDto>) -> ScoreDto {
        ScoreDto {
            bpm: 120,
            bars: 2,
            treble,
            bass,
            ..new_score("s".into(), "S".into(), "2026-01-01T00:00:00Z".into())
        }
    }

    fn codes(s: &ScoreDto) -> Vec<IssueCode> {
        issues(s).into_iter().map(|i| i.code).collect()
    }

    #[test]
    fn bar_and_score_length_follow_the_time_signature() {
        let mut s = score(vec![], vec![]);
        assert_eq!(bar_ticks(&s), 4 * Q);
        assert_eq!(score_ticks(&s), 8 * Q);
        s.beats = 3;
        assert_eq!(bar_ticks(&s), 3 * Q);
        s.beats = 6;
        s.beat_unit = 8;
        assert_eq!(bar_ticks(&s), 6 * 240);
    }

    #[test]
    fn converts_ticks_to_time_at_a_tempo() {
        assert_eq!(ticks_to_us(Q, 120), 500_000);
        assert_eq!(ticks_to_us(4 * Q, 60), 4_000_000);
        // Two 4/4 bars at 120 BPM last four seconds.
        assert_eq!(duration_ms(&score(vec![], vec![])), 4_000);
    }

    #[test]
    fn a_good_score_has_no_issues() {
        let mut flat = note("b", Q, Q, 61);
        flat.accidental = Some("flat".into());
        assert!(issues(&score(vec![note("a", 0, Q, 60), flat], vec![note("c", 0, 4 * Q, 36)])).is_empty());
        assert!(check(&score(vec![], vec![])).is_ok());
    }

    #[test]
    fn reports_each_kind_of_problem_like_the_frontend() {
        let with = |f: &dyn Fn(&mut ScoreDto)| {
            let mut s = score(vec![note("a", 0, Q, 60)], vec![]);
            f(&mut s);
            codes(&s)
        };
        assert!(with(&|s| s.bpm = 10).contains(&IssueCode::Bpm));
        assert!(with(&|s| s.beat_unit = 3).contains(&IssueCode::TimeSignature));
        assert!(with(&|s| s.bars = 0).contains(&IssueCode::Bars));
        assert!(with(&|s| s.treble.push(note("a", Q, Q, 60))).contains(&IssueCode::DuplicateId));
        assert!(with(&|s| s.treble[0].key = 5).contains(&IssueCode::Key));
        assert!(with(&|s| s.treble[0].key = 61).contains(&IssueCode::Accidental)); // black key without spelling
        assert!(with(&|s| s.treble[0].accidental = Some("sharp".into())).contains(&IssueCode::Accidental)); // white key
        assert!(with(&|s| s.treble[0].duration_ticks = 300).contains(&IssueCode::Duration));
        assert!(with(&|s| s.treble[0].tick = 99 * 1920).contains(&IssueCode::Tick));
        assert!(with(&|s| s.treble[0].duration_ticks = 0).contains(&IssueCode::Tick));
        assert!(with(&|s| s.treble[0] = note("a", 3 * Q, 2 * Q, 60)).contains(&IssueCode::CrossesBar));
        assert!(with(&|s| s.treble.push(note("b", 0, 2 * Q, 62))).contains(&IssueCode::Overlap));
    }

    #[test]
    fn names_the_staff_and_the_note() {
        let s = score(vec![], vec![note("x", 0, 2 * Q, 36), note("y", Q, Q, 36)]);
        assert_eq!(
            issues(&s),
            vec![Issue { code: IssueCode::Overlap, staff: Some(Staff::Bass), note_id: Some("y".into()) }]
        );
    }

    #[test]
    fn each_hand_can_play_on_the_same_tick() {
        assert!(issues(&score(vec![note("a", 0, Q, 60)], vec![note("b", 0, Q, 36)])).is_empty());
    }

    #[test]
    fn check_translates_the_first_problem() {
        let mut s = score(vec![], vec![]);
        s.bars = 0;
        let msg = check(&s).unwrap_err();
        assert!(!msg.starts_with("backend."), "untranslated: {msg}");
    }

    #[test]
    fn builds_the_events_of_a_two_bar_score() {
        // Bar 1: C4 quarter, E4 quarter, G4 half in the right hand; a whole C2 in the left.
        let s = score(
            vec![note("a", 0, Q, 60), note("b", Q, Q, 64), note("c", 2 * Q, 2 * Q, 67)],
            vec![note("d", 0, 4 * Q, 36)],
        );
        let (events, length_us) = build_events(&s);
        assert_eq!(length_us, 4_000_000);
        let on: Vec<(u64, u8)> = events.iter().filter(|e| e.bytes[0] == 0x90).map(|e| (e.time_us, e.bytes[1])).collect();
        assert_eq!(on, vec![(0, 60), (0, 36), (500_000, 64), (1_000_000, 67)]);
        let off: Vec<(u64, u8)> = events.iter().filter(|e| e.bytes[0] == 0x80).map(|e| (e.time_us, e.bytes[1])).collect();
        assert_eq!(off, vec![(500_000, 60), (1_000_000, 64), (2_000_000, 67), (2_000_000, 36)]);
        assert!(events.windows(2).all(|w| w[0].time_us <= w[1].time_us));
    }

    #[test]
    fn a_repeated_key_is_struck_again_at_the_seam() {
        let (events, _) = build_events(&score(vec![note("a", 0, Q, 60), note("b", Q, Q, 60)], vec![]));
        let at_seam: Vec<u8> = events.iter().filter(|e| e.time_us == 500_000).map(|e| e.bytes[0]).collect();
        assert_eq!(at_seam, vec![0x80, 0x90], "the note-off comes first");
    }

    #[test]
    fn rests_are_gaps() {
        let (events, _) = build_events(&score(vec![note("a", 2 * Q, Q, 60)], vec![]));
        assert_eq!(events[0].time_us, 1_000_000);
    }

    #[test]
    fn writes_a_file_that_reads_back_with_the_length_of_the_whole_score() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("score.mid");
        let s = score(vec![note("a", 0, Q, 60), note("b", 4 * Q, 2 * Q, 64)], vec![note("c", 0, 4 * Q, 36)]);
        let ms = write_midi(&s, &path).unwrap();
        assert_eq!(ms, 4_000);
        let (events, total_ms) = read_timed_events(&path).unwrap();
        assert_eq!(total_ms, 4_000);
        let on = events.iter().filter(|e| e.bytes[0] == 0x90).count();
        assert_eq!(on, 3);
        assert!(events.iter().all(|e| e.bytes[0] & 0x0F == 0));
    }

    #[test]
    fn a_chord_is_notes_that_start_together_and_last_the_same() {
        let chord = vec![note("a", 0, Q, 60), note("b", 0, Q, 64), note("c", 0, Q, 67)];
        assert!(issues(&score(chord, vec![])).is_empty());
        // Another key, same start but another value: that is two rhythms in one hand.
        let c = score(vec![note("a", 0, Q, 60), note("b", 0, 2 * Q, 64)], vec![]);
        assert_eq!(codes(&c), vec![IssueCode::Overlap]);
        // The same key twice is not a chord.
        assert_eq!(codes(&score(vec![note("a", 0, Q, 60), note("b", 0, Q, 60)], vec![])), vec![IssueCode::Overlap]);
        // A note that starts in the middle of the chord's span is in the way.
        assert_eq!(codes(&score(vec![note("a", 0, 2 * Q, 60), note("b", 0, 2 * Q, 64), note("c", Q, Q, 67)], vec![])), vec![IssueCode::Overlap]);
    }

    #[test]
    fn a_chord_sounds_all_its_notes_at_once() {
        let (events, _) = build_events(&score(vec![note("a", 0, Q, 60), note("b", 0, Q, 64), note("c", 0, Q, 67)], vec![]));
        let on: Vec<(u64, u8)> = events.iter().filter(|e| e.bytes[0] == 0x90).map(|e| (e.time_us, e.bytes[1])).collect();
        assert_eq!(on, vec![(0, 60), (0, 64), (0, 67)]);
    }

    #[test]
    fn a_tie_needs_the_note_it_joins() {
        let ok = score(vec![tied(note("a", 3 * Q, Q, 60)), note("b", 4 * Q, Q, 60)], vec![]); // over the bar line
        assert!(issues(&ok).is_empty());
        assert_eq!(codes(&score(vec![tied(note("a", 0, Q, 60))], vec![])), vec![IssueCode::Tie]); // nothing follows
        assert_eq!(codes(&score(vec![tied(note("a", 0, Q, 60)), note("b", Q, Q, 62)], vec![])), vec![IssueCode::Tie]); // other key
        assert_eq!(codes(&score(vec![tied(note("a", 0, Q, 60)), note("b", 2 * Q, Q, 60)], vec![])), vec![IssueCode::Tie]); // not contiguous
    }

    #[test]
    fn tied_notes_sound_as_one() {
        // C4 quarter on beat 4 tied over the bar line to a half note: one note of 3 beats.
        let (events, _) = build_events(&score(vec![tied(note("a", 3 * Q, Q, 60)), note("b", 4 * Q, 2 * Q, 60)], vec![]));
        let on: Vec<(u64, u8)> = events.iter().filter(|e| e.bytes[0] == 0x90).map(|e| (e.time_us, e.bytes[1])).collect();
        let off: Vec<(u64, u8)> = events.iter().filter(|e| e.bytes[0] == 0x80).map(|e| (e.time_us, e.bytes[1])).collect();
        assert_eq!(on, vec![(1_500_000, 60)]);
        assert_eq!(off, vec![(3_000_000, 60)]);
    }

    #[test]
    fn a_chain_of_ties_and_a_tied_chord_each_sound_once_per_key() {
        let chain = score(vec![tied(note("a", 0, Q, 60)), tied(note("b", Q, Q, 60)), note("c", 2 * Q, Q, 60)], vec![]);
        let (events, _) = build_events(&chain);
        assert_eq!(events.iter().filter(|e| e.bytes[0] == 0x90).count(), 1);
        assert_eq!(events.iter().find(|e| e.bytes[0] == 0x80).unwrap().time_us, 1_500_000);
        let chord = score(
            vec![tied(note("a", 0, Q, 60)), tied(note("b", 0, Q, 64)), note("c", Q, Q, 60), note("d", Q, Q, 64)],
            vec![],
        );
        let (events, _) = build_events(&chord);
        assert_eq!(events.iter().filter(|e| e.bytes[0] == 0x90).count(), 2);
        assert!(events.iter().filter(|e| e.bytes[0] == 0x80).all(|e| e.time_us == 1_000_000));
    }

    #[test]
    fn a_pickup_bar_is_the_end_of_a_bar() {
        // 4/4 with a one-beat pickup: bar 0 is [0, 480), a whole bar follows and the score ends with the
        // 3 beats the pickup lacks, so the first and the last bar make one whole bar.
        let mut s = score(vec![], vec![]);
        s.bars = 3;
        s.pickup_ticks = Q;
        assert_eq!(missing_ticks(&s), 3 * Q);
        assert_eq!(score_ticks(&s), Q + 4 * Q + 3 * Q);
        assert_eq!(bar_of(&s, Q - 1), 0);
        assert_eq!(bar_of(&s, Q), 1);
        assert_eq!(bar_of(&s, 5 * Q), 2);
        assert_eq!(bar_of(&s, 8 * Q - 1), 2);
        assert_eq!(duration_ms(&s), 4_000); // 8 beats at 120 BPM
        // Without a pickup there is no closing bar.
        s.pickup_ticks = 0;
        assert_eq!(score_ticks(&s), 12 * Q);
    }

    #[test]
    fn notes_fit_inside_the_bars_of_a_pickup_score() {
        let mut s = score(vec![note("a", 0, Q, 60), note("b", Q, 4 * Q, 62), note("c", 5 * Q, 3 * Q, 60)], vec![]);
        s.bars = 3;
        s.pickup_ticks = Q;
        assert!(issues(&s).is_empty());
        // A half note from the pickup crosses its bar line.
        s.treble = vec![note("a", 0, 2 * Q, 60)];
        assert_eq!(codes(&s), vec![IssueCode::CrossesBar]);
        // Nothing may go past the end of the closing bar, which is only 3 beats long.
        s.treble = vec![note("a", 5 * Q, 4 * Q, 60)];
        assert_eq!(codes(&s), vec![IssueCode::Tick]);
    }

    #[test]
    fn a_pickup_needs_its_closing_bar() {
        let mut s = score(vec![], vec![]);
        s.pickup_ticks = Q;
        s.bars = 1;
        assert_eq!(codes(&s), vec![IssueCode::Bars]);
        s.bars = 2;
        assert!(issues(&s).is_empty());
        assert_eq!(score_ticks(&s), 4 * Q); // the pickup and the closing bar are one whole bar
    }

    #[test]
    fn a_pickup_must_be_a_shorter_bar_in_sixteenths() {
        let mut s = score(vec![], vec![]);
        for bad in [4 * Q, 5 * Q, 100] {
            s.pickup_ticks = bad;
            assert_eq!(codes(&s), vec![IssueCode::Pickup], "{bad}");
        }
        for good in [0, 120, Q, 3 * Q] {
            s.pickup_ticks = good;
            assert!(issues(&s).is_empty(), "{good}");
        }
    }

    #[test]
    fn a_repeat_plays_the_score_twice_from_the_start() {
        let mut s = score(vec![note("a", 0, Q, 60), note("b", Q, 2 * Q, 64)], vec![note("c", 0, 4 * Q, 36), note("d", 4 * Q, 4 * Q, 36)]);
        s.repeat_bar = Some(1); // the last bar
        assert_eq!(play_ticks(&s), 2 * score_ticks(&s));
        assert_eq!(duration_ms(&s), 8_000); // two bars of 4/4 at 120 BPM, twice
        let (events, length_us) = build_events(&s);
        assert_eq!(length_us, 8_000_000);
        let on: Vec<(u64, u8)> = events.iter().filter(|e| e.bytes[0] == 0x90).map(|e| (e.time_us, e.bytes[1])).collect();
        assert_eq!(on, vec![(0, 60), (0, 36), (500_000, 64), (2_000_000, 36), (4_000_000, 60), (4_000_000, 36), (4_500_000, 64), (6_000_000, 36)]);
        assert!(events.windows(2).all(|w| w[0].time_us <= w[1].time_us));
        // The last bass note ends exactly where the repeat starts, and the first one is struck again.
        let at_seam: Vec<u8> = events.iter().filter(|e| e.time_us == 4_000_000 && e.bytes[1] == 36).map(|e| e.bytes[0]).collect();
        assert_eq!(at_seam, vec![0x80, 0x90]);
    }

    #[test]
    fn a_repeat_does_not_change_the_score_itself() {
        let mut s = score(vec![note("a", 0, Q, 60)], vec![]);
        let once = build_events(&s);
        s.repeat_bar = Some(1);
        assert_eq!(score_ticks(&s), 8 * Q);
        assert!(issues(&s).is_empty());
        assert_eq!(build_events(&s).0.len(), once.0.len() * 2);
    }

    #[test]
    fn a_repeated_score_is_written_with_the_length_of_both_passes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("score.mid");
        let mut s = score(vec![note("a", 0, Q, 60)], vec![]);
        s.repeat_bar = Some(1);
        assert_eq!(write_midi(&s, &path).unwrap(), 8_000);
        let (events, ms) = read_timed_events(&path).unwrap();
        assert_eq!(ms, 8_000);
        assert_eq!(events.iter().filter(|e| e.bytes[0] == 0x90).count(), 2);
    }


    fn on_times(events: &[TimedMidiEvent]) -> Vec<(u64, u8)> {
        events.iter().filter(|e| e.bytes[0] == 0x90).map(|e| (e.time_us, e.bytes[1])).collect()
    }

    #[test]
    fn a_repeat_after_a_middle_bar_plays_the_bars_before_it_twice() {
        // Three 4/4 bars at 120 BPM (2 s each), one note per bar; the sign closes bar 2 (index 1).
        let mut s = score(vec![note("a", 0, Q, 60), note("b", 4 * Q, Q, 62), note("c", 8 * Q, Q, 64)], vec![]);
        s.bars = 3;
        s.repeat_bar = Some(1);
        assert!(issues(&s).is_empty());
        assert_eq!(repeat_tick(&s), Some(8 * Q));
        assert_eq!(play_ticks(&s), 8 * Q + 12 * Q);
        let (events, length_us) = build_events(&s);
        assert_eq!(length_us, 10_000_000);
        // Bars 1-2, then everything again: bar 3 sounds once, at the end.
        assert_eq!(on_times(&events), vec![(0, 60), (2_000_000, 62), (4_000_000, 60), (6_000_000, 62), (8_000_000, 64)]);
        assert_eq!(duration_ms(&s), 10_000);
    }

    #[test]
    fn a_repeat_on_the_first_bar_repeats_only_that_bar() {
        let mut s = score(vec![note("a", 0, Q, 60), note("b", 4 * Q, Q, 62)], vec![]);
        s.repeat_bar = Some(0);
        assert_eq!(on_times(&build_events(&s).0), vec![(0, 60), (2_000_000, 60), (4_000_000, 62)]);
    }

    #[test]
    fn a_tie_over_the_repeat_sign_is_cut_there_and_whole_the_second_time() {
        // C4 on the last beat of bar 1 tied to the first beat of bar 2; the sign closes bar 1.
        let mut s = score(vec![tied(note("a", 3 * Q, Q, 60)), note("b", 4 * Q, Q, 60)], vec![]);
        s.repeat_bar = Some(0);
        assert!(issues(&s).is_empty());
        let (events, _) = build_events(&s);
        let off: Vec<(u64, u8)> = events.iter().filter(|e| e.bytes[0] == 0x80).map(|e| (e.time_us, e.bytes[1])).collect();
        assert_eq!(on_times(&events), vec![(1_500_000, 60), (3_500_000, 60)]);
        assert_eq!(off, vec![(2_000_000, 60), (4_500_000, 60)]);
    }

    #[test]
    fn the_repeat_goes_at_the_end_of_a_bar_of_the_score() {
        let mut s = score(vec![], vec![]);
        s.repeat_bar = Some(2); // two bars
        assert_eq!(codes(&s), vec![IssueCode::Repeat]);
        assert_eq!(repeat_tick(&s), None);
        s.repeat_bar = Some(1);
        assert!(issues(&s).is_empty());
    }

    #[test]
    fn with_a_pickup_the_first_bar_is_short_and_the_last_ends_with_the_score() {
        let mut s = score(vec![], vec![]);
        s.pickup_ticks = Q;
        s.bars = 3; // pickup, one whole bar, closing bar
        assert_eq!(score_ticks(&s), 8 * Q);
        assert_eq!((bar_end(&s, 0), bar_end(&s, 1), bar_end(&s, 2)), (Q, 5 * Q, 8 * Q));
        s.repeat_bar = Some(0);
        assert_eq!(play_ticks(&s), 9 * Q);
    }

    fn slur(id: &str, from: &str, to: &str) -> ScoreSlurDto {
        ScoreSlurDto { id: id.into(), from: from.into(), to: to.into() }
    }

    #[test]
    fn a_slur_joins_two_notes_of_one_staff_the_first_before_the_second() {
        let mut s = score(vec![note("a", 0, Q, 60), note("b", Q, Q, 62)], vec![note("c", 0, Q, 40)]);
        s.slurs = vec![slur("s1", "a", "b")];
        assert!(issues(&s).is_empty());
        for bad in [slur("s1", "b", "a"), slur("s1", "a", "a"), slur("s1", "a", "c"), slur("s1", "a", "nope")] {
            s.slurs = vec![bad.clone()];
            assert_eq!(codes(&s), vec![IssueCode::Slur], "{bad:?}");
        }
        s.slurs = vec![slur("s1", "a", "b"), slur("s1", "a", "b")];
        assert_eq!(codes(&s), vec![IssueCode::Slur]); // the same id twice
        // An invalid slur still takes its id: a valid one with the same id is a second problem, as in the frontend.
        s.slurs = vec![slur("s1", "b", "a"), slur("s1", "a", "b")];
        assert_eq!(codes(&s), vec![IssueCode::Slur, IssueCode::Slur]);
    }

    #[test]
    fn slurs_do_not_change_what_is_played() {
        let mut s = score(vec![note("a", 0, Q, 60), note("b", Q, Q, 62)], vec![]);
        let plain = build_events(&s);
        s.slurs = vec![slur("s1", "a", "b")];
        assert_eq!(build_events(&s), plain);
    }

    #[test]
    fn a_stored_copy_from_before_the_repeat_could_move_puts_it_on_the_last_bar() {
        let mut s = score(vec![note("a", 0, Q, 60)], vec![]);
        s.repeat_bar = Some(1);
        let mut value = serde_json::to_value(&s).unwrap();
        let mut edit = |f: &dyn Fn(&mut serde_json::Map<String, serde_json::Value>)| {
            f(value.as_object_mut().unwrap());
            from_stored_json(&value.to_string()).unwrap()
        };
        let read = edit(&|o| {
            o.remove("repeat_bar");
            o.remove("slurs");
            o.insert("repeat".into(), serde_json::json!(true));
        });
        assert_eq!((read.repeat_bar, read.slurs.len()), (Some(1), 0));
        assert_eq!(edit(&|o| drop(o.insert("repeat".into(), serde_json::json!(false)))).repeat_bar, None);
        // A copy that already has the new field keeps it.
        assert_eq!(edit(&|o| drop(o.insert("repeat_bar".into(), serde_json::json!(0)))).repeat_bar, Some(0));
    }
    #[test]
    fn summarizes_a_score() {
        let s = score(vec![note("a", 0, Q, 60)], vec![note("b", 0, Q, 36)]);
        let sum = summary(&s);
        assert_eq!((sum.note_count, sum.duration_ms, sum.bars), (2, 4_000, 2));
    }
}
