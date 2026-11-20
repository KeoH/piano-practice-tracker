import { type StaffName, type TimeShape, barSpans, scoreTicks } from './score';

/*
 * Geometry of the score editor's SVG, in pixels: where a tick, a line or a space of a staff is, and
 * the other way round for the pointer. Pure, so the hit-testing can be tested without a DOM.
 *
 * The score is laid out like a printed one: the bars are broken into **systems** (lines) that fit the
 * width of the view, stacked from top to bottom, each with its own clefs. A system is a ruler (bar
 * numbers), the treble staff, a gap that holds the ledger lines of middle C, and the bass staff. A step
 * is half a line spacing (see `staffStep`). The bars of a system are stretched a little to fill the line,
 * except in the last one.
 */

/** Line spacing of a staff, and the height of a step (half of it). */
export const LINE_SPACING = 10;
export const STEP_PX = LINE_SPACING / 2;
/** Ruler with the bar numbers. */
export const RULER_H = 24;
/** Room above the treble staff and below the bass one for ledger lines. */
export const PAD_V = 50;
/** Between the bottom line of the treble staff and the top line of the bass one. */
export const STAFF_GAP = 80;
/** Clefs and time signature, before the first bar of the first system; later systems only have the clefs. */
export const HEAD_W = 84;
export const HEAD_W_NEXT = 58;
/** From the start of a note's time slot to the centre of its notehead. */
export const NOTE_X = 18;
/** After the last bar line. */
export const END_PAD = 24;
/** How much a system may stretch its bars to fill the line. */
export const MAX_STRETCH = 1.6;
/** Height of a system (the staves and what is around them). */
export const SYSTEM_H = RULER_H + PAD_V + 4 * LINE_SPACING + STAFF_GAP + 4 * LINE_SPACING + PAD_V;

export interface StaffBox {
  /** Top and bottom lines. */
  top: number;
  bottom: number;
}

/** One line of the score. */
export interface SystemBox {
  index: number;
  firstBar: number;
  lastBar: number;
  /** The ticks it holds: `[startTick, endTick)`. */
  startTick: number;
  endTick: number;
  /** Top of the system and of its first bar's left edge. */
  top: number;
  x0: number;
  /** Pixels per tick in this system (stretched to fill the line). */
  ppt: number;
  /** Where its last bar ends. */
  right: number;
  staves: Record<StaffName, StaffBox>;
  /** Pointer y at which the bass staff takes over from the treble one. */
  midY: number;
}

export interface ScoreLayout {
  /** Pixels per quarter note, and per tick before stretching. */
  ppq: number;
  ppt: number;
  width: number;
  height: number;
  systems: SystemBox[];
}

/**
 * Lays the bars out in systems of at most `viewWidth` pixels (a system always has at least one bar, so a
 * very wide bar makes the SVG wider than the view). Without a width everything is one system.
 */
export function layoutOf(s: TimeShape, ppq: number, viewWidth = Number.POSITIVE_INFINITY): ScoreLayout {
  const base = ppq / 480;
  const spans = barSpans(s);
  const systems: SystemBox[] = [];
  let widest = 0;
  for (let i = 0; i < spans.length; ) {
    const index = systems.length;
    const x0 = index === 0 ? HEAD_W : HEAD_W_NEXT;
    let j = i;
    let ticks = 0;
    while (j < spans.length) {
      const len = spans[j].end - spans[j].start;
      if (j > i && x0 + (ticks + len) * base + END_PAD > viewWidth) break;
      ticks += len;
      j++;
    }
    const isLast = j >= spans.length;
    let ppt = base;
    if (!isLast && Number.isFinite(viewWidth)) ppt = Math.min(base * MAX_STRETCH, Math.max(base, (viewWidth - x0 - END_PAD) / ticks));
    const top = index * SYSTEM_H;
    const trebleTop = top + RULER_H + PAD_V;
    const trebleBottom = trebleTop + 4 * LINE_SPACING;
    const bassTop = trebleBottom + STAFF_GAP;
    systems.push({
      index,
      firstBar: i,
      lastBar: j - 1,
      startTick: spans[i].start,
      endTick: spans[j - 1].end,
      top,
      x0,
      ppt,
      right: x0 + ticks * ppt,
      staves: { treble: { top: trebleTop, bottom: trebleBottom }, bass: { top: bassTop, bottom: bassTop + 4 * LINE_SPACING } },
      midY: (trebleBottom + bassTop) / 2,
    });
    widest = Math.max(widest, x0 + ticks * ppt + END_PAD);
    i = j;
  }
  return {
    ppq,
    ppt: base,
    width: Number.isFinite(viewWidth) ? Math.max(viewWidth, widest) : widest,
    height: systems.length * SYSTEM_H,
    systems,
  };
}

/** The system that holds `tick` (the last one for a tick at or past the end). */
export function systemAt(l: ScoreLayout, tick: number): SystemBox {
  return l.systems.find((sys) => tick < sys.endTick) ?? l.systems[l.systems.length - 1];
}

/** Left edge of a time slot. */
export function xOfTick(l: ScoreLayout, tick: number): number {
  const sys = systemAt(l, tick);
  return sys.x0 + (tick - sys.startTick) * sys.ppt;
}

/** Centre of the notehead of a note that starts at `tick`. */
export function noteX(l: ScoreLayout, tick: number): number {
  return xOfTick(l, tick) + NOTE_X;
}

/** y of a line (even step) or space (odd step) of `staff` in a system. */
export function yOfStep(sys: SystemBox, staff: StaffName, step: number): number {
  return sys.staves[staff].bottom - step * STEP_PX;
}

export interface Hit {
  staff: StaffName;
  step: number;
  /** Tick under the pointer's notehead position, not snapped. */
  tick: number;
  system: number;
}

/** The system a y is in, or `null` outside the SVG. */
function systemAtY(l: ScoreLayout, y: number): SystemBox | null {
  if (y < 0 || y >= l.height) return null;
  return l.systems[Math.min(l.systems.length - 1, Math.floor(y / SYSTEM_H))] ?? null;
}

/** The staff, step and tick at a point of the SVG; `null` over a ruler, the clefs or past the last bar of a line. */
export function hitAt(l: ScoreLayout, x: number, y: number): Hit | null {
  const sys = systemAtY(l, y);
  if (!sys || x < sys.x0 || x > sys.right + NOTE_X || y - sys.top < RULER_H) return null;
  const staff: StaffName = y < sys.midY ? 'treble' : 'bass';
  return {
    staff,
    step: Math.round((sys.staves[staff].bottom - y) / STEP_PX),
    tick: sys.startTick + (x - sys.x0 - NOTE_X) / sys.ppt,
    system: sys.index,
  };
}

/** Whether a point is on the ruler of a system (the seek strip). */
export function inRuler(l: ScoreLayout, x: number, y: number): boolean {
  const sys = systemAtY(l, y);
  return !!sys && y - sys.top < RULER_H && x >= sys.x0 && x <= sys.right;
}

/** The tick under the pointer on a ruler, snapped to `grid`, inside the score. */
export function rulerTick(l: ScoreLayout, s: TimeShape, x: number, y: number, grid = 120): number {
  const sys = systemAtY(l, y) ?? l.systems[0];
  const raw = sys.startTick + (x - sys.x0) / sys.ppt;
  const snapped = Math.round(raw / grid) * grid;
  return Math.min(Math.min(scoreTicks(s), sys.endTick), Math.max(sys.startTick, snapped));
}

/** The glyph a rest of `duration` ticks is drawn with; a rest that fills the bar is a whole-bar rest. */
export type RestShape = 'bar' | 'half' | 'quarter' | 'eighth' | 'sixteenth';

export function restShape(duration: number, bar: number): RestShape {
  if (duration >= bar) return 'bar';
  if (duration >= 960) return 'half';
  if (duration >= 480) return 'quarter';
  if (duration >= 240) return 'eighth';
  return 'sixteenth';
}

/** Whether a note on this step has its stem up (below the middle line) or down. */
export function stemUp(step: number): boolean {
  return step < 4;
}
