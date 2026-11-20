import { attemptTick, mapScoreToMelody, scoreEvents, statesById } from './challenge-score';
import type { NoteDto, ScoreDto, ScoreNoteDto } from './models';
import { newScore } from './score';

const Q = 480;
const n = (id: string, tick: number, duration: number, key: number, tie = false): ScoreNoteDto => ({
  id,
  tick,
  duration_ticks: duration,
  key,
  accidental: null,
  tie,
});
const score = (treble: ScoreNoteDto[], bass: ScoreNoteDto[] = [], extra: Partial<ScoreDto> = {}): ScoreDto => ({
  ...newScore('s', 'S', ''),
  bpm: 120, // a quarter note is 500 ms
  bars: 2,
  treble,
  bass,
  ...extra,
});

/** The notes of the melody the backend would extract from a score: sorted, the first one at 0. */
function melodyOf(s: ScoreDto): NoteDto[] {
  const events = scoreEvents(s);
  const lead = events[0].startMs;
  return events.map((e) => ({ key: e.key, start_ms: Math.round(e.startMs - lead), end_ms: Math.round(e.startMs - lead) + 100, velocity: 80 }));
}

describe('scoreEvents', () => {
  it('lists the notes that are played, both hands, sorted by start and key', () => {
    const s = score([n('a', 0, Q, 64), n('b', Q, Q, 67)], [n('c', 0, 2 * Q, 48), n('d', Q, Q, 55)]);
    expect(scoreEvents(s).map((e) => [e.ids[0], e.startMs, e.key])).toEqual([
      ['c', 0, 48],
      ['a', 0, 64],
      ['d', 500, 55],
      ['b', 500, 67],
    ]);
  });

  it('plays a chain of tied notes as one note, with all its ids', () => {
    const s = score([n('a', 3 * Q, Q, 60, true), n('b', 4 * Q, Q, 60, true), n('c', 5 * Q, Q, 60), n('d', 6 * Q, Q, 62)]);
    expect(scoreEvents(s).map((e) => [e.ids, e.startMs])).toEqual([
      [['a', 'b', 'c'], 1500],
      [['d'], 3000],
    ]);
  });

  it('plays the score twice when it repeats, the second pass after the first', () => {
    const s = score([n('a', 0, Q, 60), n('b', Q, Q, 62)], [], { repeat: true });
    // Two 4/4 bars at 120 BPM last 4000 ms.
    expect(scoreEvents(s).map((e) => [e.ids[0], e.startMs])).toEqual([
      ['a', 0],
      ['b', 500],
      ['a', 4000],
      ['b', 4500],
    ]);
  });
});

describe('mapScoreToMelody', () => {
  it('finds which notes of the score each note of the melody is', () => {
    const s = score([n('a', 0, Q, 64), n('b', Q, Q, 67, true), n('c', 2 * Q, Q, 67)]);
    const map = mapScoreToMelody(s, melodyOf(s))!;
    expect(map.ids).toEqual([['a'], ['b', 'c']]);
    expect(map.leadMs).toBe(0);
  });

  it('allows for a score that starts with a rest or a pickup: the melody starts at its first note', () => {
    const s = score([n('a', 2 * Q, Q, 64), n('b', 3 * Q, Q, 67)]);
    const map = mapScoreToMelody(s, melodyOf(s))!;
    expect(map.leadMs).toBe(1000);
    expect(map.ids).toEqual([['a'], ['b']]);
  });

  it('maps a repeat to the same notes of the score twice', () => {
    const s = score([n('a', 0, Q, 60), n('b', Q, Q, 62)], [], { repeat: true });
    expect(mapScoreToMelody(s, melodyOf(s))!.ids).toEqual([['a'], ['b'], ['a'], ['b']]);
  });

  it('tolerates the rounding of the MIDI, but not a different melody', () => {
    const s = score([n('a', 0, Q, 60), n('b', Q, Q, 62)]);
    const notes = melodyOf(s);
    expect(mapScoreToMelody(s, notes.map((x) => ({ ...x, start_ms: x.start_ms + 2 })))).not.toBeNull();
    expect(mapScoreToMelody(s, notes.map((x, i) => ({ ...x, start_ms: x.start_ms + (i ? 40 : 0) })))).toBeNull(); // another rhythm
    expect(mapScoreToMelody(s, [{ ...notes[0], key: 61 }, notes[1]])).toBeNull(); // another pitch
    expect(mapScoreToMelody(s, notes.slice(0, 1))).toBeNull(); // another length
    expect(mapScoreToMelody(s, [...notes, notes[1]])).toBeNull();
  });

  it('has nothing to map without a score or with an empty one', () => {
    expect(mapScoreToMelody(null, [])).toBeNull();
    expect(mapScoreToMelody(score([]), [])).toBeNull();
  });
});

describe('statesById', () => {
  const map = (s: ScoreDto) => mapScoreToMelody(s, melodyOf(s))!;

  it('gives every note of a tie chain the state of the note that is played', () => {
    const s = score([n('a', 0, Q, 60, true), n('b', Q, Q, 60), n('c', 2 * Q, Q, 62)]);
    expect(statesById(map(s), ['good', 'missed'])).toEqual({ a: 'good', b: 'good', c: 'missed' });
  });

  it('leaves the notes that were not played yet empty', () => {
    const s = score([n('a', 0, Q, 60), n('b', Q, Q, 62)]);
    expect(statesById(map(s), ['perfect', null])).toEqual({ a: 'perfect', b: null });
    expect(statesById(map(s), [])).toEqual({ a: null, b: null });
  });

  it('shows the worst of the two passes of a repeat, so a mistake is not hidden', () => {
    const s = score([n('a', 0, Q, 60)], [], { repeat: true });
    expect(statesById(map(s), ['missed', 'perfect'])).toEqual({ a: 'missed' });
    expect(statesById(map(s), ['perfect', 'good'])).toEqual({ a: 'good' });
    expect(statesById(map(s), ['perfect', null])).toEqual({ a: 'perfect' });
  });
});

describe('attemptTick', () => {
  it('turns a moment of the attempt into a tick of the score at the chosen tempo', () => {
    const s = score([n('a', 0, Q, 60), n('b', Q, Q, 62)]);
    const m = mapScoreToMelody(s, melodyOf(s))!;
    expect(attemptTick(m, 0, 100)).toBe(0);
    expect(attemptTick(m, 500, 100)).toBe(Q);
    expect(attemptTick(m, 1000, 50)).toBe(Q); // at 50 % the beat takes twice as long
    expect(attemptTick(m, 250, 200)).toBe(Q);
  });

  it('waits on the first note during the count-in', () => {
    const s = score([n('a', 2 * Q, Q, 60), n('b', 3 * Q, Q, 62)]);
    const m = mapScoreToMelody(s, melodyOf(s))!;
    expect(attemptTick(m, -1500, 100)).toBe(2 * Q);
    expect(attemptTick(m, 500, 100)).toBe(3 * Q);
  });

  it('shows the second pass of a repeat over the first', () => {
    const s = score([n('a', 0, Q, 60)], [], { repeat: true });
    const m = mapScoreToMelody(s, melodyOf(s))!;
    expect(attemptTick(m, 4000, 100)).toBe(0);
    expect(attemptTick(m, 4500, 100)).toBe(Q);
  });
});
