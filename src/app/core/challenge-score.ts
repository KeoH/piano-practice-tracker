import type { NoteDto, NoteStatus, ScoreDto } from './models';
import { STAFF_NAMES, msToTicks, pageTick, repeatTick, staffNotes, ticksToMs, tieLinks, tieTarget } from './score';

/*
 * A challenge made from a score shows its notation instead of the piano roll. The melody's notes come
 * from the MIDI the score made (sorted by start and key, the first one at 0); this module finds which
 * notes of the score each of them is, and turns moments of the attempt into places on the staff.
 */

/** A note that is played: a tie chain is one event, and a repeat plays the bars before its sign twice. */
export interface ScoreEvent {
  /** The notes of the score it comes from: the whole tie chain. */
  ids: string[];
  key: number;
  /** Milliseconds from the start of the score. */
  startMs: number;
}

/**
 * What the score plays, sorted the way the melody's notes are (by start, then key). With a repeat sign the
 * notes that start before it are played twice and the rest once, as the MIDI the score makes.
 */
export function scoreEvents(s: ScoreDto): ScoreEvent[] {
  const out: ScoreEvent[] = [];
  const at = repeatTick(s);
  for (const staff of STAFF_NAMES) {
    const notes = staffNotes(s, staff);
    const continued = new Set(tieLinks(notes).map((t) => t.to.id));
    for (const n of notes) {
      if (continued.has(n.id)) continue;
      const ids = [n.id];
      for (let cur = n; cur.tie; ) {
        const next = tieTarget(notes, cur);
        if (!next) break;
        ids.push(next.id);
        cur = next;
      }
      const starts = at === null ? [n.tick] : n.tick < at ? [n.tick, n.tick + at] : [n.tick + at];
      for (const tick of starts) out.push({ ids, key: n.key, startMs: ticksToMs(tick, s.bpm) });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.key - b.key);
}

/** How a score lines up with a melody's notes. */
export interface ScoreMap {
  score: ScoreDto;
  /** For each note of the melody, the notes of the score it is. */
  ids: string[][];
  /** Where the melody's time 0 is on the score's clock (the score may start with a rest or a pickup). */
  leadMs: number;
}

/** Milliseconds the times may differ by (the MIDI is written in whole microseconds, the notes read in whole milliseconds). */
const TOLERANCE_MS = 3;

/**
 * Finds the notes of `score` in the melody's `notes`, or `null` if they are not the same music (a score
 * that changed since, a melody that was edited): then the piano roll is shown instead.
 */
export function mapScoreToMelody(score: ScoreDto | null, notes: readonly NoteDto[]): ScoreMap | null {
  if (!score) return null;
  const events = scoreEvents(score);
  if (!events.length || events.length !== notes.length) return null;
  const leadMs = events[0].startMs - notes[0].start_ms;
  for (let i = 0; i < events.length; i++) {
    if (events[i].key !== notes[i].key) return null;
    if (Math.abs(events[i].startMs - leadMs - notes[i].start_ms) > TOLERANCE_MS) return null;
  }
  return { score, ids: events.map((e) => e.ids), leadMs };
}

const RANK: Record<NoteStatus, number> = { perfect: 1, good: 2, missed: 3 };

/**
 * How each note of the score went, from the states of the melody's notes. A note that is played twice
 * (a repeat) shows the worst of its two passes, so a mistake is not hidden by a better second try.
 */
export function statesById(map: ScoreMap, states: readonly (NoteStatus | null)[]): Record<string, NoteStatus | null> {
  const out: Record<string, NoteStatus | null> = {};
  for (const id of map.ids.flat()) out[id] = null;
  map.ids.forEach((ids, i) => {
    const state = states[i];
    if (!state) return;
    for (const id of ids) {
      const current = out[id];
      if (!current || RANK[state] > RANK[current]) out[id] = state;
    }
  });
  return out;
}

/**
 * Tick of the score that an attempt moment falls on (milliseconds on the attempt's timeline at
 * `tempoPct`), with the second pass of a repeat shown over the first. Before the first note it is the
 * first note's place.
 */
export function attemptTick(map: ScoreMap, attemptMs: number, tempoPct: number): number {
  const scoreMs = (Math.max(0, attemptMs) * tempoPct) / 100 + map.leadMs;
  return pageTick(map.score, msToTicks(scoreMs, map.score.bpm));
}
