import type { AttemptDto, AttemptSummaryDto, NoteDto, NoteStatus } from './models';

/** Same ranges as `challenge.rs`. */
export const TEMPO_MIN = 40;
export const TEMPO_MAX = 150;
export const TEMPO_STEP = 5;
/** Accuracy from which a tempo counts as mastered (and the next one is suggested). */
export const MASTERED_ACCURACY = 0.9;
/** Below this accuracy a slower tempo is suggested. */
const STRUGGLING_ACCURACY = 0.5;
/** Mean offset under which the timing counts as steady. */
const STEADY_OFFSET_MS = 20;

export function clampTempo(pct: number): number {
  const stepped = Math.round(pct / TEMPO_STEP) * TEMPO_STEP;
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, stepped));
}

/** Original time → attempt timeline at `tempoPct`. */
export function scaleMs(ms: number, tempoPct: number): number {
  return (ms * 100) / tempoPct;
}

export function effectiveBpm(bpm: number, tempoPct: number): number {
  return Math.max(1, Math.round((bpm * tempoPct) / 100));
}

/** Best completed attempt (highest score; on a tie, the earliest), optionally at one tempo. */
export function bestAttempt(attempts: readonly AttemptDto[], tempoPct?: number): AttemptDto | null {
  let best: AttemptDto | null = null;
  for (const a of attempts) {
    const s = a.summary;
    if (!s.completed || (tempoPct !== undefined && s.tempo_pct !== tempoPct)) continue;
    if (!best || s.score > best.summary.score || (s.score === best.summary.score && s.created_at < best.summary.created_at)) {
      best = a;
    }
  }
  return best;
}

/** Highest tempo with a completed attempt of at least 90 % accuracy. */
export function masteredTempo(attempts: readonly AttemptDto[]): number | null {
  let top: number | null = null;
  for (const { summary: s } of attempts) {
    if (s.completed && s.accuracy >= MASTERED_ACCURACY && (top === null || s.tempo_pct > top)) top = s.tempo_pct;
  }
  return top;
}

export interface TempoSuggestion {
  tempo: number;
  direction: 'up' | 'down';
}

/** Next tempo to try after an attempt: faster once it is mastered, slower if it was too hard. */
export function suggestedTempo(s: AttemptSummaryDto): TempoSuggestion | null {
  if (!s.completed) return null;
  if (s.accuracy >= MASTERED_ACCURACY && s.tempo_pct < TEMPO_MAX) {
    return { tempo: clampTempo(s.tempo_pct + TEMPO_STEP), direction: 'up' };
  }
  if (s.accuracy < STRUGGLING_ACCURACY && s.tempo_pct > TEMPO_MIN) {
    return { tempo: clampTempo(s.tempo_pct - 2 * TEMPO_STEP), direction: 'down' };
  }
  return null;
}

/**
 * Mean of the last `n` values minus the mean of the `n` before them (fewer if there are not
 * enough: half each). `null` with fewer than two values.
 */
export function trend(values: readonly number[], n = 5): number | null {
  if (values.length < 2) return null;
  const k = Math.min(n, Math.floor(values.length / 2));
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return mean(values.slice(-k)) - mean(values.slice(-2 * k, -k));
}

/** Notes hit among those due up to `atMs` (attempt timeline). `notes` sorted by start. */
export function hitsUpTo(
  notes: readonly NoteDto[],
  statuses: readonly (NoteStatus | null)[],
  tempoPct: number,
  atMs: number,
): number {
  let hits = 0;
  for (let i = 0; i < notes.length; i++) {
    if (scaleMs(notes[i].start_ms, tempoPct) > atMs) break;
    const s = statuses[i];
    if (s === 'perfect' || s === 'good') hits++;
  }
  return hits;
}

/** Completed attempts, oldest first. `attempts` comes newest first, as the backend sends it. */
export function completedChronological(attempts: readonly AttemptDto[]): AttemptDto[] {
  return attempts.filter((a) => a.summary.completed).reverse();
}

/**
 * Fraction of the last `n` completed attempts that missed each note (null if there are none).
 * Attempts whose detail does not match the melody (a different number of notes) are skipped.
 */
export function noteMissRates(noteCount: number, attempts: readonly AttemptDto[], n = 10): number[] | null {
  const recent = attempts.filter((a) => a.summary.completed && a.details.notes.length === noteCount).slice(0, n);
  if (!recent.length) return null;
  const misses = new Array<number>(noteCount).fill(0);
  for (const a of recent) a.details.notes.forEach((o, i) => o.status === 'missed' && misses[i]++);
  return misses.map((m) => m / recent.length);
}

export type MistakeKind = 'missed' | 'wrong' | 'extra';

export interface Mistake {
  /** Attempt timeline. */
  time_ms: number;
  kind: MistakeKind;
  /** The expected note for `missed`, the played one otherwise. */
  key: number;
  /** For `wrong`: the note that was due. */
  expected_key: number | null;
}

/** Every mistake of an attempt (missed notes and played errors), sorted by time. */
export function attemptMistakes(notes: readonly NoteDto[], attempt: AttemptDto): Mistake[] {
  const tempo = attempt.summary.tempo_pct;
  const out: Mistake[] = [];
  attempt.details.notes.forEach((o, i) => {
    const n = notes[i];
    if (o.status === 'missed' && n) out.push({ time_ms: scaleMs(n.start_ms, tempo), kind: 'missed', key: n.key, expected_key: null });
  });
  for (const e of attempt.details.errors) {
    out.push({ time_ms: e.time_ms, kind: e.kind, key: e.played_key, expected_key: e.expected_key });
  }
  return out.sort((a, b) => a.time_ms - b.time_ms);
}

export type TimingTendency = 'early' | 'late' | 'steady';

export function timingTendency(meanOffsetMs: number): TimingTendency {
  if (meanOffsetMs <= -STEADY_OFFSET_MS) return 'early';
  if (meanOffsetMs >= STEADY_OFFSET_MS) return 'late';
  return 'steady';
}

/** Best value so far at each position. */
export function runningMax(values: readonly number[]): number[] {
  let best = -Infinity;
  return values.map((v) => (best = Math.max(best, v)));
}
