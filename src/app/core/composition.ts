import { clamp } from './format';
import type { CompositionClipDto, CompositionDto, CompositionTrackDto, LibraryFragmentDto, TrackMixDto } from './models';

/** Prefix of a composition's key in the player (`PlaybackProgress.file_path`). */
export const COMPOSITION_KEY_PREFIX = 'composition:';
/** One MIDI channel per track, skipping GM percussion (mirrors `db::COMPOSITION_MAX_TRACKS`). */
export const MAX_TRACKS = 15;
export const MAX_REPEATS = 16;
export const MAX_TRANSPOSE = 24;
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

/** End of the clip on the timeline, repeats included. */
export function clipEnd(c: Pick<CompositionClipDto, 'start_ms' | 'length_ms' | 'repeats'>): number {
  return c.start_ms + c.length_ms * c.repeats;
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

/** A new clip with the whole fragment. */
export function clipFromFragment(f: LibraryFragmentDto, start: number): CompositionClipDto {
  return {
    id: newId(),
    fragment_id: f.id,
    start_ms: Math.max(0, Math.round(start)),
    trim_start_ms: 0,
    length_ms: f.duration_ms,
    repeats: 1,
    transpose: 0,
    fragment_title: f.title,
    fragment_file_path: f.file_path,
    fragment_duration_ms: f.duration_ms,
  };
}

/**
 * Moves one edge of the clip's window by `delta` ms, inside the fragment, keeping at least
 * `MIN_CLIP_MS` and without crossing the neighbours (`span`). With repeats, every repetition
 * changes: the right edge moves `delta × repeats`.
 */
export function trimClip(c: CompositionClipDto, edge: 'start' | 'end', delta: number, span: { min: number; max: number }): CompositionClipDto {
  if (edge === 'start') {
    const lo = Math.max(-c.trim_start_ms, span.min - c.start_ms);
    const d = Math.round(clamp(delta, lo, c.length_ms - MIN_CLIP_MS));
    return { ...c, start_ms: c.start_ms + d, trim_start_ms: c.trim_start_ms + d, length_ms: c.length_ms - d };
  }
  const roomInFragment = c.fragment_duration_ms - c.trim_start_ms - c.length_ms;
  const roomOnTrack = Number.isFinite(span.max) ? Math.floor((span.max - clipEnd(c)) / c.repeats) : Number.POSITIVE_INFINITY;
  const d = Math.round(clamp(delta, MIN_CLIP_MS - c.length_ms, Math.min(roomInFragment, roomOnTrack)));
  return { ...c, length_ms: c.length_ms + d };
}

/** Repeats that fit before the next clip (at least 1, at most `MAX_REPEATS`). */
export function maxRepeats(c: CompositionClipDto, span: { min: number; max: number }): number {
  if (!Number.isFinite(span.max)) return MAX_REPEATS;
  return clamp(Math.floor((span.max - c.start_ms) / c.length_ms), 1, MAX_REPEATS);
}

/**
 * Splits the clip at `at` (timeline ms). Whole repetitions stay together; a repetition cut in
 * the middle becomes two clips. Returns the clips that replace it (the first keeps its id) and
 * the index of the first one after the cut, or null if the cut is too close to an edge.
 */
export function splitClip(c: CompositionClipDto, at: number): { clips: CompositionClipDto[]; right: number } | null {
  const rel = Math.round(at) - c.start_ms;
  if (rel < MIN_CLIP_MS || clipEnd(c) - c.start_ms - rel < MIN_CLIP_MS) return null;
  const len = c.length_ms;
  const whole = Math.floor(rel / len);
  const partial = rel - whole * len;
  if (partial > 0 && (partial < MIN_CLIP_MS || len - partial < MIN_CLIP_MS)) return null;

  const out: CompositionClipDto[] = [];
  if (whole > 0) out.push({ ...c, repeats: whole });
  if (partial > 0) {
    const cutStart = c.start_ms + whole * len;
    out.push({ ...c, start_ms: cutStart, length_ms: partial, repeats: 1 });
  }
  const right = out.length;
  if (partial > 0) {
    out.push({ ...c, start_ms: c.start_ms + rel, trim_start_ms: c.trim_start_ms + partial, length_ms: len - partial, repeats: 1 });
  }
  const used = whole + (partial > 0 ? 1 : 0);
  if (c.repeats > used) out.push({ ...c, start_ms: c.start_ms + used * len, repeats: c.repeats - used });
  return { clips: out.map((k, i) => (i === 0 ? k : { ...k, id: newId() })), right };
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
