import {
  MIN_CLIP_MS,
  audible,
  clipEnd,
  inferTempo,
  matchTempo,
  playedMs,
  rateForTempo,
  repetitionMs,
  resolveOverlaps,
  withTempo,
  compositionDuration,
  compositionKey,
  findClip,
  fitStart,
  freeSpan,
  maxRepeats,
  newTrack,
  nextColor,
  parseCompositionKey,
  snapMs,
  snapTargets,
  splitClip,
  trimClip,
} from './composition';
import type { CompositionClipDto, CompositionDto, CompositionTrackDto } from './models';

function clip(id: string, start: number, length: number, extra: Partial<CompositionClipDto> = {}): CompositionClipDto {
  return {
    id,
    fragment_id: 'f',
    start_ms: start,
    trim_start_ms: 0,
    length_ms: length,
    repeats: 1,
    transpose: 0,
    rate_pct: 100,
    fragment_title: 'F',
    fragment_file_path: '/v/f.mid',
    fragment_duration_ms: 10_000,
    fragment_bpm: 100,
    fragment_score_id: null,
    ...extra,
  };
}

function track(clips: CompositionClipDto[], extra: Partial<CompositionTrackDto> = {}): CompositionTrackDto {
  return { id: 't', name: 'T', program: 0, volume: 100, muted: false, solo: false, sustain: true, color: 0, clips, ...extra };
}

function doc(tracks: CompositionTrackDto[]): CompositionDto {
  return { id: 'c', title: 'C', bpm: null, created_at: '', updated_at: '', tracks };
}

describe('composition', () => {
  it('maps compositions to player keys and back', () => {
    expect(compositionKey('abc')).toBe('composition:abc');
    expect(parseCompositionKey('composition:abc')).toBe('abc');
    expect(parseCompositionKey('/vault/midi/fragments/a.mid')).toBeNull();
    expect(parseCompositionKey(null)).toBeNull();
  });

  it('measures clips and the composition with their repeats', () => {
    const c = clip('a', 1_000, 2_000, { repeats: 3 });
    expect(clipEnd(c)).toBe(7_000);
    expect(compositionDuration(doc([track([c]), track([clip('b', 0, 9_000)])]))).toBe(9_000);
    expect(findClip(doc([track([]), track([c])]), 'a')).toEqual({ track: 1, index: 0, clip: c });
    expect(findClip(doc([track([c])]), 'zzz')).toBeNull();
  });

  it('resolves mute and solo', () => {
    expect(audible([track([]), track([], { muted: true })])).toEqual([true, false]);
    expect(audible([track([]), track([], { solo: true }), track([], { solo: true, muted: true })])).toEqual([false, true, false]);
  });

  it('places a dropped clip after the clips it would overlap', () => {
    const others = [clip('a', 0, 5_000), clip('b', 6_000, 2_000)];
    expect(fitStart(others, 5_000, 1_000)).toBe(5_000);
    expect(fitStart(others, 4_000, 1_000)).toBe(5_000); // the 1 s gap between a and b fits
    expect(fitStart(others, 4_000, 1_500)).toBe(8_000); // after a it would still hit b
    expect(fitStart(others, 3_000, 500)).toBe(5_000);
    expect(fitStart(others, -50, 100)).toBe(5_000);
    expect(fitStart([], -50, 100)).toBe(0);
  });

  it('finds the free span around a clip', () => {
    const b = clip('b', 6_000, 1_000);
    expect(freeSpan([clip('a', 0, 5_000), b, clip('c', 9_000, 1_000)], b)).toEqual({ min: 5_000, max: 9_000 });
    expect(freeSpan([b], b)).toEqual({ min: 0, max: Number.POSITIVE_INFINITY });
  });

  it('snaps to clip edges first and then to seconds', () => {
    const d = doc([track([clip('a', 0, 2_340), clip('b', 5_000, 1_000)])]);
    const targets = snapTargets(d, 'b', [7_777]);
    expect(targets).toEqual([0, 7_777, 0, 2_340]);
    expect(snapMs(2_400, 'edges', targets, 100)).toBe(2_340);
    expect(snapMs(3_456, 'edges', targets, 100)).toBe(3_460);
    expect(snapMs(3_456, 'seconds', targets, 100)).toBe(3_000);
    expect(snapMs(7_700, 'seconds', targets, 100)).toBe(7_777);
    expect(snapMs(2_400, 'off', targets, 100)).toBe(2_400);
    expect(snapMs(-30, 'seconds', targets, 10)).toBe(0);
  });

  it('trims a window inside its fragment and its neighbours', () => {
    const c = clip('a', 2_000, 4_000, { trim_start_ms: 1_000 });
    const free = { min: 0, max: Number.POSITIVE_INFINITY };
    expect(trimClip(c, 'start', 500, free)).toMatchObject({ start_ms: 2_500, trim_start_ms: 1_500, length_ms: 3_500 });
    // It can't go before the fragment's start…
    expect(trimClip(c, 'start', -5_000, free)).toMatchObject({ start_ms: 1_000, trim_start_ms: 0, length_ms: 5_000 });
    // …nor over the previous clip, nor leave less than the minimum.
    expect(trimClip(c, 'start', -5_000, { min: 1_800, max: Infinity })).toMatchObject({ start_ms: 1_800, trim_start_ms: 800 });
    expect(trimClip(c, 'start', 9_000, free).length_ms).toBe(MIN_CLIP_MS);
    // The end stops at the fragment's end (10 s) and at the next clip.
    expect(trimClip(c, 'end', 9_000, free).length_ms).toBe(9_000);
    expect(trimClip(c, 'end', 9_000, { min: 0, max: 7_000 }).length_ms).toBe(5_000);
    const rep = { ...c, repeats: 2 };
    expect(trimClip(rep, 'end', 9_000, { min: 0, max: 11_000 }).length_ms).toBe(4_500);
  });

  it('limits repeats to the room before the next clip', () => {
    const c = clip('a', 0, 2_000);
    expect(maxRepeats(c, { min: 0, max: 7_000 })).toBe(3);
    expect(maxRepeats(c, { min: 0, max: 1_000 })).toBe(1);
    expect(maxRepeats(c, { min: 0, max: Infinity })).toBe(16);
  });

  it('splits a clip keeping whole repeats together', () => {
    const c = clip('a', 1_000, 2_000, { trim_start_ms: 500 });
    const half = splitClip(c, 2_000)!;
    expect(half.right).toBe(1);
    expect(half.clips.map((k) => [k.start_ms, k.trim_start_ms, k.length_ms, k.repeats])).toEqual([
      [1_000, 500, 1_000, 1],
      [2_000, 1_500, 1_000, 1],
    ]);
    expect(half.clips[0].id).toBe('a');
    expect(half.clips[1].id).not.toBe('a');

    const looped = clip('b', 0, 1_000, { repeats: 4 });
    // On a seam: two clips of whole repeats.
    expect(splitClip(looped, 2_000)!.clips.map((k) => [k.start_ms, k.repeats])).toEqual([
      [0, 2],
      [2_000, 2],
    ]);
    // Inside the second repetition: 1 whole + two halves + 2 whole.
    const mid = splitClip(looped, 1_500)!;
    expect(mid.right).toBe(2);
    expect(mid.clips.map((k) => [k.start_ms, k.trim_start_ms, k.length_ms, k.repeats])).toEqual([
      [0, 0, 1_000, 1],
      [1_000, 0, 500, 1],
      [1_500, 500, 500, 1],
      [2_000, 0, 1_000, 2],
    ]);
    expect(splitClip(c, 1_050)).toBeNull();
    expect(splitClip(c, 2_990)).toBeNull();
    expect(splitClip(looped, 1_020)).toBeNull();
  });

  it('gives new tracks the first free colour', () => {
    expect(nextColor([track([], { color: 0 }), track([], { color: 2 })])).toBe(1);
    const t = newTrack([track([], { color: 0 })], 'Bass');
    expect(t).toMatchObject({ name: 'Bass', program: 0, volume: 100, sustain: true, color: 1, clips: [] });
    expect(t.id).toBeTruthy();
  });
});

describe('clips at another speed', () => {
  const fast = (id: string, start: number, length: number, extra: Partial<CompositionClipDto> = {}) => clip(id, start, length, { rate_pct: 200, ...extra });

  it('takes length × 100 / rate on the timeline, repeats included, rounded up', () => {
    expect(clipEnd(clip('a', 1000, 4000))).toBe(5000);
    expect(clipEnd(fast('a', 1000, 4000))).toBe(3000);
    expect(clipEnd(clip('a', 0, 4000, { rate_pct: 50 }))).toBe(8000);
    expect(clipEnd(fast('a', 0, 4000, { repeats: 3 }))).toBe(6000);
    expect(clipEnd(clip('a', 0, 1000, { rate_pct: 150, repeats: 2 }))).toBe(1334); // 1333.3 rounds up
    expect(playedMs({ length_ms: 1000, rate_pct: 150 }, 1)).toBe(667);
    expect(repetitionMs(fast('a', 0, 4000))).toBe(2000);
  });

  it('sees the real end when fitting and measuring free room', () => {
    const others = [fast('a', 0, 4000)]; // ends at 2000
    expect(fitStart(others, 1000, 500)).toBe(2000);
    expect(freeSpan([fast('a', 0, 1000), fast('b', 3000, 1000)], fast('a', 0, 1000))).toEqual({ min: 0, max: 3000 });
  });

  it('counts how many repetitions fit before the next clip at that speed', () => {
    const c = fast('a', 0, 4000); // 2 s each
    expect(maxRepeats(c, { min: 0, max: 7000 })).toBe(3);
    expect(maxRepeats(c, { min: 0, max: 6000 })).toBe(3);
    expect(maxRepeats(c, { min: 0, max: 1000 })).toBe(1);
    expect(maxRepeats(clip('a', 0, 1000, { rate_pct: 150 }), { min: 0, max: 1334 })).toBe(2);
  });

  it('trims in timeline time but cuts the fragment in its own time', () => {
    const c = fast('a', 2000, 4000, { trim_start_ms: 1000 });
    // Dragging the left edge 500 ms right on the timeline skips 1000 ms of music.
    const left = trimClip(c, 'start', 500, { min: 0, max: Infinity });
    expect(left).toMatchObject({ start_ms: 2500, trim_start_ms: 2000, length_ms: 3000 });
    // Dragging the right edge 250 ms left removes 500 ms of music.
    expect(trimClip(c, 'end', -250, { min: 0, max: Infinity }).length_ms).toBe(3500);
    // The fragment (10 s) limits the right edge: 5000 ms of music left.
    expect(trimClip(c, 'end', 99_999, { min: 0, max: Infinity }).length_ms).toBe(9000);
    // The next clip limits it too: 1 s of timeline room is 2 s of music.
    expect(trimClip(c, 'end', 99_999, { min: 0, max: clipEnd(c) + 1000 }).length_ms).toBe(6000);
  });

  it('splits in the fragment time and lays the pieces back to back', () => {
    const c = fast('a', 1000, 4000, { trim_start_ms: 500 }); // timeline 1000-3000
    const r = splitClip(c, 2000)!; // 1 s in = 2 s of music
    expect(r.clips).toHaveLength(2);
    expect(r.clips[0]).toMatchObject({ id: 'a', start_ms: 1000, trim_start_ms: 500, length_ms: 2000, rate_pct: 200 });
    expect(r.clips[1]).toMatchObject({ start_ms: 2000, trim_start_ms: 2500, length_ms: 2000, rate_pct: 200 });
    expect(clipEnd(r.clips[1])).toBe(clipEnd(c));
    expect(splitClip(c, 1020)).toBeNull(); // too close to the edge: 40 ms of music
  });

  it('splits repetitions that stay whole', () => {
    const c = clip('a', 0, 1000, { rate_pct: 200, repeats: 4 }); // 500 ms each
    const r = splitClip(c, 1000)!; // after two repetitions
    expect(r.clips.map((k) => [k.start_ms, k.repeats])).toEqual([[0, 2], [1000, 2]]);
  });
});

describe('tempo', () => {
  const score = (id: string, start: number, bpm: number, extra: Partial<CompositionClipDto> = {}) =>
    clip(id, start, 4000, { fragment_bpm: bpm, fragment_score_id: 's-' + id, ...extra });
  const doc = (clips: CompositionClipDto[], bpm: number | null = null): CompositionDto => ({
    id: 'c',
    title: 'C',
    bpm,
    created_at: '',
    updated_at: '',
    tracks: [track(clips)],
  });

  it('finds the speed that keeps a fragment in time', () => {
    expect(rateForTempo(120, 120)).toBe(100);
    expect(rateForTempo(120, 90)).toBe(133);
    expect(rateForTempo(60, 120)).toBe(50);
    expect(rateForTempo(240, 30)).toBe(400); // clamped
    expect(rateForTempo(30, 240)).toBe(25);
    expect(rateForTempo(0, 90)).toBe(100);
  });

  it('puts the scores in time with the composition and leaves recordings alone', () => {
    const d = withTempo(doc([clip('rec', 0, 2000, { fragment_bpm: 70 }), score('x', 3000, 90)]), 120);
    expect(d.bpm).toBe(120);
    const [rec, sc] = d.tracks[0].clips;
    expect(rec.rate_pct).toBe(100);
    expect(sc.rate_pct).toBe(133);
  });

  it('pushes the next clip when a score slows down', () => {
    // At 90 BPM a score of 120 BPM plays at 75 %: 4 s of music take 5333 ms.
    const d = withTempo(doc([score('a', 0, 120), clip('b', 4000, 1000)]), 90);
    const [a, b] = d.tracks[0].clips;
    expect(a.rate_pct).toBe(75);
    expect(clipEnd(a)).toBe(5334);
    expect(b.start_ms).toBe(5334);
  });

  it('bounds the tempo to the allowed range', () => {
    expect(withTempo(doc([]), 5).bpm).toBe(30);
    expect(withTempo(doc([]), 500).bpm).toBe(240);
  });

  it('adopts the tempo of the first recorded clip', () => {
    expect(inferTempo(doc([score('s', 0, 90), clip('late', 9000, 1000, { fragment_bpm: 80 }), clip('early', 5000, 1000, { fragment_bpm: 110 })]))).toBe(110);
    expect(inferTempo(doc([score('s', 0, 90)]))).toBeNull();
    expect(inferTempo(doc([]))).toBeNull();
  });

  it('matches the chosen clips, or all of them, to the tempo', () => {
    const d = doc([clip('a', 0, 2000, { fragment_bpm: 100 }), clip('b', 5000, 2000, { fragment_bpm: 80 })], 120);
    expect(matchTempo(d, new Set(['b']))!.tracks[0].clips.map((c) => c.rate_pct)).toEqual([100, 150]);
    expect(matchTempo(d, null)!.tracks[0].clips.map((c) => c.rate_pct)).toEqual([120, 150]);
    expect(matchTempo(doc([clip('a', 0, 2000)], null), null)).toBeNull();
  });

  it('removes overlaps by moving clips right, in order', () => {
    const out = resolveOverlaps([clip('b', 1000, 2000), clip('a', 0, 2000), clip('c', 2500, 500)]);
    expect(out.map((c) => [c.id, c.start_ms])).toEqual([['a', 0], ['b', 2000], ['c', 4000]]);
  });
});
