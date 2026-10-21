import {
  MIN_CLIP_MS,
  audible,
  clipEnd,
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
    fragment_title: 'F',
    fragment_file_path: '/v/f.mid',
    fragment_duration_ms: 10_000,
    ...extra,
  };
}

function track(clips: CompositionClipDto[], extra: Partial<CompositionTrackDto> = {}): CompositionTrackDto {
  return { id: 't', name: 'T', program: 0, volume: 100, muted: false, solo: false, sustain: true, color: 0, clips, ...extra };
}

function doc(tracks: CompositionTrackDto[]): CompositionDto {
  return { id: 'c', title: 'C', created_at: '', updated_at: '', tracks };
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
