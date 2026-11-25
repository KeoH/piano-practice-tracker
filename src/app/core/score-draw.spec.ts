import type { ScoreDto, ScoreNoteDto } from './models';
import { clefOrigin, drawNotes, drawRests, drawSlurs, drawTies, systemViews } from './score-draw';
import { layoutOf } from './score-layout';
import { newScore } from './score';

let seq = 0;
function n(tick: number, dur: number, key: number, extra: Partial<ScoreNoteDto> = {}): ScoreNoteDto {
  return { id: `n${++seq}`, tick, duration_ticks: dur, key, accidental: null, tie: false, ...extra };
}

function score(over: Partial<ScoreDto>): ScoreDto {
  return { ...newScore('s', 'Test', '2026-01-01'), bars: 2, ...over };
}

function draw(s: ScoreDto, ppq = 120) {
  const l = layoutOf(s, ppq);
  return { l, ...drawNotes(s, l) };
}

const E = 240; // an eighth
const S = 120; // a sixteenth
const Q = 480;

describe('beams', () => {
  it('joins two eighths of one beat and takes their flags away', () => {
    const a = n(0, E, 76);
    const b = n(E, E, 77);
    const { notes, beams } = draw(score({ treble: [a, b] }));
    expect(beams.length).toBe(1);
    expect(beams[0].ids).toEqual([a.id, b.id]);
    expect(notes.every((x) => x.beamed && x.flags === 0 && x.hasStem)).toBe(true);
  });

  it('makes the stems of a group point the same way and end on the beam', () => {
    const a = n(0, E, 84); // high
    const b = n(E, E, 64); // low
    const { notes, beams } = draw(score({ treble: [a, b] }));
    const [first, second] = [notes.find((x) => x.id === a.id)!, notes.find((x) => x.id === b.id)!];
    expect(first.up).toBe(second.up);
    const beam = beams[0];
    const slope = (beam.y2 - beam.y1) / (beam.x2 - beam.x1);
    const centre = (x: number) => beam.y1 + slope * (x - beam.x1);
    const dir = first.up ? 1 : -1;
    // The stem tip is the outer edge of the beam: half a beam above (or below) its centre line.
    expect(first.stemEnd).toBeCloseTo(centre(first.stemX) - dir * (beam.width / 2), 3);
    expect(second.stemEnd).toBeCloseTo(centre(second.stemX) - dir * (beam.width / 2), 3);
  });

  it('keeps every stem at a playable length and the slope gentle', () => {
    const notes = [n(0, E, 60), n(E, E, 88)];
    const { notes: drawn, beams } = draw(score({ treble: notes }));
    const slope = Math.abs((beams[0].y2 - beams[0].y1) / (beams[0].x2 - beams[0].x1));
    expect(slope).toBeLessThanOrEqual(0.15 + 1e-9);
    for (const d of drawn) expect(Math.abs(d.stemBase - d.stemEnd)).toBeGreaterThanOrEqual(26);
  });

  it('does not join eighths of different beats', () => {
    const { notes, beams } = draw(score({ treble: [n(E, E, 76), n(Q, E, 77)] }));
    expect(beams).toEqual([]);
    expect(notes.every((x) => !x.beamed && x.flags === 1)).toBe(true);
  });

  it('breaks the group at a rest', () => {
    const { beams, notes } = draw(score({ treble: [n(0, E, 76), n(Q, E, 77), n(Q + E, E, 79)] }));
    // The first eighth is alone in its beat (a rest follows); the last two are joined.
    expect(beams.length).toBe(1);
    expect(notes.filter((x) => x.beamed).length).toBe(2);
    expect(notes.find((x) => x.start === 0)!.flags).toBe(1);
  });

  it('draws a second beam over four sixteenths', () => {
    const four = [0, S, 2 * S, 3 * S].map((t) => n(t, S, 76));
    const { beams } = draw(score({ treble: four }));
    expect(beams.length).toBe(2);
    const [main, second] = beams;
    expect(second.x1).toBeCloseTo(main.x1, 3);
    expect(second.x2).toBeCloseTo(main.x2, 3);
    expect(second.ids.length).toBe(4);
  });

  it('gives a lone sixteenth after a dotted eighth a stub pointing back', () => {
    const dotted = n(0, 360, 76);
    const short = n(360, S, 77);
    const { beams, notes } = draw(score({ treble: [dotted, short] }));
    expect(beams.length).toBe(2);
    const stub = beams[1];
    const x = notes.find((x) => x.id === short.id)!.stemX;
    expect(stub.ids).toEqual([short.id]);
    expect(stub.x2).toBeCloseTo(x + 0.7, 3);
    expect(stub.x1).toBeLessThan(x - 5);
  });

  it('puts the stub of a leading sixteenth towards the following eighths', () => {
    const { beams, notes } = draw(score({ treble: [n(0, S, 76), n(S, 360, 77)] }));
    const x = notes.find((x) => x.start === 0)!.stemX;
    expect(beams[1].x1).toBeCloseTo(x - 0.7, 3);
    expect(beams[1].x2).toBeGreaterThan(x + 5);
  });

  it('breaks the group for a note that crosses a beat boundary', () => {
    // A dotted eighth from the second half of a beat runs into the next one: it keeps its flag.
    const cross = n(E, 360, 76);
    const { beams, notes } = draw(score({ treble: [n(0, E, 77), cross] }));
    expect(beams).toEqual([]);
    expect(notes.find((x) => x.id === cross.id)!.flags).toBe(1);
  });

  it('counts a chord once and gives all its notes the same stem', () => {
    const c1 = n(0, E, 72);
    const c2 = n(0, E, 76);
    const next = n(E, E, 77);
    const { notes, beams } = draw(score({ treble: [c1, c2, next] }));
    expect(beams.length).toBe(1);
    expect(beams[0].ids.sort()).toEqual([c1.id, c2.id, next.id].sort());
    const stems = notes.filter((x) => x.start === 0).map((x) => x.stemEnd);
    expect(new Set(stems).size).toBe(1);
  });

  it('does not join across a bar line, even for tied eighths', () => {
    const a = n(1680, E, 76, { tie: true });
    const b = n(1920, E, 76);
    const { beams } = draw(score({ treble: [a, b] }));
    expect(beams).toEqual([]);
  });

  it('groups each hand on its own', () => {
    const t = [n(0, E, 76), n(E, E, 77)];
    const b = [n(0, E, 48), n(E, E, 50)];
    const { beams } = draw(score({ treble: t, bass: b }));
    expect(beams.length).toBe(2);
    expect(new Set(beams.map((x) => x.staff))).toEqual(new Set(['treble', 'bass']));
    const trebleIds = new Set(t.map((x) => x.id));
    expect(beams.find((x) => x.staff === 'treble')!.ids.every((id) => trebleIds.has(id))).toBe(true);
  });

  it('beams the eighths of a pickup bar by the beats of a whole bar', () => {
    // A pickup of one beat in 4/4: its two eighths fill the last beat of the missing bar.
    const s = score({ pickup_ticks: Q, bars: 3, treble: [n(0, E, 76), n(E, E, 77)] });
    const { beams } = draw(s);
    expect(beams.length).toBe(1);
  });

  it('keeps pickup eighths of two beats in separate groups', () => {
    const s = score({ pickup_ticks: 2 * Q, bars: 3, treble: [n(0, E, 76), n(E, E, 77), n(Q, E, 79), n(Q + E, E, 81)] });
    const { beams } = draw(s);
    expect(beams.length).toBe(2);
  });

  it('beams by the beat in 3/4', () => {
    const s = score({ beats: 3, beat_unit: 4, treble: [n(0, E, 76), n(E, E, 77), n(Q, E, 79), n(Q + E, E, 81)] });
    expect(draw(s).beams.length).toBe(2);
  });

  it('does not beam quarters', () => {
    const { beams } = draw(score({ treble: [n(0, Q, 76), n(Q, Q, 77)] }));
    expect(beams).toEqual([]);
  });
});

describe('stems and heads', () => {
  it('points the stem down for a note above the middle line, up below it', () => {
    const { notes } = draw(score({ treble: [n(0, Q, 84), n(Q, Q, 62)] }));
    expect(notes.find((x) => x.start === 0)!.up).toBe(false);
    expect(notes.find((x) => x.start === Q)!.up).toBe(true);
  });

  it('gives a whole note no stem and a hollow head', () => {
    const { notes } = draw(score({ treble: [n(0, 1920, 76)] }));
    expect(notes[0].hasStem).toBe(false);
    expect(notes[0].hollow).toBe(true);
  });

  it('shows a natural after an altered note on the same step in the bar', () => {
    const { notes } = draw(score({ treble: [n(0, Q, 61, { accidental: 'sharp' }), n(Q, Q, 60)] }));
    expect(notes[0].accidental).toBe('sharp');
    expect(notes[1].accidental).toBe('natural');
  });
});

describe('ties, slurs and rests', () => {
  it('draws one arc for a tie on a line and two across a line break', () => {
    const a = n(1680, E, 76, { tie: true });
    const b = n(1920, E, 76);
    const s = score({ treble: [a, b] });
    const wide = layoutOf(s, 120);
    expect(drawTies(s, wide, drawNotes(s, wide).notes).length).toBe(1);
    const narrow = layoutOf(s, 120, 330); // one bar per line
    expect(narrow.systems.length).toBe(2);
    expect(drawTies(s, narrow, drawNotes(s, narrow).notes).length).toBe(2);
  });

  it('draws a slur between two notes of a hand', () => {
    const a = n(0, Q, 76);
    const b = n(Q, Q, 77);
    const s = score({ treble: [a, b], slurs: [{ id: 'sl', from: a.id, to: b.id }] });
    const l = layoutOf(s, 120);
    expect(drawSlurs(s, l, drawNotes(s, l).notes).length).toBe(1);
  });

  it('fills the empty bar of a hand with a whole-bar rest', () => {
    const s = score({ bars: 1, treble: [n(0, 1920, 76)] });
    const rests = drawRests(s, layoutOf(s, 120));
    expect(rests.map((r) => [r.staff, r.shape])).toEqual([['bass', 'bar']]);
  });
});

describe('system views', () => {
  it('marks every bar line with its number, none for a pickup', () => {
    const s = score({ pickup_ticks: Q, bars: 3 });
    const [view] = systemViews(s, layoutOf(s, 120));
    expect(view.marks.map((m) => m.label)).toEqual([null, 1, 2]);
    expect(view.isLast).toBe(true);
  });

  it('puts a repeat sign at the end of its bar', () => {
    const s = score({ repeat_bar: 0 });
    const [view] = systemViews(s, layoutOf(s, 120));
    expect(view.repeat).not.toBeNull();
    expect(view.repeat!.final).toBe(false);
  });
});

describe('clefs', () => {
  // Measured on the Noto Music outlines at font size 40 (see `clefOrigin`): the treble glyph's origin is on the
  // bottom line, and the two dots of the bass clef are 25.8 above its origin and must straddle the F line.
  const box = { top: 100, bottom: 140 };

  it('puts the treble clef on the bottom line, so its curl wraps the G line', () => {
    expect(clefOrigin(box, 'treble')).toEqual({ x: 9, y: 141 });
  });

  it('puts the dots of the bass clef on either side of the F line (the fourth line)', () => {
    const fLine = box.bottom - 3 * 10;
    const dots = clefOrigin(box, 'bass').y - 25.8;
    expect(dots).toBeCloseTo(fLine, 6);
  });
});
