import { clamp } from './format';
import type { CompositionClipDto, CompositionDto, CompositionTrackDto, LibraryFragmentDto, TrackMixDto } from './models';

/** Prefix of a composition's key in the player (`PlaybackProgress.file_path`). */
export const COMPOSITION_KEY_PREFIX = 'composition:';
/** One MIDI channel per track, skipping GM percussion (mirrors `db::COMPOSITION_MAX_TRACKS`). */
export const MAX_TRACKS = 15;
export const MAX_REPEATS = 16;
export const MAX_TRANSPOSE = 24;
/** Speed of a clip in percent (mirrors `db::CLIP_MIN_RATE_PCT` / `CLIP_MAX_RATE_PCT`). */
export const MIN_RATE_PCT = 25;
export const MAX_RATE_PCT = 400;
export const DEFAULT_RATE_PCT = 100;
/** Tempo range of a composition (the same as a score's). */
export const MIN_BPM = 30;
export const MAX_BPM = 240;
/** Shortest clip window. */
export const MIN_CLIP_MS = 100;
/** Default MIDI channel volume (General MIDI). */
export const DEFAULT_VOLUME = 100;

/** Track colours (r,g,b), in the order new tracks take them. Brass first, like the rest of the app. */
export const TRACK_COLORS = ['233, 180, 76', '76, 195, 181', '164, 147, 242', '240, 149, 106', '111, 176, 234', '228, 139, 179'] as const;

export function trackRgb(track: Pick<CompositionTrackDto, 'color'>): string {
  return TRACK_COLORS[track.color % TRACK_COLORS.length];
}

export function compositionKey(id: string): string {
  return COMPOSITION_KEY_PREFIX + id;
}

/** The composition id of a player key, or null if the key is a file. */
export function parseCompositionKey(key: string | null | undefined): string | null {
  return key?.startsWith(COMPOSITION_KEY_PREFIX) ? key.slice(COMPOSITION_KEY_PREFIX.length) : null;
}

/** Id for a new track or clip (the backend keeps the ids it receives). */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** What `n` repetitions of the window take on the timeline: `length × n × 100 / rate`, rounded up like the backend. */
export function playedMs(c: Pick<CompositionClipDto, 'length_ms' | 'rate_pct'>, repeats: number): number {
  return Math.ceil((c.length_ms * repeats * 100) / Math.max(1, c.rate_pct));
}

/** End of the clip on the timeline, repeats and speed included (mirrors `db::clip_end_ms`). */
export function clipEnd(c: Pick<CompositionClipDto, 'start_ms' | 'length_ms' | 'repeats' | 'rate_pct'>): number {
  return c.start_ms + playedMs(c, c.repeats);
}

/** One repetition on the timeline (for dragging the repeat handle; not rounded). */
export function repetitionMs(c: Pick<CompositionClipDto, 'length_ms' | 'rate_pct'>): number {
  return (c.length_ms * 100) / Math.max(1, c.rate_pct);
}

/** Time in the fragment's own clock that `timelineMs` of playback covers at the clip's speed. */
function toFragmentMs(c: Pick<CompositionClipDto, 'rate_pct'>, timelineMs: number): number {
  return Math.round((timelineMs * c.rate_pct) / 100);
}

export function compositionDuration(doc: CompositionDto): number {
  let end = 0;
  for (const t of doc.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function clipCount(doc: CompositionDto): number {
  return doc.tracks.reduce((n, t) => n + t.clips.length, 0);
}

/** Whether each track sounds: never if muted, and once one is soloed only the soloed ones. */
export function audible(tracks: readonly Pick<CompositionTrackDto, 'muted' | 'solo'>[]): boolean[] {
  const anySolo = tracks.some((t) => t.solo);
  return tracks.map((t) => !t.muted && (!anySolo || t.solo));
}

export function trackMix(doc: CompositionDto): TrackMixDto[] {
  return doc.tracks.map((t) => ({ volume: t.volume, muted: t.muted, solo: t.solo }));
}

/** Where a clip is in the document. */
export interface ClipRef {
  track: number;
  index: number;
  clip: CompositionClipDto;
}

export function findClip(doc: CompositionDto | null, clipId: string | null): ClipRef | null {
  if (!doc || !clipId) return null;
  for (let track = 0; track < doc.tracks.length; track++) {
    const index = doc.tracks[track].clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, index, clip: doc.tracks[track].clips[index] };
  }
  return null;
}

/**
 * First start at or after `desired` where a clip of `length` fits on a track without overlapping
 * `others`: dropped on another clip, it goes right after it.
 */
export function fitStart(others: readonly CompositionClipDto[], desired: number, length: number): number {
  const sorted = [...others].sort((a, b) => a.start_ms - b.start_ms);
  let start = Math.max(0, Math.round(desired));
  for (const o of sorted) {
    if (start < clipEnd(o) && o.start_ms < start + length) start = clipEnd(o);
  }
  return start;
}

/** Free span around a clip on its track: `[previous clip's end, next clip's start)`. */
export function freeSpan(others: readonly CompositionClipDto[], clip: CompositionClipDto): { min: number; max: number } {
  let min = 0;
  let max = Number.POSITIVE_INFINITY;
  for (const o of others) {
    if (o.id === clip.id) continue;
    if (clipEnd(o) <= clip.start_ms) min = Math.max(min, clipEnd(o));
    else if (o.start_ms >= clipEnd(clip)) max = Math.min(max, o.start_ms);
  }
  return { min, max };
}

export type SnapMode = 'edges' | 'seconds' | 'off';

/** Every clip edge of the composition (except `excludeId`'s), plus 0 and `extra`. */
export function snapTargets(doc: CompositionDto, excludeId: string | null, extra: number[] = []): number[] {
  const out = [0, ...extra];
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.id !== excludeId) out.push(c.start_ms, clipEnd(c));
    }
  }
  return out;
}

/**
 * Snaps `ms` to the nearest target closer than `thresholdMs`; in `seconds` mode, otherwise to the
 * nearest whole second. `off` leaves it at 10 ms resolution.
 */
export function snapMs(ms: number, mode: SnapMode, targets: readonly number[], thresholdMs: number): number {
  if (mode === 'off') return Math.max(0, Math.round(ms / 10) * 10);
  let best = ms;
  let bestDist = thresholdMs;
  for (const t of targets) {
    const d = Math.abs(t - ms);
    if (d <= bestDist) {
      best = t;
      bestDist = d;
    }
  }
  if (best !== ms) return Math.max(0, best);
  return Math.max(0, mode === 'seconds' ? Math.round(ms / 1000) * 1000 : Math.round(ms / 10) * 10);
}

/** A new clip with the whole fragment, at `rate` percent of its speed. */
export function clipFromFragment(f: LibraryFragmentDto, start: number, rate = DEFAULT_RATE_PCT): CompositionClipDto {
  return {
    id: newId(),
    fragment_id: f.id,
    start_ms: Math.max(0, Math.round(start)),
    trim_start_ms: 0,
    length_ms: f.duration_ms,
    repeats: 1,
    transpose: 0,
    rate_pct: rate,
    fragment_title: f.title,
    fragment_file_path: f.file_path,
    fragment_duration_ms: f.duration_ms,
    fragment_bpm: f.bpm,
    fragment_score_id: f.score_id,
  };
}

/**
 * Moves one edge of the clip's window by `delta` timeline ms, inside the fragment, keeping at least
 * `MIN_CLIP_MS` and without crossing the neighbours (`span`). The window is in the fragment's own
 * time, so at a speed other than 100 % the same `delta` covers more or less music. With repeats,
 * every repetition changes: the right edge moves `delta × repeats` on the timeline.
 */
export function trimClip(c: CompositionClipDto, edge: 'start' | 'end', delta: number, span: { min: number; max: number }): CompositionClipDto {
  if (edge === 'start') {
    const lo = Math.max(-c.trim_start_ms, toFragmentMs(c, span.min - c.start_ms));
    const d = Math.round(clamp(toFragmentMs(c, delta), lo, c.length_ms - MIN_CLIP_MS));
    const moved = Math.round((d * 100) / c.rate_pct);
    return { ...c, start_ms: c.start_ms + moved, trim_start_ms: c.trim_start_ms + d, length_ms: c.length_ms - d };
  }
  const roomInFragment = c.fragment_duration_ms - c.trim_start_ms - c.length_ms;
  const roomOnTrack = Number.isFinite(span.max) ? toFragmentMs(c, Math.floor((span.max - clipEnd(c)) / c.repeats)) : Number.POSITIVE_INFINITY;
  const d = Math.round(clamp(toFragmentMs(c, delta), MIN_CLIP_MS - c.length_ms, Math.min(roomInFragment, roomOnTrack)));
  return { ...c, length_ms: c.length_ms + d };
}

/** Repeats that fit before the next clip (at least 1, at most `MAX_REPEATS`). */
export function maxRepeats(c: CompositionClipDto, span: { min: number; max: number }): number {
  if (!Number.isFinite(span.max)) return MAX_REPEATS;
  let n = clamp(Math.floor((span.max - c.start_ms) / repetitionMs(c)), 1, MAX_REPEATS);
  while (n > 1 && c.start_ms + playedMs(c, n) > span.max) n--;
  return n;
}

/**
 * Splits the clip at `at` (timeline ms). Whole repetitions stay together; a repetition cut in
 * the middle becomes two clips. Returns the clips that replace it (the first keeps its id) and
 * the index of the first one after the cut, or null if the cut is too close to an edge. Lengths
 * are in the fragment's own time, so the pieces keep the clip's speed; they are laid back to back
 * from the clip's start, as its repetitions were.
 */
export function splitClip(c: CompositionClipDto, at: number): { clips: CompositionClipDto[]; right: number } | null {
  const rel = toFragmentMs(c, Math.round(at) - c.start_ms);
  const total = c.length_ms * c.repeats;
  if (rel < MIN_CLIP_MS || total - rel < MIN_CLIP_MS) return null;
  const len = c.length_ms;
  const whole = Math.floor(rel / len);
  const partial = rel - whole * len;
  if (partial > 0 && (partial < MIN_CLIP_MS || len - partial < MIN_CLIP_MS)) return null;

  const pieces: CompositionClipDto[] = [];
  if (whole > 0) pieces.push({ ...c, repeats: whole });
  if (partial > 0) pieces.push({ ...c, length_ms: partial, repeats: 1 });
  const right = pieces.length;
  if (partial > 0) pieces.push({ ...c, trim_start_ms: c.trim_start_ms + partial, length_ms: len - partial, repeats: 1 });
  const used = whole + (partial > 0 ? 1 : 0);
  if (c.repeats > used) pieces.push({ ...c, repeats: c.repeats - used });

  let cursor = c.start_ms;
  const clips = pieces.map((k, i) => {
    const placed = { ...k, id: i === 0 ? k.id : newId(), start_ms: cursor };
    cursor = clipEnd(placed);
    return placed;
  });
  return { clips, right };
}

/** A copy of the composition with `track`'s clips sorted, as the backend returns them. */
export function withTrackClips(doc: CompositionDto, track: number, clips: CompositionClipDto[]): CompositionDto {
  const sorted = [...clips].sort((a, b) => a.start_ms - b.start_ms);
  return { ...doc, tracks: doc.tracks.map((t, i) => (i === track ? { ...t, clips: sorted } : t)) };
}

/** Lowest palette colour not used yet by a track (cycling when all are). */
export function nextColor(tracks: readonly CompositionTrackDto[]): number {
  const used = new Set(tracks.map((t) => t.color % TRACK_COLORS.length));
  for (let i = 0; i < TRACK_COLORS.length; i++) if (!used.has(i)) return i;
  return tracks.length % TRACK_COLORS.length;
}

export function newTrack(tracks: readonly CompositionTrackDto[], name: string): CompositionTrackDto {
  return {
    id: newId(),
    name,
    program: 0,
    volume: DEFAULT_VOLUME,
    muted: false,
    solo: false,
    sustain: true,
    color: nextColor(tracks),
    clips: [],
  };
}

// ----------------------------------------------------------------------------------------------
// Tempo
// ----------------------------------------------------------------------------------------------

/** Speed at which a clip of a fragment written at `fragmentBpm` keeps time with a composition at `compositionBpm`. */
export function rateForTempo(compositionBpm: number, fragmentBpm: number): number {
  if (!(compositionBpm > 0) || !(fragmentBpm > 0)) return DEFAULT_RATE_PCT;
  return clamp(Math.round((compositionBpm * 100) / fragmentBpm), MIN_RATE_PCT, MAX_RATE_PCT);
}

/** Moves the clips of a track to the right until none overlaps the one before it. */
export function resolveOverlaps(clips: readonly CompositionClipDto[]): CompositionClipDto[] {
  const sorted = [...clips].sort((a, b) => a.start_ms - b.start_ms);
  let cursor = 0;
  return sorted.map((c) => {
    const placed = c.start_ms < cursor ? { ...c, start_ms: cursor } : c;
    cursor = clipEnd(placed);
    return placed;
  });
}

/**
 * The composition at `bpm`: the clips of scores take the speed that keeps them in time (a score's
 * tempo is exact), and clips that grew push the next ones on their track. Recorded fragments are
 * left alone: their `bpm` is only the metronome setting. `bpm` is bounded to the allowed range.
 */
export function withTempo(doc: CompositionDto, bpm: number): CompositionDto {
  const tempo = clamp(Math.round(bpm), MIN_BPM, MAX_BPM);
  const tracks = doc.tracks.map((t) => {
    if (!t.clips.some((c) => c.fragment_score_id)) return t;
    const clips = t.clips.map((c) => (c.fragment_score_id ? { ...c, rate_pct: rateForTempo(tempo, c.fragment_bpm) } : c));
    return { ...t, clips: resolveOverlaps(clips) };
  });
  return { ...doc, bpm: tempo, tracks };
}

/** Tempo to adopt when a score is added to a composition that has none: the first recorded clip's, if any. */
export function inferTempo(doc: CompositionDto): number | null {
  for (const t of doc.tracks) {
    for (const c of [...t.clips].sort((a, b) => a.start_ms - b.start_ms)) {
      if (!c.fragment_score_id && c.fragment_bpm > 0) return c.fragment_bpm;
    }
  }
  return null;
}

/** The clips in `ids` (all if `null`) at the speed that matches the composition's tempo; `null` without one. */
export function matchTempo(doc: CompositionDto, ids: ReadonlySet<string> | null): CompositionDto | null {
  if (!doc.bpm) return null;
  const bpm = doc.bpm;
  const tracks = doc.tracks.map((t) => {
    if (!t.clips.some((c) => !ids || ids.has(c.id))) return t;
    const clips = t.clips.map((c) => (!ids || ids.has(c.id) ? { ...c, rate_pct: rateForTempo(bpm, c.fragment_bpm) } : c));
    return { ...t, clips: resolveOverlaps(clips) };
  });
  return { ...doc, tracks };
}
