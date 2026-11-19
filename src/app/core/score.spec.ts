import type { ScoreDto, ScoreNoteDto } from './models';
import {
  MAX_KEY,
  MIN_KEY,
  barOf,
  barTicks,
  canPlace,
  durationTicks,
  findNote,
  isBlackKey,
  ledgerSteps,
  moveNote,
  msToTicks,
  newScore,
  noteCount,
  notatedValue,
  pitchAt,
  place,
  removeNote,
  resizeBars,
  scoreDurationMs,
  scoreTicks,
  setNoteDuration,
  setTimeSignature,
  shiftStep,
  snapTickInBar,
  barSpans,
  pageTick,
  playTicks,
  toggleRepeat,
  barSpanAt,
  barLabel,
  missingTicks,
  chordDuration,
  isPickup,
  setPickup,
  tieLinks,
  toggleTie,
  staffStep,
  ticksToMs,
  toggleAccidental,
  validateScore,
  withRests,
} from './score';

const Q = 480;
const C4 = 60;
const E4 = 64;
const G4 = 67;
const C2 = 36;

function note(id: string, tick: number, duration: number, key = C4, accidental: ScoreNoteDto['accidental'] = null, tie = false): ScoreNoteDto {
  return { id, tick, duration_ticks: duration, key, accidental, tie };
}

function score(treble: ScoreNoteDto[] = [], bass: ScoreNoteDto[] = [], extra: Partial<ScoreDto> = {}): ScoreDto {
  return { ...newScore('s', 'Test', '2026-01-01T00:00:00Z'), treble, bass, ...extra };
}

describe('pitch and staff position', () => {
  it('puts the treble staff on E4 (bottom line) to F5 (top line)', () => {
    expect(staffStep('treble', E4, null)).toBe(0);
    expect(staffStep('treble', 77, null)).toBe(8); // F5
  });

  it('puts the bass staff on G2 (bottom line) to A3 (top line)', () => {
    expect(staffStep('bass', 43, null)).toBe(0); // G2
    expect(staffStep('bass', 57, null)).toBe(8); // A3
  });

  it('writes middle C on the first ledger line below the treble staff and above the bass staff', () => {
    expect(staffStep('treble', C4, null)).toBe(-2);
    expect(staffStep('bass', C4, null)).toBe(10);
  });

  it('writes a black key on the line of its letter: C♯4 as C4, D♭4 as D4', () => {
    expect(staffStep('treble', 61, 'sharp')).toBe(-2);
    expect(staffStep('treble', 61, 'flat')).toBe(-1);
    expect(staffStep('treble', 70, 'flat')).toBe(staffStep('treble', 71, null)); // B♭4 on the line of B4
  });

  it('defaults a black key without a spelling to a sharp', () => {
    expect(staffStep('treble', 61, null)).toBe(-2);
  });

  it('finds the key written at a step, with its accidental', () => {
    expect(pitchAt('treble', 0, null)).toEqual({ key: E4, accidental: null });
    expect(pitchAt('treble', -2, 'sharp')).toEqual({ key: 61, accidental: 'sharp' });
    expect(pitchAt('treble', -1, 'flat')).toEqual({ key: 61, accidental: 'flat' });
    expect(pitchAt('bass', 10, null)).toEqual({ key: C4, accidental: null });
  });

  it('ignores an accidental the letter cannot take (E♯, B♯, C♭, F♭)', () => {
    expect(pitchAt('treble', 0, 'sharp')).toEqual({ key: E4, accidental: null }); // E
    expect(pitchAt('treble', 4, 'sharp')).toEqual({ key: 71, accidental: null }); // B
    expect(pitchAt('treble', -2, 'flat')).toEqual({ key: C4, accidental: null }); // C
    expect(pitchAt('treble', 1, 'flat')).toEqual({ key: 65, accidental: null }); // F
  });

  it('is outside the piano above C8 and below A0', () => {
    expect(pitchAt('treble', 200, null)).toBeNull();
    expect(pitchAt('bass', -200, null)).toBeNull();
  });

  it('round-trips every key of the piano on both staves', () => {
    for (const staff of ['treble', 'bass'] as const) {
      for (let key = MIN_KEY; key <= MAX_KEY; key++) {
        for (const acc of ['sharp', 'flat'] as const) {
          const step = staffStep(staff, key, acc);
          const back = pitchAt(staff, step, isBlackKey(key) ? acc : null);
          expect(back?.key, `${staff} ${key} ${acc}`).toBe(key);
          expect(staffStep(staff, back!.key, back!.accidental)).toBe(step);
        }
      }
    }
  });

  it('lists the ledger lines a note needs', () => {
    expect(ledgerSteps(0)).toEqual([]);
    expect(ledgerSteps(8)).toEqual([]);
    expect(ledgerSteps(-1)).toEqual([]); // the space under the staff
    expect(ledgerSteps(-2)).toEqual([-2]); // middle C on the treble staff
    expect(ledgerSteps(-3)).toEqual([-2]);
    expect(ledgerSteps(-4)).toEqual([-2, -4]);
    expect(ledgerSteps(9)).toEqual([]);
    expect(ledgerSteps(10)).toEqual([10]); // middle C on the bass staff
    expect(ledgerSteps(11)).toEqual([10]);
    expect(ledgerSteps(12)).toEqual([10, 12]);
  });
});

describe('time', () => {
  it('has the capacity of each bar', () => {
    expect(barTicks({ beats: 4, beat_unit: 4 })).toBe(4 * Q);
    expect(barTicks({ beats: 3, beat_unit: 4 })).toBe(3 * Q);
    expect(barTicks({ beats: 2, beat_unit: 4 })).toBe(2 * Q);
    expect(barTicks({ beats: 6, beat_unit: 8 })).toBe(6 * 240);
  });

  it('gives the length of the score and the bar of a tick', () => {
    const s = score([], [], { bars: 3, beats: 3 });
    expect(scoreTicks(s)).toBe(9 * Q);
    expect(barOf(s, 3 * Q - 1)).toBe(0);
    expect(barOf(s, 3 * Q)).toBe(1);
  });

  it('converts ticks and milliseconds at a tempo', () => {
    expect(ticksToMs(Q, 120)).toBe(500);
    expect(ticksToMs(4 * Q, 60)).toBe(4000);
    expect(msToTicks(500, 120)).toBe(Q);
    expect(scoreDurationMs(score([], [], { bars: 2, bpm: 120 }))).toBe(4000);
  });

  it('names the durations it can write and rejects the rest', () => {
    expect(notatedValue(durationTicks('quarter'))).toMatchObject({ kind: 'quarter', dotted: false });
    expect(notatedValue(durationTicks('half', true))).toMatchObject({ kind: 'half', dotted: true });
    expect(notatedValue(durationTicks('sixteenth', true))).toMatchObject({ kind: 'sixteenth', dotted: true });
    expect(notatedValue(1920)).toMatchObject({ kind: 'whole' });
    expect(notatedValue(2880)).toBeNull(); // dotted whole
    expect(notatedValue(300)).toBeNull();
  });

  it('snaps a tick to the grid of its bar and keeps a note of that length inside it', () => {
    const s = score();
    expect(snapTickInBar(s, 700, Q, Q)).toBe(Q);
    expect(snapTickInBar(s, 730, Q, Q)).toBe(960);
    expect(snapTickInBar(s, -50, Q, Q)).toBe(0);
    expect(snapTickInBar(s, 99_999, Q, Q)).toBe(7200); // the last quarter of the last bar
    expect(snapTickInBar(s, 1900, Q, 2 * Q)).toBe(2 * Q); // a half note starting at beat 4 would cross: it goes back to beat 3
  });

  it('counts the grid from the start of each bar, so a dotted half note reaches every 3/4 bar', () => {
    const s = score([], [], { beats: 3, bars: 4 });
    const grid = 2 * Q; // a half note snaps to 960 ticks, which is not a divisor of the 1440-tick bar
    for (const bar of [0, 1, 2, 3]) {
      const start = bar * 3 * Q;
      const snapped = snapTickInBar(s, start + 20, grid, 3 * Q);
      expect(snapped).toBe(start);
      expect(canPlace(s, 'treble', snapped, durationTicks('half', true))).toBe(true);
    }
    // Between the bars the nearest bar start wins, and a note that cannot fit later stays at the start.
    expect(snapTickInBar(s, 3 * Q + 900, grid, 3 * Q)).toBe(3 * Q);
  });
});

describe('placing notes', () => {
  it('fills a 4/4 bar exactly and rejects a fifth quarter', () => {
    let s = score();
    for (let i = 0; i < 4; i++) {
      s = place(s, 'treble', note(`n${i}`, i * Q, Q))!;
      expect(s).not.toBeNull();
    }
    expect(place(s, 'treble', note('x', 0, Q))).toBeNull(); // on top of the first
    expect(canPlace(s, 'treble', 4 * Q, 4 * Q)).toBe(true); // the next bar is free
    expect(place(s, 'treble', note('y', 4 * Q, Q))).not.toBeNull();
  });

  it('holds 3 quarters in 3/4 and rejects a half note that would cross the bar line', () => {
    const s = score([], [], { beats: 3 });
    expect(place(s, 'treble', note('a', 2 * Q, 2 * Q))).toBeNull(); // would end in the next bar
    expect(place(s, 'treble', note('b', Q, 2 * Q))).not.toBeNull();
    expect(place(s, 'treble', note('c', 0, durationTicks('half', true)))).not.toBeNull(); // dotted half = the bar
  });

  it('holds 2 quarters in 2/4', () => {
    const s = score([], [], { beats: 2 });
    expect(canPlace(s, 'treble', 0, 2 * Q)).toBe(true);
    expect(canPlace(s, 'treble', Q, 2 * Q)).toBe(false);
    expect(canPlace(s, 'treble', 0, 4 * Q)).toBe(false);
  });

  it('fits a note between its neighbours and inside its bar, hand by hand', () => {
    const s = score([note('a', 2 * Q, Q)]);
    expect(canPlace(s, 'treble', 0, 2 * Q)).toBe(true); // up to the next note
    expect(canPlace(s, 'treble', Q, 2 * Q)).toBe(false);
    expect(canPlace(s, 'treble', 3 * Q, Q)).toBe(true);
    expect(canPlace(s, 'treble', 3 * Q, 2 * Q)).toBe(false); // would cross the bar line
    expect(canPlace(s, 'bass', 2 * Q, 2 * Q)).toBe(true); // the other hand is independent
    expect(canPlace(s, 'treble', 99 * 1920, Q)).toBe(false);
    expect(canPlace(s, 'treble', -1, Q)).toBe(false);
  });

  it('rejects durations that are not a note value and keys outside the piano', () => {
    const s = score();
    expect(place(s, 'treble', note('a', 0, 300))).toBeNull();
    expect(place(s, 'treble', note('a', 0, Q, MIN_KEY - 1))).toBeNull();
    expect(place(s, 'treble', note('a', 0, Q, MAX_KEY + 1))).toBeNull();
  });

  it('gives a black key its accidental and a white key none', () => {
    const s = place(place(score(), 'treble', note('a', 0, Q, 61, null))!, 'treble', note('b', Q, Q, E4, 'flat'))!;
    expect(findNote(s, 'a')!.note.accidental).toBe('sharp');
    expect(findNote(s, 'b')!.note.accidental).toBeNull();
  });

  it('keeps the notes of a staff sorted and does not mutate the original', () => {
    const s0 = score();
    const s1 = place(s0, 'treble', note('late', 2 * Q, Q))!;
    const s2 = place(s1, 'treble', note('early', 0, Q))!;
    expect(s2.treble.map((n) => n.id)).toEqual(['early', 'late']);
    expect(s0.treble).toEqual([]);
    expect(s1.treble).toHaveLength(1);
    expect(noteCount(s2)).toBe(2);
  });
});

describe('editing notes', () => {
  const base = () => score([note('a', 0, Q), note('b', Q, Q, E4)], [note('c', 0, 2 * Q, C2)]);

  it('removes a note and returns null for an unknown one', () => {
    expect(removeNote(base(), 'a')!.treble.map((n) => n.id)).toEqual(['b']);
    expect(removeNote(base(), 'zzz')).toBeNull();
  });

  it('moves a note in time and refuses an occupied or crossing position', () => {
    expect(moveNote(base(), 'a', { tick: 2 * Q })!.treble.map((n) => n.tick)).toEqual([Q, 2 * Q]);
    expect(moveNote(base(), 'a', { tick: 3 * Q + 1 })).toBeNull(); // crosses the bar line
    // Onto a note of another value it is in the way; onto one of the same value it becomes a chord.
    const longer = setNoteDuration(base(), 'b', 2 * Q)!;
    expect(moveNote(longer, 'a', { tick: Q })).toBeNull();
    expect(moveNote(base(), 'a', { tick: Q })!.treble.map((n) => n.tick)).toEqual([Q, Q]);
  });

  it('lets a note stay where it is (it does not collide with itself)', () => {
    expect(moveNote(base(), 'a', { tick: 0 })).not.toBeNull();
  });

  it('moves a note to the other hand keeping its pitch and length', () => {
    const s = moveNote(base(), 'b', { staff: 'bass', tick: 2 * Q })!;
    expect(s.treble.map((n) => n.id)).toEqual(['a']);
    expect(s.bass.map((n) => n.id)).toEqual(['c', 'b']);
    expect(findNote(s, 'b')!.note).toMatchObject({ key: E4, duration_ticks: Q });
    expect(moveNote(base(), 'b', { staff: 'bass', tick: Q })).toBeNull(); // c lasts until 2Q
  });

  it('changes the pitch and normalizes the accidental', () => {
    const s = moveNote(base(), 'a', { pitch: { key: 61, accidental: 'flat' } })!;
    expect(findNote(s, 'a')!.note).toMatchObject({ key: 61, accidental: 'flat' });
    const white = moveNote(s, 'a', { pitch: { key: G4, accidental: 'sharp' } })!;
    expect(findNote(white, 'a')!.note.accidental).toBeNull();
    expect(moveNote(base(), 'a', { pitch: { key: 5, accidental: null } })).toBeNull();
  });

  it('changes the value of a note as far as there is room', () => {
    expect(setNoteDuration(base(), 'b', 2 * Q)).not.toBeNull();
    expect(setNoteDuration(base(), 'b', durationTicks('half', true))).not.toBeNull(); // a dotted half fills the bar from beat 2
    expect(setNoteDuration(base(), 'b', 4 * Q)).toBeNull(); // a whole note would pass the bar line
    expect(setNoteDuration(base(), 'a', 2 * Q)).toBeNull(); // over b
    expect(setNoteDuration(base(), 'a', 300)).toBeNull();
  });

  it('shifts a note by lines and spaces with the arrow keys', () => {
    const up = shiftStep(base(), 'b', 1)!; // E4 → F4
    expect(findNote(up, 'b')!.note.key).toBe(65);
    const down = shiftStep(base(), 'b', -1)!; // E4 → D4
    expect(findNote(down, 'b')!.note.key).toBe(62);
    expect(shiftStep(base(), 'b', 500)).toBeNull();
  });

  it('keeps the accidental while shifting when the new letter can take it', () => {
    const s = score([note('a', 0, Q, 61, 'sharp')]); // C♯4
    expect(findNote(shiftStep(s, 'a', 1)!, 'a')!.note).toMatchObject({ key: 63, accidental: 'sharp' }); // D♯4
    const e = score([note('a', 0, Q, 63, 'sharp')]); // D♯4 → E: no E♯
    expect(findNote(shiftStep(e, 'a', 1)!, 'a')!.note).toMatchObject({ key: E4, accidental: null });
  });

  it('toggles an accidental without moving the note on the staff', () => {
    const s = score([note('a', 0, Q, C4)]);
    const sharp = toggleAccidental(s, 'a', 'sharp')!;
    expect(findNote(sharp, 'a')!.note).toMatchObject({ key: 61, accidental: 'sharp' });
    expect(staffStep('treble', 61, 'sharp')).toBe(staffStep('treble', C4, null));
    expect(findNote(toggleAccidental(sharp, 'a', 'sharp')!, 'a')!.note).toMatchObject({ key: C4, accidental: null });
    expect(toggleAccidental(s, 'a', 'flat')).toBeNull(); // no C♭
    expect(toggleAccidental(score([note('a', 0, Q, E4)]), 'a', 'sharp')).toBeNull(); // no E♯
  });
});

describe('bars and time signature', () => {
  it('adds bars and refuses to cut a note off', () => {
    const s = score([note('a', 9 * Q, Q)]); // in the third bar
    expect(resizeBars(s, 8)!.bars).toBe(8);
    expect(resizeBars(s, 2)).toBeNull();
    expect(resizeBars(s, 3)!.bars).toBe(3);
    expect(resizeBars(s, 0)).toBeNull();
    expect(resizeBars(s, 65)).toBeNull();
  });

  it('changes the time signature when every note still fits in a bar', () => {
    const s = score([note('a', 0, 2 * Q), note('b', 2 * Q, Q)]);
    expect(setTimeSignature(s, 3, 4)).toMatchObject({ beats: 3 });
    const wide = score([note('a', 2 * Q, 2 * Q)]);
    expect(setTimeSignature(wide, 3, 4)).toBeNull(); // ends past the 3/4 bar line
    expect(setTimeSignature(s, 13, 4)).toBeNull();
    expect(setTimeSignature(s, 4, 3)).toBeNull();
  });
});

describe('rests', () => {
  const rests = (s: ScoreDto, staff: 'treble' | 'bass' = 'treble') =>
    withRests(s, staff).map((i) => (i.kind === 'rest' ? `r${i.tick}:${i.duration_ticks}` : `n${i.note.tick}`));

  it('is one bar rest per empty bar', () => {
    expect(rests(score([], [], { bars: 2 }))).toEqual(['r0:1920', 'r1920:1920']);
    expect(rests(score([], [], { bars: 1, beats: 3 }))).toEqual(['r0:1440']); // a whole rest in 3/4
  });

  it('fills the gaps before, between and after the notes', () => {
    const s = score([note('a', Q, Q), note('b', 3 * Q, Q)], [], { bars: 1 });
    expect(rests(s)).toEqual(['r0:480', 'n480', 'r960:480', 'n1440']);
  });

  it('writes the rest after a note on its own multiple, so it never crosses a half bar badly', () => {
    const s = score([note('a', 0, Q)], [], { bars: 1 });
    expect(rests(s)).toEqual(['n0', 'r480:480', 'r960:960']); // quarter + half, not a dotted half
  });

  it('starts a half rest on beat 1 or 3 only', () => {
    const s = score([note('a', 0, Q)], [], { bars: 1, beats: 4 });
    const half = withRests(s, 'treble').find((i) => i.kind === 'rest' && i.duration_ticks === 2 * Q);
    expect(half && half.kind === 'rest' && half.tick % (2 * Q)).toBe(0);
  });

  it('covers every tick of every bar exactly once', () => {
    const s = score([note('a', 120, 240), note('b', 1080, 120), note('c', 2000, 360, G4)], [], { bars: 3 });
    expect(validateScore(s)).toEqual([]);
    let at = 0;
    for (const item of withRests(s, 'treble')) {
      const tick = item.kind === 'note' ? item.note.tick : item.tick;
      const len = item.kind === 'note' ? item.note.duration_ticks : item.duration_ticks;
      expect(tick).toBe(at);
      at = tick + len;
    }
    expect(at).toBe(scoreTicks(s));
  });
});

describe('validation', () => {
  const codes = (s: ScoreDto) => validateScore(s).map((i) => i.code);

  it('accepts a good score and an empty one', () => {
    expect(codes(score())).toEqual([]);
    expect(codes(score([note('a', 0, Q), note('b', Q, Q, 61, 'flat')], [note('c', 0, 4 * Q, C2)]))).toEqual([]);
  });

  it('reports each kind of problem', () => {
    expect(codes(score([], [], { bpm: 10 }))).toContain('bpm');
    expect(codes(score([], [], { beat_unit: 3 }))).toContain('timeSignature');
    expect(codes(score([], [], { bars: 0 }))).toContain('bars');
    expect(codes(score([note('a', 0, Q), note('a', Q, Q)]))).toContain('duplicateId');
    expect(codes(score([note('a', 0, Q, 5)]))).toContain('key');
    expect(codes(score([note('a', 0, Q, 61, null)]))).toContain('accidental');
    expect(codes(score([note('a', 0, Q, E4, 'sharp')]))).toContain('accidental');
    expect(codes(score([note('a', 0, 300)]))).toContain('duration');
    expect(codes(score([note('a', 99 * 1920, Q)]))).toContain('tick');
    expect(codes(score([note('a', 3 * Q, 2 * Q)]))).toContain('crossesBar');
    expect(codes(score([note('a', 0, 2 * Q), note('b', Q, Q)]))).toContain('overlap');
  });

  it('names the staff and the note', () => {
    expect(validateScore(score([], [note('x', 0, 2 * Q, C2), note('y', Q, Q, C2)]))).toEqual([{ code: 'overlap', staff: 'bass', noteId: 'y' }]);
  });

  it('lets the same tick hold one note per hand', () => {
    expect(codes(score([note('a', 0, Q)], [note('b', 0, Q, C2)]))).toEqual([]);
  });
});

describe('chords', () => {
  it('puts several notes of the same value on one tick', () => {
    let s = score();
    s = place(s, 'treble', note('a', 0, Q, 60))!;
    s = place(s, 'treble', note('b', 0, Q, 64))!;
    s = place(s, 'treble', note('c', 0, Q, 67))!;
    expect(s.treble.map((n) => n.key)).toEqual([60, 64, 67]);
    expect(validateScore(s)).toEqual([]);
    expect(chordDuration(s, 'treble', 0)).toBe(Q);
    expect(chordDuration(s, 'treble', Q)).toBeNull();
  });

  it('refuses the same key twice, another value on the same tick and a note inside the chord', () => {
    const s = place(note('a', 0, 2 * Q, 60) && score(), 'treble', note('a', 0, 2 * Q, 60))!;
    expect(place(s, 'treble', note('b', 0, 2 * Q, 60))).toBeNull(); // the same key
    expect(place(s, 'treble', note('b', 0, Q, 64))).toBeNull(); // another value
    expect(place(s, 'treble', note('b', Q, Q, 64))).toBeNull(); // inside it
    expect(canPlace(s, 'treble', 0, 2 * Q)).toBe(true); // a chord mate of any key fits
  });

  it('keeps a chord to one value: changing one note changes them all, or none', () => {
    let s = place(score(), 'treble', note('a', 0, Q, 60))!;
    s = place(s, 'treble', note('b', 0, Q, 64))!;
    const longer = setNoteDuration(s, 'a', 2 * Q)!;
    expect(longer.treble.map((n) => n.duration_ticks)).toEqual([2 * Q, 2 * Q]);
    const blocked = place(s, 'treble', note('c', Q, Q, 67))!;
    expect(setNoteDuration(blocked, 'a', 2 * Q)).toBeNull();
  });

  it('moves a note into a chord of the same value only', () => {
    let s = place(score(), 'treble', note('a', 0, Q, 60))!;
    s = place(s, 'bass', note('b', 0, Q, 48))!;
    expect(moveNote(s, 'b', { staff: 'treble' })).not.toBeNull(); // same value, another key: joins the chord
    s = place(s, 'bass', note('c', Q, 2 * Q, 52))!;
    expect(moveNote(s, 'c', { staff: 'treble', tick: 0 })).toBeNull();
    expect(moveNote(s, 'b', { pitch: { key: 60, accidental: null }, staff: 'treble' })).toBeNull(); // the same key
  });

  it('is not a gap: the rests around a chord are those around one note', () => {
    const s = place(place(score([], [], { bars: 1 }), 'treble', note('a', Q, Q, 60))!, 'treble', note('b', Q, Q, 64))!;
    const items = withRests(s, 'treble').map((i) => (i.kind === 'rest' ? `r${i.tick}` : `n${i.note.tick}`));
    expect(items).toEqual(['r0', 'n480', 'n480', 'r960']);
  });
});

describe('ties', () => {
  it('ties a note to the next one of the same key and unties it', () => {
    let s = score([note('a', 0, Q, 60), note('b', Q, Q, 60)]);
    s = toggleTie(s, 'a', 'new')!;
    expect(s.treble[0].tie).toBe(true);
    expect(tieLinks(s.treble).map((t) => [t.from.id, t.to.id])).toEqual([['a', 'b']]);
    expect(validateScore(s)).toEqual([]);
    s = toggleTie(s, 'a', 'new')!;
    expect(s.treble[0].tie).toBe(false);
  });

  it('adds the note it ties to when it is not there, even in the next bar', () => {
    const s = score([note('a', 3 * Q, Q, 60)]);
    const tied = toggleTie(s, 'a', 'next')!;
    expect(tied.treble.map((n) => [n.id, n.tick, n.duration_ticks, n.tie])).toEqual([
      ['a', 3 * Q, Q, true],
      ['next', 4 * Q, Q, false], // the first beat of the next bar
    ]);
    expect(validateScore(tied)).toEqual([]);
  });

  it('refuses when the next note cannot go there', () => {
    expect(toggleTie(score([note('a', 3 * Q, Q, 60), note('b', 4 * Q, 2 * Q, 62)]), 'a', 'n')).toBeNull(); // a note of another value is there
    expect(toggleTie(score([note('a', 7 * Q, Q, 60)], [], { bars: 2 }), 'a', 'n')).toBeNull(); // the score ends
  });

  it('breaks when either note moves, changes or goes', () => {
    const tied = (): ScoreDto => score([note('a', 0, Q, 60, null, true), note('b', Q, Q, 60)]);
    expect(removeNote(tied(), 'b')!.treble[0].tie).toBe(false);
    expect(moveNote(tied(), 'b', { pitch: { key: 62, accidental: null } })!.treble[0].tie).toBe(false);
    expect(moveNote(tied(), 'b', { tick: 2 * Q })!.treble[0].tie).toBe(false);
    expect(setNoteDuration(tied(), 'a', 2 * Q)).toBeNull(); // it would run over b
    expect(shiftStep(tied(), 'a', 1)!.treble[0].tie).toBe(false);
  });

  it('keeps a tie over a bar line, and ties each key of a chord', () => {
    const s = score([
      note('a', 3 * Q, Q, 60, null, true),
      note('b', 3 * Q, Q, 64, null, true),
      note('c', 4 * Q, Q, 60),
      note('d', 4 * Q, Q, 64),
    ]);
    expect(tieLinks(s.treble)).toHaveLength(2);
    expect(validateScore(s)).toEqual([]);
  });

  it('reports a tie with nothing to join', () => {
    expect(validateScore(score([note('a', 0, Q, 60, null, true)])).map((i) => i.code)).toEqual(['tie']);
  });
});

describe('pickup bar', () => {
  /** 4/4, one beat of pickup, three bars: [0, 480), [480, 2400), [2400, 4320). */
  const pickup = (extra: Partial<ScoreDto> = {}) => score([], [], { bars: 3, pickup_ticks: Q, ...extra });

  it('is the end of a bar, so the score is shorter by what the first bar lacks', () => {
    const s = pickup();
    expect(missingTicks(s)).toBe(3 * Q);
    expect(scoreTicks(s)).toBe(Q + 2 * 4 * Q);
    expect(barSpans(s).map((b) => [b.start, b.end, b.virtualStart])).toEqual([
      [0, Q, -3 * Q],
      [Q, 5 * Q, Q],
      [5 * Q, 9 * Q, 5 * Q],
    ]);
    expect(barOf(s, Q - 1)).toBe(0);
    expect(barOf(s, Q)).toBe(1);
    expect(barSpanAt(s, 99_999)).toBeNull();
    expect(scoreDurationMs({ ...s, bpm: 120 })).toBe(4500);
  });

  it('numbers the whole bars from 1 and gives the pickup none', () => {
    expect([0, 1, 2].map((i) => barLabel(pickup(), i))).toEqual([null, 1, 2]);
    expect([0, 1].map((i) => barLabel(score(), i))).toEqual([1, 2]);
  });

  it('holds only what fits in the short bar, and notes may not cross its bar line', () => {
    const s = pickup();
    expect(canPlace(s, 'treble', 0, Q)).toBe(true);
    expect(canPlace(s, 'treble', 0, 2 * Q)).toBe(false);
    expect(canPlace(s, 'treble', Q, 4 * Q)).toBe(true); // a whole note: the first whole bar
    expect(canPlace(s, 'treble', 4 * Q, 2 * Q)).toBe(false); // it would cross the next bar line
  });

  it('counts beats from where a whole bar would start (rests align to them)', () => {
    const s = pickup({ treble: [note('a', 0, Q, 60)] });
    expect(withRests(s, 'treble').slice(0, 3).map((i) => (i.kind === 'rest' ? `r${i.tick}:${i.duration_ticks}` : `n${i.note.tick}`))).toEqual([
      'n0',
      `r${Q}:${4 * Q}`, // an empty whole bar is one bar rest
      `r${5 * Q}:${4 * Q}`,
    ]);
    const half = pickup({ treble: [note('a', 5 * Q, Q, 60)] });
    // In the last bar a quarter note on beat 1 leaves a quarter rest and a half rest, as in any 4/4 bar.
    expect(withRests(half, 'treble').filter((i) => i.kind === 'rest' && i.tick > 5 * Q).map((i) => (i.kind === 'rest' ? i.duration_ticks : 0))).toEqual([Q, 2 * Q]);
  });

  it('snaps to the beats of the pickup as in a whole bar', () => {
    const s = pickup();
    expect(snapTickInBar(s, 40, Q, Q)).toBe(0); // the last beat of its bar
    expect(snapTickInBar(s, Q + 500, Q, Q)).toBe(2 * Q);
    // An eighth-note pickup starts half a beat from a beat line.
    const eighth = score([], [], { bars: 2, pickup_ticks: 240 });
    expect(snapTickInBar(eighth, 100, 240, 240)).toBe(0);
  });

  it('is chosen only when the notes still fit the new bar lines', () => {
    expect(isPickup(score(), 0)).toBe(true);
    expect(isPickup(score(), Q)).toBe(true);
    expect(isPickup(score(), 4 * Q)).toBe(false);
    expect(isPickup(score(), 100)).toBe(false);
    expect(setPickup(score([note('a', 0, Q, 60)]), Q)).not.toBeNull();
    expect(setPickup(score([note('a', 0, 2 * Q, 60)]), Q)).toBeNull(); // the pickup bar would cut it
    expect(setPickup(pickup(), 0)!.pickup_ticks).toBe(0);
  });

  it('is dropped when the time signature gets shorter than it', () => {
    expect(setTimeSignature(pickup({ pickup_ticks: 3 * Q }), 2, 4)!.pickup_ticks).toBe(0);
    expect(setTimeSignature(pickup(), 3, 4)!.pickup_ticks).toBe(Q);
  });

  it('validates the pickup', () => {
    expect(validateScore(pickup({ pickup_ticks: 4 * Q })).map((i) => i.code)).toContain('pickup');
    expect(validateScore(pickup({ pickup_ticks: 100 })).map((i) => i.code)).toContain('pickup');
    expect(validateScore(pickup())).toEqual([]);
  });
});

describe('repeat sign', () => {
  it('plays the score twice: it doubles the length of what is played but not the score', () => {
    const once = score([], [], { bars: 2, bpm: 120 });
    const twice = toggleRepeat(once);
    expect(twice.repeat).toBe(true);
    expect(scoreTicks(twice)).toBe(scoreTicks(once));
    expect(playTicks(once)).toBe(8 * Q);
    expect(playTicks(twice)).toBe(16 * Q);
    expect(scoreDurationMs(once)).toBe(4000);
    expect(scoreDurationMs(twice)).toBe(8000);
    expect(toggleRepeat(twice).repeat).toBe(false);
  });

  it('shows the second pass over the first one on the page', () => {
    const s = score([], [], { bars: 2, repeat: true });
    expect(pageTick(s, 100)).toBe(100);
    expect(pageTick(s, 8 * Q)).toBe(0); // the repeat starts over
    expect(pageTick(s, 9 * Q)).toBe(Q);
    expect(pageTick({ ...s, repeat: false }, 9 * Q)).toBe(9 * Q);
  });

  it('is valid with or without notes, and leaves the notes alone', () => {
    const s = toggleRepeat(score([note('a', 0, Q, 60)]));
    expect(validateScore(s)).toEqual([]);
    expect(s.treble).toHaveLength(1);
  });
});
