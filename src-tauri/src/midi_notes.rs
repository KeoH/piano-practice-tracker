//! Notes of a `.mid` file as intervals: the piano roll and the automatic cut suggestions.
//!
//! Works on the events read by `midi_slicer` (absolute time, tempo map applied).

use std::collections::HashMap;
use std::path::Path;

use crate::midi_slicer::{as_note_off, as_note_on, as_sustain, read_timed_events, TimedMidiEvent};
use crate::models::{MidiNotesDto, NoteSpan, TimeRangeDto};

/// Keys shown when the file has no notes (an 88-key piano).
const EMPTY_MIN_KEY: u8 = 21;
const EMPTY_MAX_KEY: u8 = 108;
/// Silence kept on each side of a suggested segment, so the cut lands in silence.
const SEGMENT_PAD_MS: u64 = 500;

fn ms(us: u64) -> u64 {
    (us + 500) / 1000
}

/// Pairs NoteOn/NoteOff per (channel, key) and collects the sustain pedal intervals.
/// A NoteOn on a key that is already sounding closes the previous note; notes and pedal still
/// open at the end are closed at `duration_ms`.
fn spans(events: &[TimedMidiEvent], duration_ms: u64) -> (Vec<NoteSpan>, Vec<TimeRangeDto>) {
    let mut notes = Vec::new();
    let mut open: HashMap<(u8, u8), (u64, u8)> = HashMap::new();
    let mut pedal = Vec::new();
    // Channels with the pedal down; the interval is open while any channel holds it.
    let mut pedal_down: HashMap<u8, bool> = HashMap::new();
    let mut pedal_start: Option<u64> = None;

    for ev in events {
        let t = ms(ev.time_us);
        if let Some((ch, key, vel)) = as_note_on(&ev.bytes) {
            if let Some((start, velocity)) = open.insert((ch, key), (t, vel)) {
                notes.push(NoteSpan { start_ms: start, end_ms: t.max(start), key, velocity });
            }
        } else if let Some((ch, key)) = as_note_off(&ev.bytes) {
            if let Some((start, velocity)) = open.remove(&(ch, key)) {
                notes.push(NoteSpan { start_ms: start, end_ms: t.max(start), key, velocity });
            }
        } else if let Some((ch, value)) = as_sustain(&ev.bytes) {
            pedal_down.insert(ch, value >= 64);
            let any = pedal_down.values().any(|d| *d);
            match (any, pedal_start) {
                (true, None) => pedal_start = Some(t),
                (false, Some(start)) => {
                    if t > start {
                        pedal.push(TimeRangeDto { start_ms: start, end_ms: t });
                    }
                    pedal_start = None;
                }
                _ => {}
            }
        }
    }
    let end = duration_ms.max(notes.iter().map(|n| n.end_ms).max().unwrap_or(0));
    for ((_, key), (start, velocity)) in open {
        notes.push(NoteSpan { start_ms: start, end_ms: end.max(start), key, velocity });
    }
    if let Some(start) = pedal_start.filter(|s| *s < end) {
        pedal.push(TimeRangeDto { start_ms: start, end_ms: end });
    }
    notes.sort_by_key(|n| (n.start_ms, n.key));
    (notes, pedal)
}

/// Notes and pedal of `path` for the piano roll.
pub fn extract_notes(path: &Path) -> Result<MidiNotesDto, String> {
    let (events, duration_ms) = read_timed_events(path)?;
    let (notes, pedal) = spans(&events, duration_ms);
    let (min_key, max_key) = if notes.is_empty() {
        (EMPTY_MIN_KEY, EMPTY_MAX_KEY)
    } else {
        (notes.iter().map(|n| n.key).min().unwrap_or(0), notes.iter().map(|n| n.key).max().unwrap_or(127))
    };
    Ok(MidiNotesDto { file_path: path.to_string_lossy().into_owned(), duration_ms, min_key, max_key, notes, pedal })
}

/// Splits the take into the passages separated by at least `min_gap_ms` of silence (no note
/// sounding, counting the pedal: a note released with the pedal down rings until the pedal goes
/// up). Segments shorter than `min_len_ms` are merged with the closest neighbour. Each segment
/// keeps up to [`SEGMENT_PAD_MS`] of silence around it.
pub fn suggest_segments(path: &Path, min_gap_ms: u64, min_len_ms: u64) -> Result<Vec<TimeRangeDto>, String> {
    let (events, duration_ms) = read_timed_events(path)?;
    let (notes, pedal) = spans(&events, duration_ms);
    Ok(segments(&notes, &pedal, duration_ms, min_gap_ms.max(1), min_len_ms))
}

fn segments(notes: &[NoteSpan], pedal: &[TimeRangeDto], duration_ms: u64, min_gap_ms: u64, min_len_ms: u64) -> Vec<TimeRangeDto> {
    // Sounding intervals, extended to the pedal release.
    let mut sound: Vec<(u64, u64)> = notes
        .iter()
        .map(|n| {
            let end = pedal
                .iter()
                .find(|p| p.start_ms <= n.end_ms && n.end_ms < p.end_ms)
                .map_or(n.end_ms, |p| p.end_ms);
            (n.start_ms, end.max(n.start_ms + 1))
        })
        .collect();
    sound.sort_unstable();

    // Merges what is separated by less than `min_gap_ms`.
    let mut groups: Vec<(u64, u64)> = Vec::new();
    for (start, end) in sound {
        match groups.last_mut() {
            Some(last) if start < last.1 + min_gap_ms => last.1 = last.1.max(end),
            _ => groups.push((start, end)),
        }
    }

    // Short segments join the neighbour with the smaller gap.
    while groups.len() > 1 {
        let Some(i) = groups.iter().position(|(s, e)| e - s < min_len_ms) else { break };
        let gap_before = (i > 0).then(|| groups[i].0 - groups[i - 1].1);
        let gap_after = (i + 1 < groups.len()).then(|| groups[i + 1].0 - groups[i].1);
        let into_previous = match (gap_before, gap_after) {
            (Some(b), Some(a)) => b <= a,
            (Some(_), None) => true,
            _ => false,
        };
        if into_previous {
            groups[i - 1].1 = groups[i].1;
        } else {
            groups[i + 1].0 = groups[i].0;
        }
        groups.remove(i);
    }

    // Padding: up to half of the silence on each side, never past the neighbour or the take.
    let n = groups.len();
    (0..n)
        .map(|i| {
            let (s, e) = groups[i];
            let before = if i > 0 { (s - groups[i - 1].1) / 2 } else { s };
            let after = if i + 1 < n { (groups[i + 1].0 - e) / 2 } else { duration_ms.saturating_sub(e) };
            TimeRangeDto {
                start_ms: s - before.min(SEGMENT_PAD_MS),
                end_ms: (e + after.min(SEGMENT_PAD_MS)).min(duration_ms.max(e)),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi_slicer::write_smf;

    fn on(t_ms: u64, key: u8, vel: u8) -> TimedMidiEvent {
        TimedMidiEvent::new(t_ms * 1000, vec![0x90, key, vel])
    }

    fn off(t_ms: u64, key: u8) -> TimedMidiEvent {
        TimedMidiEvent::new(t_ms * 1000, vec![0x80, key, 0])
    }

    fn pedal(t_ms: u64, value: u8) -> TimedMidiEvent {
        TimedMidiEvent::new(t_ms * 1000, vec![0xB0, 64, value])
    }

    fn file(dir: &Path, events: &[TimedMidiEvent]) -> std::path::PathBuf {
        let p = dir.join("t.mid");
        write_smf(&p, events, 120).unwrap();
        p
    }

    #[test]
    fn pairs_notes_and_pedal() {
        let dir = tempfile::tempdir().unwrap();
        let p = file(
            dir.path(),
            &[
                on(0, 60, 100),
                pedal(100, 127),
                on(200, 64, 50),
                off(500, 60),
                // NoteOn velocity 0 = NoteOff.
                TimedMidiEvent::new(700_000, vec![0x90, 64, 0]),
                pedal(900, 0),
                // Repeated NoteOn: closes the previous note.
                on(1000, 67, 80),
                on(1200, 67, 90),
                off(1500, 67),
                // Left open: closed at the end.
                on(1800, 72, 70),
                off(2000, 99), // orphan NoteOff
            ],
        );
        let n = extract_notes(&p).unwrap();
        assert_eq!(n.duration_ms, 2000);
        let got: Vec<(u64, u64, u8, u8)> = n.notes.iter().map(|x| (x.start_ms, x.end_ms, x.key, x.velocity)).collect();
        assert_eq!(
            got,
            vec![(0, 500, 60, 100), (200, 700, 64, 50), (1000, 1200, 67, 80), (1200, 1500, 67, 90), (1800, 2000, 72, 70)]
        );
        assert_eq!(n.pedal, vec![TimeRangeDto { start_ms: 100, end_ms: 900 }]);
        assert_eq!((n.min_key, n.max_key), (60, 72));
    }

    #[test]
    fn empty_file_shows_the_whole_keyboard() {
        let dir = tempfile::tempdir().unwrap();
        let p = file(dir.path(), &[pedal(0, 127)]);
        let n = extract_notes(&p).unwrap();
        assert!(n.notes.is_empty());
        assert_eq!((n.min_key, n.max_key), (EMPTY_MIN_KEY, EMPTY_MAX_KEY));
        // The pedal is never released, but the file lasts 0 ms: there is no interval.
        assert!(n.pedal.is_empty());
    }

    /// A phrase: a note every 250 ms during `len_ms`.
    fn phrase(start_ms: u64, len_ms: u64) -> Vec<TimedMidiEvent> {
        (0..len_ms / 250).flat_map(|i| [on(start_ms + i * 250, 60, 90), off(start_ms + i * 250 + 200, 60)]).collect()
    }

    #[test]
    fn splits_on_long_silences() {
        let dir = tempfile::tempdir().unwrap();
        // Three 6 s phrases separated by 5 s of silence; 2 s of silence at the end.
        let mut evs = phrase(1000, 6000);
        evs.extend(phrase(12_000, 6000));
        evs.extend(phrase(23_000, 6000));
        evs.push(pedal(31_000, 0));
        let p = file(dir.path(), &evs);
        let segs = suggest_segments(&p, 3000, 4000).unwrap();
        let got: Vec<(u64, u64)> = segs.iter().map(|s| (s.start_ms, s.end_ms)).collect();
        // The last NoteOff of each phrase is 5950 ms after its start; 500 ms of padding around.
        assert_eq!(got, vec![(500, 7450), (11_500, 18_450), (22_500, 29_450)]);

        // With a minimum gap longer than the silences, it is a single segment.
        assert_eq!(suggest_segments(&p, 6000, 4000).unwrap().len(), 1);
    }

    #[test]
    fn held_pedal_keeps_the_phrase_together() {
        let dir = tempfile::tempdir().unwrap();
        let mut evs = vec![pedal(0, 127)];
        evs.extend(phrase(0, 5000));
        // 4 s without notes, but the pedal keeps the last chord ringing.
        evs.push(pedal(8000, 0));
        evs.extend(phrase(9000, 5000));
        let p = file(dir.path(), &evs);
        assert_eq!(suggest_segments(&p, 3000, 1000).unwrap().len(), 1);
    }

    #[test]
    fn short_segments_join_the_closest_neighbour() {
        let notes: Vec<NoteSpan> = [(0, 5000), (9000, 10_000), (14_500, 20_000)]
            .iter()
            .map(|&(s, e)| NoteSpan { start_ms: s, end_ms: e, key: 60, velocity: 80 })
            .collect();
        // The 1 s segment is 4 s from the first and 4.5 s from the last: it joins the first.
        let segs = segments(&notes, &[], 20_000, 3000, 4000);
        let got: Vec<(u64, u64)> = segs.iter().map(|s| (s.start_ms, s.end_ms)).collect();
        assert_eq!(got, vec![(0, 10_500), (14_000, 20_000)]);
        assert!(segments(&[], &[], 1000, 3000, 4000).is_empty());
    }
}
