//! Mixdown of a composition: its clips flattened into a single list of MIDI events with one
//! channel per track, which the audio engine plays, loops and exports like any file.
//!
//! - Each clip is the `[trim_start, trim_start + length)` window of its fragment, cut with
//!   `midi_slicer::build_fragment` (open notes and the pedal are closed at the window's end),
//!   repeated `repeats` times back to back and transposed.
//! - The track owns the instrument: the fragment's own program changes, volume (CC7) and pan
//!   (CC10) are dropped, and its pedal (CC64) too when the track ignores it.
//! - Live playback leaves volume and mute to the engine's channel mix, so the mixer can change
//!   while it plays; an export bakes them into the events.

use std::collections::HashMap;
use std::path::Path;

use crate::db::clip_end_ms;
use crate::midi_slicer::{build_fragment, read_timed_events, TimedMidiEvent};
use crate::models::{CompositionDto, TrackMixDto};

/// MIDI channel used for percussion in General MIDI: tracks skip it.
const GM_PERCUSSION_CHANNEL: u8 = 9;
const CC_VOLUME: u8 = 7;
const CC_PAN: u8 = 10;
const CC_SUSTAIN: u8 = 64;

/// Key of an instrument preview in the player.
pub fn preview_key(program: u8) -> String {
    format!("preview:{program}")
}

/// A short phrase to hear an instrument on channel 1: an ascending arpeggio and a chord.
/// Returns the events and their length (µs).
pub fn preview_events(program: u8) -> (Vec<TimedMidiEvent>, u64) {
    const VELOCITY: u8 = 90;
    let mut events = vec![TimedMidiEvent::new(0, vec![0xC0, program.min(127)])];
    let mut note = |key: u8, start_ms: u64, length_ms: u64| {
        events.push(TimedMidiEvent::new(start_ms * 1000, vec![0x90, key, VELOCITY]));
        events.push(TimedMidiEvent::new((start_ms + length_ms) * 1000, vec![0x80, key, 0]));
    };
    for (i, key) in [60u8, 64, 67, 72].into_iter().enumerate() {
        note(key, i as u64 * 250, 240);
    }
    for key in [60u8, 64, 67] {
        note(key, 1_000, 900);
    }
    events.sort_by_key(|e| (e.time_us, priority(&e.bytes)));
    (events, 2_200_000)
}

/// Key of a composition in the player (`PlaybackProgress::file_path`).
pub fn playback_key(composition_id: &str) -> String {
    format!("composition:{composition_id}")
}

/// MIDI channel of the track at `index`, skipping the percussion channel.
pub fn track_channel(index: usize) -> u8 {
    let ch = u8::try_from(index).unwrap_or(u8::MAX);
    if ch < GM_PERCUSSION_CHANNEL {
        ch
    } else {
        ch.saturating_add(1)
    }
}

/// Whether each track sounds: a muted track never does, and once a track is soloed only the
/// soloed ones do.
pub fn audible(mix: &[TrackMixDto]) -> Vec<bool> {
    let any_solo = mix.iter().any(|t| t.solo);
    mix.iter().map(|t| !t.muted && (!any_solo || t.solo)).collect()
}

/// The mixer state of the composition's tracks, in track order.
pub fn track_mix(doc: &CompositionDto) -> Vec<TrackMixDto> {
    doc.tracks.iter().map(|t| TrackMixDto { volume: t.volume, muted: t.muted, solo: t.solo }).collect()
}

/// `(channel, volume, muted)` for the engine, solo already resolved.
pub fn channel_mix(mix: &[TrackMixDto]) -> Vec<(u8, u8, bool)> {
    audible(mix)
        .into_iter()
        .zip(mix)
        .enumerate()
        .map(|(i, (sounds, t))| (track_channel(i), t.volume.min(127), !sounds))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MixMode {
    /// Volume and mute stay out of the events: the engine applies them live.
    Live,
    /// Silent tracks are left out and each track's volume is set at the start.
    Export,
}

/// Order of simultaneous events: note-offs first, so the seam between two repeats (or two
/// clips) never cuts the new note; note-ons last, after the controllers that shape them.
fn priority(bytes: &[u8]) -> u8 {
    match bytes.first().map(|s| s & 0xF0) {
        Some(0x80) => 0,
        Some(0x90) if bytes.get(2) == Some(&0) => 0,
        Some(0x90) => 2,
        _ => 1,
    }
}

/// The event moved to `channel` and transposed, or `None` if the track drops it.
fn adapt(bytes: &[u8], channel: u8, transpose: i32, sustain: bool) -> Option<Vec<u8>> {
    let status = *bytes.first()?;
    if !(0x80..0xF0).contains(&status) {
        return None;
    }
    let kind = status & 0xF0;
    let mut out = bytes.to_vec();
    out[0] = kind | channel;
    match kind {
        0xC0 => return None,
        0xB0 => {
            let cc = *bytes.get(1)?;
            if cc == CC_VOLUME || cc == CC_PAN || (cc == CC_SUSTAIN && !sustain) {
                return None;
            }
        }
        // Note on, note off and polyphonic aftertouch carry a key.
        0x80 | 0x90 | 0xA0 => {
            let key = i32::from(*bytes.get(1)?) + transpose;
            out[1] = u8::try_from(key).ok().filter(|k| *k <= 127)?;
        }
        _ => {}
    }
    Some(out)
}

/// Flattens the composition. `load` returns a fragment's events (each file is read once).
/// Returns the events sorted by time and the composition's length (µs).
pub fn build_events_with(
    doc: &CompositionDto,
    mode: MixMode,
    mut load: impl FnMut(&str) -> Result<Vec<TimedMidiEvent>, String>,
) -> Result<(Vec<TimedMidiEvent>, u64), String> {
    let sounds = audible(&track_mix(doc));
    let mut cache: HashMap<&str, Vec<TimedMidiEvent>> = HashMap::new();
    // Sorted by (time, priority) with a stable sort: simultaneous events of the same priority
    // keep their original order.
    let mut out: Vec<(TimedMidiEvent, u8)> = Vec::new();
    let mut duration_ms = 0u64;

    for (i, track) in doc.tracks.iter().enumerate() {
        duration_ms = duration_ms.max(track.clips.iter().map(clip_end_ms).max().unwrap_or(0));
        if mode == MixMode::Export && !sounds[i] {
            continue;
        }
        let ch = track_channel(i);
        out.push((TimedMidiEvent::new(0, vec![0xC0 | ch, track.program.min(127)]), 1));
        if mode == MixMode::Export {
            out.push((TimedMidiEvent::new(0, vec![0xB0 | ch, CC_VOLUME, track.volume.min(127)]), 1));
        }
        for clip in &track.clips {
            let path = clip.fragment_file_path.as_str();
            if !cache.contains_key(path) {
                cache.insert(path, load(path)?);
            }
            let window_start = clip.trim_start_ms.saturating_mul(1000);
            let length_us = clip.length_ms.saturating_mul(1000);
            let window = build_fragment(&cache[path], window_start, window_start + length_us);
            for rep in 0..u64::from(clip.repeats) {
                let offset = clip.start_ms.saturating_mul(1000) + rep * length_us;
                for ev in &window {
                    if let Some(bytes) = adapt(&ev.bytes, ch, clip.transpose, track.sustain) {
                        let p = priority(&bytes);
                        out.push((TimedMidiEvent::new(offset + ev.time_us, bytes), p));
                    }
                }
            }
        }
    }
    out.sort_by_key(|(ev, p)| (ev.time_us, *p));
    Ok((out.into_iter().map(|(ev, _)| ev).collect(), duration_ms.saturating_mul(1000)))
}

/// [`build_events_with`] reading the fragments from disk.
pub fn build_events(doc: &CompositionDto, mode: MixMode) -> Result<(Vec<TimedMidiEvent>, u64), String> {
    build_events_with(doc, mode, |path| read_timed_events(Path::new(path)).map(|(events, _)| events))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CompositionClipDto, CompositionTrackDto};

    const FRAG: &str = "/vault/midi/fragments/a.mid";

    /// 2 s on channel 0: C4 0-1 s, E4 0.5-1.5 s, pedal down at 0 and up at 1.8 s, plus the
    /// keyboard's own program change and volume.
    fn fragment() -> Vec<TimedMidiEvent> {
        vec![
            TimedMidiEvent::new(0, vec![0xC0, 5]),
            TimedMidiEvent::new(0, vec![0xB0, 7, 90]),
            TimedMidiEvent::new(0, vec![0xB0, 64, 127]),
            TimedMidiEvent::new(0, vec![0x90, 60, 100]),
            TimedMidiEvent::new(500_000, vec![0x90, 64, 80]),
            TimedMidiEvent::new(1_000_000, vec![0x80, 60, 0]),
            TimedMidiEvent::new(1_500_000, vec![0x80, 64, 0]),
            TimedMidiEvent::new(1_800_000, vec![0xB0, 64, 0]),
        ]
    }

    fn clip(start_ms: u64, trim_start_ms: u64, length_ms: u64) -> CompositionClipDto {
        CompositionClipDto {
            id: "c".into(),
            fragment_id: "a".into(),
            start_ms,
            trim_start_ms,
            length_ms,
            repeats: 1,
            transpose: 0,
            fragment_title: "A".into(),
            fragment_file_path: FRAG.into(),
            fragment_duration_ms: 2_000,
        }
    }

    fn track(clips: Vec<CompositionClipDto>) -> CompositionTrackDto {
        CompositionTrackDto {
            id: "t".into(),
            name: "T".into(),
            program: 0,
            volume: 100,
            muted: false,
            solo: false,
            sustain: true,
            color: 0,
            clips,
        }
    }

    fn doc(tracks: Vec<CompositionTrackDto>) -> CompositionDto {
        CompositionDto { id: "x".into(), title: "X".into(), created_at: String::new(), updated_at: String::new(), tracks }
    }

    fn build(doc: &CompositionDto, mode: MixMode) -> (Vec<TimedMidiEvent>, u64) {
        let mut reads = 0;
        let r = build_events_with(doc, mode, |p| {
            assert_eq!(p, FRAG);
            reads += 1;
            Ok(fragment())
        })
        .unwrap();
        assert!(reads <= 1, "each fragment is read once");
        r
    }

    /// `(time_ms, status, key)` of the notes.
    fn notes(evs: &[TimedMidiEvent]) -> Vec<(u64, u8, u8)> {
        evs.iter()
            .filter(|e| matches!(e.bytes[0] & 0xF0, 0x80 | 0x90))
            .map(|e| (e.time_us / 1000, e.bytes[0], e.bytes[1]))
            .collect()
    }

    #[test]
    fn channels_skip_percussion() {
        let channels: Vec<u8> = (0..crate::db::COMPOSITION_MAX_TRACKS).map(track_channel).collect();
        assert_eq!(channels, vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);
        assert_eq!(playback_key("abc"), "composition:abc");
    }

    #[test]
    fn solo_and_mute_resolve_per_track() {
        let m = |muted, solo| TrackMixDto { volume: 100, muted, solo };
        assert_eq!(audible(&[m(false, false), m(true, false)]), vec![true, false]);
        assert_eq!(audible(&[m(false, false), m(false, true), m(true, true)]), vec![false, true, false]);
        let mix = channel_mix(&[m(false, false), m(false, true)]);
        assert_eq!(mix, vec![(0, 100, true), (1, 100, false)]);
    }

    #[test]
    fn each_track_gets_its_channel_and_instrument() {
        let mut flute = track(vec![clip(1_000, 0, 2_000)]);
        flute.program = 73;
        let d = doc(vec![track(vec![]), flute]);
        let (evs, duration) = build(&d, MixMode::Live);
        assert_eq!(duration, 3_000_000);
        // One program change per track at the start; the fragment's own one is gone.
        let programs: Vec<&[u8]> = evs.iter().filter(|e| e.bytes[0] & 0xF0 == 0xC0).map(|e| e.bytes.as_slice()).collect();
        assert_eq!(programs, vec![&[0xC0, 0][..], &[0xC1, 73][..]]);
        assert!(evs.iter().all(|e| e.bytes[0] & 0xF0 == 0xC0 || e.bytes[0] & 0x0F == 1), "every clip event on channel 2");
        assert!(!evs.iter().any(|e| e.bytes[0] & 0xF0 == 0xB0 && e.bytes[1] == 7), "volume belongs to the mixer");
        assert_eq!(notes(&evs), vec![(1_000, 0x91, 60), (1_500, 0x91, 64), (2_000, 0x81, 60), (2_500, 0x81, 64)]);
        assert!(evs.windows(2).all(|w| w[0].time_us <= w[1].time_us));
    }

    #[test]
    fn the_window_closes_its_notes_and_pedal() {
        // 0.5-1.2 s: C4 started before the window (left out), E4 is cut at the window's end.
        let (evs, duration) = build(&doc(vec![track(vec![clip(0, 500, 700)])]), MixMode::Live);
        assert_eq!(duration, 700_000);
        assert_eq!(notes(&evs), vec![(0, 0x90, 64), (700, 0x80, 64)]);
        let pedal: Vec<(u64, u8)> =
            evs.iter().filter(|e| e.bytes[0] == 0xB0 && e.bytes[1] == 64).map(|e| (e.time_us / 1000, e.bytes[2])).collect();
        assert_eq!(pedal, vec![(0, 127), (700, 0)], "pedal held at the start and released at the end");
    }

    #[test]
    fn repeats_play_back_to_back_without_cutting_the_seam() {
        let mut c = clip(0, 0, 1_000);
        c.repeats = 3;
        let (evs, duration) = build(&doc(vec![track(vec![c])]), MixMode::Live);
        assert_eq!(duration, 3_000_000);
        let c4: Vec<(u64, u8)> = notes(&evs).into_iter().filter(|n| n.2 == 60).map(|n| (n.0, n.1)).collect();
        // At each seam the old note ends before the new one starts.
        assert_eq!(c4, vec![(0, 0x90), (1_000, 0x80), (1_000, 0x90), (2_000, 0x80), (2_000, 0x90), (3_000, 0x80)]);
    }

    #[test]
    fn transposition_drops_notes_out_of_range() {
        let mut up = clip(0, 0, 2_000);
        up.transpose = 12;
        let (evs, _) = build(&doc(vec![track(vec![up])]), MixMode::Live);
        assert_eq!(notes(&evs).iter().map(|n| n.2).collect::<Vec<_>>(), vec![72, 76, 72, 76]);

        let mut far = clip(0, 0, 2_000);
        far.transpose = 65; // C4 → 125, E4 → 129 (out)
        let (evs, _) = build(&doc(vec![track(vec![far])]), MixMode::Live);
        assert_eq!(notes(&evs), vec![(0, 0x90, 125), (1_000, 0x80, 125)]);
    }

    #[test]
    fn a_track_can_ignore_the_pedal() {
        let mut t = track(vec![clip(0, 0, 2_000)]);
        t.sustain = false;
        let (evs, _) = build(&doc(vec![t]), MixMode::Live);
        assert!(!evs.iter().any(|e| e.bytes[0] & 0xF0 == 0xB0 && e.bytes[1] == 64));
        assert_eq!(notes(&evs).len(), 4);
    }

    #[test]
    fn export_bakes_the_mix() {
        let mut piano = track(vec![clip(0, 0, 2_000)]);
        piano.volume = 80;
        let mut muted = track(vec![clip(2_000, 0, 2_000)]);
        muted.muted = true;
        let d = doc(vec![piano, muted]);

        let (live, live_len) = build(&d, MixMode::Live);
        assert!(live.iter().any(|e| e.bytes[0] & 0x0F == 1), "live playback keeps the muted track");
        let (export, export_len) = build(&d, MixMode::Export);
        assert_eq!(live_len, export_len, "the length follows the timeline, silent tracks too");
        assert!(export.iter().all(|e| e.bytes[0] & 0x0F == 0));
        assert!(export.iter().any(|e| e.bytes == vec![0xB0, 7, 80]));
        assert_eq!(notes(&export).len(), 4);
    }

    #[test]
    fn the_preview_plays_the_instrument() {
        let (evs, duration) = preview_events(73);
        assert_eq!(evs[0].bytes, vec![0xC0, 73]);
        assert_eq!(notes(&evs).iter().filter(|n| n.1 == 0x90).count(), 7);
        assert!(evs.last().unwrap().time_us <= duration);
        assert_eq!(preview_key(73), "preview:73");
    }

    #[test]
    fn an_empty_composition_has_no_notes() {
        let (evs, duration) = build(&doc(vec![track(vec![])]), MixMode::Export);
        assert_eq!(duration, 0);
        assert!(notes(&evs).is_empty());
        let err = build_events_with(&doc(vec![track(vec![clip(0, 0, 1)])]), MixMode::Live, |_| Err("missing".into()));
        assert_eq!(err.unwrap_err(), "missing");
    }
}
