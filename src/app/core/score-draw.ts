import type { Accidental, ScoreDto, ScoreNoteDto } from './models';
import {
  type ScoreLayout,
  type RestShape,
  type StaffBox,
  type SystemBox,
  LINE_SPACING,
  STEP_PX,
  noteX,
  restShape,
  systemAt,
  xOfTick,
  yOfStep,
} from './score-layout';
import {
  type StaffName,
  STAFF_NAMES,
  barLabel,
  barOf,
  barSpanAt,
  barSpans,
  barTicks,
  ledgerSteps,
  missingTicks,
  noteEnd,
  notatedValue,
  repeatTick,
  scoreTicks,
  slurLinks,
  staffNotes,
  staffStep,
  tieLinks,
  withRests,
} from './score';

/*
 * The geometry of everything a score draws, as plain data: noteheads, stems, beams, ties, slurs, rests and the
 * furniture of each system (bar lines, repeat sign). Pure functions of `(score, layout)`, so the editor's SVG
 * and the PDF export draw exactly the same thing, and the rules (beaming above all) can be tested without a DOM.
 *
 * Order inside a staff matters: chords are found first, then grouped under beams, then their stems are fixed
 * (every chord of a group shares one direction and its stem runs to the beam), then the beams are placed, and
 * only then do ties and slurs hang off the final stems.
 */

/** Stem length of a note without a beam, and the shortest stem a beam may leave a notehead. */
const NOTE_STEM = 33;
const MIN_BEAM_STEM = 27;
/** Beams are `BEAM_W` thick and the second one sits `BEAM_GAP` towards the noteheads. */
export const BEAM_W = 4.2;
const BEAM_GAP = 6.4;
/** Steepest slope of a beam (pixels per pixel) and the length of the stub of a lone sixteenth. */
const MAX_BEAM_SLOPE = 0.15;
const STUB = 9;
/** Stems stand `STEM_DX` from the centre of the notehead. */
const STEM_DX = 5.7;

export type NoteKind = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth';

export interface NoteDraw {
  id: string;
  staff: StaffName;
  /** Centre of the notehead (moved aside when it is a second in a chord). */
  x: number;
  y: number;
  start: number;
  end: number;
  kind: NoteKind;
  dotted: boolean;
  /** Notehead is hollow (whole and half notes). */
  hollow: boolean;
  /** Flags on the stem: none when the note hangs from a beam. */
  flags: number;
  /** The note is part of a beamed group. */
  beamed: boolean;
  /** Stem direction (shared by the chord) and its two ends: at the farthest notehead and at the tip. */
  up: boolean;
  stemX: number;
  stemBase: number;
  stemEnd: number;
  hasStem: boolean;
  ledgers: number[];
  /** What is drawn before the note: a black key's sharp or flat, or a natural that cancels one earlier in the bar. */
  accidental: Accidental | 'natural' | null;
  accX: number;
  dotX: number;
  dotY: number;
}

/** A beam: a thick line between two stems (its centre line). */
export interface BeamDraw {
  key: string;
  /** The notes that hang from it. */
  ids: string[];
  staff: StaffName;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

export interface CurveDraw {
  key: string;
  d: string;
}

export interface RestDraw {
  key: string;
  staff: StaffName;
  box: StaffBox;
  shape: RestShape;
  x: number;
  tick: number;
}

/** A repeat sign at the end of a bar: the x of its bar line. */
export interface RepeatDraw {
  x: number;
  /** The bar line closing the score is already a double bar: the sign shares it. */
  final: boolean;
}

export interface BarMark {
  index: number;
  x: number;
  label: number | null;
}

/** What a system draws apart from the notes: its bar lines and numbers and its beat guides. */
export interface SystemView {
  sys: SystemBox;
  marks: BarMark[];
  beatX: number[];
  isLast: boolean;
  /** The repeat sign closing a bar of this system, if there is one. */
  repeat: RepeatDraw | null;
}

// ----------------------------------------------------------------------------------------------
// Systems
// ----------------------------------------------------------------------------------------------

/** Beat lines inside the bars (the bar lines are drawn apart); beats are counted from where a whole bar would start. */
export function beatTicks(d: ScoreDto): number[] {
  const beat = 1920 / d.beat_unit;
  const lead = missingTicks(d);
  const bar = barTicks(d);
  const out: number[] = [];
  for (let t = beat - lead; t < scoreTicks(d); t += beat) if (t > 0 && (t + lead) % bar !== 0) out.push(t);
  return out;
}

export function systemViews(d: ScoreDto, l: ScoreLayout): SystemView[] {
  const spans = barSpans(d);
  const beats = beatTicks(d);
  const repeatAt = repeatTick(d);
  return l.systems.map((sys) => ({
    sys,
    isLast: sys.index === l.systems.length - 1,
    repeat:
      repeatAt !== null && repeatAt > sys.startTick && repeatAt <= sys.endTick
        ? { x: sys.x0 + (repeatAt - sys.startTick) * sys.ppt, final: sys.index === l.systems.length - 1 && repeatAt === sys.endTick }
        : null,
    marks: spans
      .slice(sys.firstBar, sys.lastBar + 1)
      .map((sp) => ({ index: sp.index, x: sys.x0 + (sp.start - sys.startTick) * sys.ppt, label: barLabel(d, sp.index) })),
    beatX: beats.filter((t) => t >= sys.startTick && t < sys.endTick).map((t) => sys.x0 + (t - sys.startTick) * sys.ppt),
  }));
}

/**
 * Where the clef glyphs are drawn (their origin, at font size 40, one staff space = 10), measured on the outlines
 * of Noto Music: the glyph of the treble clef has its origin about a staff space below its G line, so it sits on
 * the bottom line (its two inner counters straddle the G line); the bass clef's two dots are centred 25.8 above
 * its origin, and they have to straddle the F line, the fourth from the bottom.
 */
export function clefOrigin(box: StaffBox, staff: StaffName): { x: number; y: number } {
  return { x: 9, y: staff === 'treble' ? box.bottom + 1 : box.bottom - 3 * LINE_SPACING + 25.8 };
}

export const TIME_SIG_X = 58;

// ----------------------------------------------------------------------------------------------
// Notes and beams
// ----------------------------------------------------------------------------------------------

interface Chord {
  notes: ScoreNoteDto[];
  tick: number;
  end: number;
  kind: NoteKind;
  dotted: boolean;
  sys: SystemBox;
  /** Steps of the lowest and the highest notehead. */
  low: number;
  high: number;
  baseX: number;
  /** Notehead extremes in pixels: `top` is the smallest y. */
  top: number;
  bottom: number;
  /** Start of the beat it falls in, and whether it ends inside it (so it can share a beam). */
  beatStart: number;
  inBeat: boolean;
}

/** The beam groups of a staff: runs of eighths and sixteenths that touch, inside one beat, of at least two chords. */
function beamGroups(chords: Chord[]): Chord[][] {
  const groups: Chord[][] = [];
  let run: Chord[] = [];
  const flush = () => {
    if (run.length >= 2) groups.push(run);
    run = [];
  };
  for (const c of chords) {
    const beamable = (c.kind === 'eighth' || c.kind === 'sixteenth') && c.inBeat;
    if (!beamable) {
      flush();
      continue;
    }
    const last = run[run.length - 1];
    if (last && (last.end !== c.tick || last.beatStart !== c.beatStart)) flush();
    run.push(c);
  }
  flush();
  return groups;
}

/** Whether the stems of notes spanning `low`..`high` (steps) point up: they follow the note farthest from the middle line. */
function stemsUp(low: number, high: number): boolean {
  return 4 - low > high - 4;
}

/** The clamped slope and offset of a beam line over the stems of a group (`y = at x`). */
function beamLine(group: Chord[], staff: StaffName, up: boolean): (x: number) => number {
  const sixteenths = group.some((c) => c.kind === 'sixteenth');
  const minStem = MIN_BEAM_STEM + (sixteenths ? BEAM_GAP : 0);
  const dx = up ? STEM_DX : -STEM_DX;
  const xs = group.map((c) => c.baseX + dx);
  const mid = (c: Chord) => c.sys.staves[staff].top + 2 * LINE_SPACING;
  // Where each stem would end on its own, and the farthest a beam may come towards the noteheads.
  const tip = group.map((c) => (up ? Math.min(c.top - NOTE_STEM, mid(c)) : Math.max(c.bottom + NOTE_STEM, mid(c))));
  const limit = group.map((c) => (up ? Math.min(c.top - minStem, mid(c)) : Math.max(c.bottom + minStem, mid(c))));
  const span = xs[xs.length - 1] - xs[0];
  const slope = span > 0 ? Math.max(-MAX_BEAM_SLOPE, Math.min(MAX_BEAM_SLOPE, (tip[tip.length - 1] - tip[0]) / span)) : 0;
  const at = (i: number) => tip[0] + slope * (xs[i] - xs[0]);
  // Shift the whole line away from the noteheads until every stem is long enough.
  let shift = 0;
  for (let i = 0; i < group.length; i++) shift = up ? Math.min(shift, limit[i] - at(i)) : Math.max(shift, limit[i] - at(i));
  return (x) => tip[0] + shift + slope * (x - xs[0]);
}

/** Every chord of a staff, in order, with where it is and how long. */
function chordsOf(d: ScoreDto, l: ScoreLayout, staff: StaffName): Chord[] {
  const byTick = new Map<string, ScoreNoteDto[]>();
  for (const n of staffNotes(d, staff)) {
    const key = `${n.tick}:${n.duration_ticks}`;
    byTick.set(key, [...(byTick.get(key) ?? []), n]);
  }
  const beat = 1920 / d.beat_unit;
  const out: Chord[] = [];
  for (const notes of byTick.values()) {
    const first = notes[0];
    const sys = systemAt(l, first.tick);
    const value = notatedValue(first.duration_ticks);
    const kind: NoteKind = value?.kind === 'thirtysecond' || !value ? 'sixteenth' : value.kind;
    const steps = notes.map((n) => staffStep(staff, n.key, n.accidental));
    const low = Math.min(...steps);
    const high = Math.max(...steps);
    const span = barSpanAt(d, first.tick);
    const origin = span ? span.virtualStart : 0;
    const beatStart = origin + Math.floor((first.tick - origin) / beat) * beat;
    out.push({
      notes,
      tick: first.tick,
      end: noteEnd(first),
      kind,
      dotted: !!value?.dotted,
      sys,
      low,
      high,
      baseX: noteX(l, first.tick),
      top: yOfStep(sys, staff, high),
      bottom: yOfStep(sys, staff, low),
      beatStart,
      inBeat: noteEnd(first) <= beatStart + beat,
    });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

/** The accidental drawn before each note of a staff. */
function accidentalSigns(d: ScoreDto, staff: StaffName): Map<string, Accidental | 'natural' | null> {
  const notes = staffNotes(d, staff);
  const continuations = new Set(tieLinks(notes).map((t) => t.to.id));
  // An accidental lasts until the end of the bar for the notes on its line or space, so a plain note after
  // an altered one on the same step needs a natural sign; the note a tie carries over keeps the accidental
  // it was tied with and shows none.
  const signs = new Map<string, Accidental | 'natural' | null>();
  const altered = new Map<number, Accidental>();
  let barIndex = -1;
  for (const n of notes) {
    const step = staffStep(staff, n.key, n.accidental);
    if (barOf(d, n.tick) !== barIndex) {
      barIndex = barOf(d, n.tick);
      altered.clear();
    }
    let drawn: Accidental | 'natural' | null = n.accidental;
    if (continuations.has(n.id)) drawn = null;
    else if (n.accidental) altered.set(step, n.accidental);
    else if (altered.delete(step)) drawn = 'natural';
    signs.set(n.id, drawn);
  }
  return signs;
}

/** Noteheads, stems and beams of the whole score. */
export function drawNotes(d: ScoreDto, l: ScoreLayout): { notes: NoteDraw[]; beams: BeamDraw[] } {
  const notesOut: NoteDraw[] = [];
  const beams: BeamDraw[] = [];
  for (const staff of STAFF_NAMES) {
    const signs = accidentalSigns(d, staff);
    const chords = chordsOf(d, l, staff);
    const groups = beamGroups(chords);

    // Beams first: they decide the direction and the tip of the stems of their chords.
    const grouped = new Map<Chord, { up: boolean; line: (x: number) => number }>();
    for (const group of groups) {
      const low = Math.min(...group.map((c) => c.low));
      const high = Math.max(...group.map((c) => c.high));
      const up = stemsUp(low, high);
      const line = beamLine(group, staff, up);
      for (const c of group) grouped.set(c, { up, line });
      beams.push(...beamsOf(group, staff, up, line));
    }

    for (const chord of chords) {
      const beam = grouped.get(chord);
      const { notes, sys, baseX } = chord;
      const mid = sys.staves[staff].top + 2 * LINE_SPACING;
      const kind = chord.kind;
      // The stem goes the way of the note that is farthest from the middle line (down when level).
      const up = beam ? beam.up : stemsUp(chord.low, chord.high);
      const hasStem = kind !== 'whole';
      const stemX = up ? baseX + STEM_DX : baseX - STEM_DX;
      const stemBase = up ? chord.bottom : chord.top;
      const stemEnd = beam ? beam.line(stemX) : up ? Math.min(chord.top - NOTE_STEM, mid) : Math.max(chord.bottom + NOTE_STEM, mid);

      // Seconds: a head that touches the previous one goes to the other side of the stem.
      const order = [...notes].sort((a, b) => staffStep(staff, a.key, a.accidental) - staffStep(staff, b.key, b.accidental));
      if (!up) order.reverse();
      const side = new Map<string, boolean>();
      let prevStep: number | null = null;
      let prevShifted = false;
      for (const n of order) {
        const step = staffStep(staff, n.key, n.accidental);
        const shifted: boolean = prevStep !== null && Math.abs(step - prevStep) <= 1 && !prevShifted;
        side.set(n.id, shifted);
        prevStep = step;
        prevShifted = shifted;
      }
      const anyShifted = [...side.values()].some(Boolean);
      const shiftX = (up ? 1 : -1) * 11.6;
      const rightmost = baseX + (up && anyShifted ? 11.6 : 0);

      // Accidentals stack leftwards when the notes are too close for one column.
      const marked = [...notes].filter((n) => signs.get(n.id)).sort((a, b) => staffStep(staff, b.key, b.accidental) - staffStep(staff, a.key, a.accidental));
      const columns: number[][] = [];
      const columnOf = new Map<string, number>();
      for (const n of marked) {
        const step = staffStep(staff, n.key, n.accidental);
        let col = columns.findIndex((steps) => steps.every((t) => Math.abs(t - step) >= 6));
        if (col < 0) col = columns.push([]) - 1;
        columns[col].push(step);
        columnOf.set(n.id, col);
      }

      for (const n of notes) {
        const step = staffStep(staff, n.key, n.accidental);
        const y = yOfStep(sys, staff, step);
        const shifted = side.get(n.id) ?? false;
        notesOut.push({
          id: n.id,
          staff,
          x: baseX + (shifted ? shiftX : 0),
          y,
          start: n.tick,
          end: noteEnd(n),
          kind,
          dotted: chord.dotted,
          hollow: kind === 'whole' || kind === 'half',
          flags: beam ? 0 : kind === 'eighth' ? 1 : kind === 'sixteenth' ? 2 : 0,
          beamed: !!beam,
          up,
          stemX,
          stemBase,
          stemEnd,
          hasStem,
          ledgers: ledgerSteps(step).map((st) => yOfStep(sys, staff, st)),
          accidental: signs.get(n.id) ?? null,
          accX: baseX - 20 - (columnOf.get(n.id) ?? 0) * 11 - (!up && anyShifted ? 11.6 : 0),
          dotX: rightmost + 12,
          dotY: step % 2 === 0 ? y - STEP_PX : y,
        });
      }
    }
  }
  notesOut.sort((a, b) => a.start - b.start || a.y - b.y);
  return { notes: notesOut, beams };
}

/** The beams of one group: a main one over every chord, and a second over the sixteenths (a stub for a lone one). */
function beamsOf(group: Chord[], staff: StaffName, up: boolean, line: (x: number) => number): BeamDraw[] {
  const dx = up ? STEM_DX : -STEM_DX;
  const towards = up ? 1 : -1;
  const xOf = (c: Chord) => c.baseX + dx;
  const ids = (cs: Chord[]) => cs.flatMap((c) => c.notes.map((n) => n.id));
  const half = BEAM_W / 2;
  const out: BeamDraw[] = [];
  const first = group[0];
  const last = group[group.length - 1];
  const edge = 0.7; // half the width of a stem, so the beam covers it
  const draw = (key: string, cs: Chord[], x1: number, x2: number, row: number): BeamDraw => ({
    key,
    ids: ids(cs),
    staff,
    x1,
    y1: line(x1) + towards * (half + row * BEAM_GAP),
    x2,
    y2: line(x2) + towards * (half + row * BEAM_GAP),
    width: BEAM_W,
  });
  out.push(draw(`${first.notes[0].id}-b0`, group, xOf(first) - edge, xOf(last) + edge, 0));

  // Runs of sixteenths get the second beam; one on its own gets a stub towards the rest of the beat.
  for (let i = 0; i < group.length; ) {
    if (group[i].kind !== 'sixteenth') {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < group.length && group[j + 1].kind === 'sixteenth') j++;
    const run = group.slice(i, j + 1);
    const key = `${run[0].notes[0].id}-b1`;
    if (run.length > 1) out.push(draw(key, run, xOf(run[0]) - edge, xOf(run[run.length - 1]) + edge, 1));
    else {
      const x = xOf(run[0]);
      const towardsPrev = i > 0;
      out.push(draw(key, run, towardsPrev ? x - STUB : x - edge, towardsPrev ? x + edge : x + STUB, 1));
    }
    i = j + 1;
  }
  return out;
}

/** A flag on the stem of a note: curls to the right, towards the notehead's side. */
export function flagPath(n: Pick<NoteDraw, 'stemX' | 'stemEnd' | 'up'>, index: number): string {
  const sx = n.stemX;
  const dir = n.up ? 1 : -1;
  const y0 = n.stemEnd + dir * index * 6;
  return `M ${sx} ${y0} C ${sx + 1} ${y0 + dir * 8}, ${sx + 11} ${y0 + dir * 10}, ${sx + 8} ${y0 + dir * 22}`;
}

// ----------------------------------------------------------------------------------------------
// Ties, slurs and rests
// ----------------------------------------------------------------------------------------------

/** Arcs joining a note to the one it is tied to, on the side opposite to the stem. */
export function drawTies(d: ScoreDto, l: ScoreLayout, notes: readonly NoteDraw[]): CurveDraw[] {
  const draws = new Map(notes.map((n) => [n.id, n]));
  const out: CurveDraw[] = [];
  for (const staff of STAFF_NAMES) {
    for (const { from, to } of tieLinks(staffNotes(d, staff))) {
      const a = draws.get(from.id);
      const b = draws.get(to.id);
      if (!a || !b) continue;
      const below = a.hasStem ? a.up : false;
      const dir = below ? 1 : -1;
      const x1 = a.x + 7;
      const x2 = b.x - 7;
      const y1 = a.y + dir * 5;
      const y2 = b.y + dir * 5;
      const first = systemAt(l, from.tick);
      const second = systemAt(l, to.tick);
      if (first === second) {
        out.push({ key: `${from.id}-${to.id}`, d: `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 + dir * 11} ${x2} ${y2}` });
      } else {
        // Over a line break the tie is two arcs: one to the end of the line, one from the start of the next.
        out.push({ key: `${from.id}-${to.id}-a`, d: `M ${x1} ${y1} Q ${(x1 + first.right) / 2} ${y1 + dir * 11} ${first.right} ${y1}` });
        out.push({ key: `${from.id}-${to.id}-b`, d: `M ${second.x0} ${y2} Q ${(second.x0 + x2) / 2} ${y2 + dir * 11} ${x2} ${y2}` });
      }
    }
  }
  return out;
}

/**
 * Curves over the notes a slur covers. They go over the noteheads, or under them when every stem points up,
 * and rise far enough to clear the highest (or lowest) notehead and stem in between. A slur that crosses a line
 * break is drawn once per system, open at the break.
 */
export function drawSlurs(d: ScoreDto, l: ScoreLayout, notes: readonly NoteDraw[]): CurveDraw[] {
  if (!d.slurs.length) return [];
  const draws = new Map(notes.map((n) => [n.id, n]));
  const out: CurveDraw[] = [];
  for (const staff of STAFF_NAMES) {
    for (const { slur, from, to } of slurLinks(d, staff)) {
      const a = draws.get(from.id);
      const b = draws.get(to.id);
      if (!a || !b) continue;
      const inside = notes.filter((n) => n.staff === staff && n.start >= from.tick && n.start <= to.tick);
      const below = inside.every((n) => n.hasStem && n.up);
      const dir = below ? 1 : -1;
      const first = systemAt(l, from.tick);
      const last = systemAt(l, to.tick);
      for (let i = first.index; i <= last.index; i++) {
        const sys = l.systems[i];
        const part = inside.filter((n) => systemAt(l, n.start) === sys);
        if (!part.length) continue;
        const x1 = sys === first ? a.x : sys.x0 + 2;
        const x2 = sys === last ? b.x : sys.right - 2;
        // Slurs hang off the notehead on the stem-free side: 7 px from its centre, as ties do.
        const y1 = (sys === first ? a.y : part[0].y) + dir * 7;
        const y2 = (sys === last ? b.y : part[part.length - 1].y) + dir * 7;
        // The farthest point of any note in the system on the side of the curve (a stem counts when it points that way).
        const reach = part.map((n) => (dir < 0 ? Math.min(n.y - 7, n.hasStem && n.up ? n.stemEnd - 3 : n.y) : Math.max(n.y + 7, n.hasStem && !n.up ? n.stemEnd + 3 : n.y)));
        const peak = dir < 0 ? Math.min(...reach) : Math.max(...reach);
        // A cubic whose control points sit at height `c` passes (y1 + y2) / 8 + 3c / 4 at its middle.
        const wanted = peak + dir * 8;
        const c = (wanted - (y1 + y2) / 8) / 0.75;
        const bend = dir < 0 ? Math.min(c, Math.min(y1, y2) - 12) : Math.max(c, Math.max(y1, y2) + 12);
        const w = x2 - x1;
        out.push({ key: `${slur.id}-${i}`, d: `M ${x1} ${y1} C ${x1 + w * 0.2} ${bend}, ${x2 - w * 0.2} ${bend}, ${x2} ${y2}` });
      }
    }
  }
  return out;
}

/** The rests of both staves (the gaps between notes). */
export function drawRests(d: ScoreDto, l: ScoreLayout): RestDraw[] {
  const out: RestDraw[] = [];
  for (const staff of STAFF_NAMES) {
    for (const item of withRests(d, staff)) {
      if (item.kind !== 'rest') continue;
      // Only a rest as long as a whole bar is drawn as the whole rest; a short bar is filled with its beats.
      const shape = restShape(item.duration_ticks, barTicks(d));
      const x = shape === 'bar' ? xOfTick(l, item.tick + item.duration_ticks / 2) : noteX(l, item.tick);
      out.push({ key: `${staff}-${item.tick}`, staff, box: systemAt(l, item.tick).staves[staff], shape, x, tick: item.tick });
    }
  }
  return out;
}
