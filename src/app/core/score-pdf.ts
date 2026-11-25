import type { ScoreDto } from './models';
import { GLYPH_EM, MUSIC_GLYPHS, type MusicGlyph } from './music-glyphs';
import { type BeamDraw, type CurveDraw, type NoteDraw, type RestDraw, type SystemView, TIME_SIG_X, clefOrigin, drawNotes, drawRests, drawSlurs, drawTies, flagPath, systemViews } from './score-draw';
import { LINE_SPACING, PRINT_METRICS, type ScoreLayout, type SystemBox, layoutOf, systemAt } from './score-layout';
import { STAFF_NAMES, barLabel } from './score';

/*
 * A score as a PDF that looks like a printed one: A4, title and tempo on the first page, the grand staff broken
 * into systems that fill the width, bar numbers at the start of each system, page numbers. The drawing is the
 * same as the editor's (`core/score-draw`) in black on white; clefs, rests, accidentals and the brace are vector
 * paths (`music-glyphs`, from the Noto Music font) so no font has to be embedded. `pdf-lib` is loaded on demand.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 42.5;
/** Points per layout unit: a staff space (10 units) is 5 pt = 1.76 mm, a usual size for piano music. */
const UNIT = 0.5;
/** Room left of the staves for the brace, in points. */
const BRACE_W = 16;
const HEADER_H = 74;
const FOOTER_H = 26;
const INK = 0;

export interface PdfLabels {
  /** "Page 2 of 3". */
  page: (n: number, total: number) => string;
  /** Title of a score that has none. */
  untitled: string;
}

/** Layout units a note needs before the next one on its staff: a head and its stem, or an accidental as well. */
const SLOT = 19;
const SLOT_SIGN = 27;

/**
 * Pixels per quarter note for the print layout: roomy enough for the tightest pair of onsets of a hand (an
 * accidental needs more room than a plain head), without making every bar wider than it has to be.
 */
export function printPpq(s: ScoreDto): number {
  let need = 0; // layout units per tick
  for (const notes of [s.treble, s.bass]) {
    const onsets = new Map<number, boolean>(); // tick -> whether a note starting there has an accidental
    for (const n of notes) onsets.set(n.tick, (onsets.get(n.tick) ?? false) || n.accidental !== null);
    const ticks = [...onsets.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ticks.length; i++) {
      need = Math.max(need, (onsets.get(ticks[i]) ? SLOT_SIGN : SLOT) / (ticks[i] - ticks[i - 1]));
    }
  }
  return Math.max(56, Math.min(120, Math.round(need * 480)));
}

/** The width of the staves, in layout units. */
export function printWidth(): number {
  return (PAGE_W - 2 * MARGIN - BRACE_W) / UNIT;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** A (possibly rotated) ellipse as four béziers, in layout units. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number, degrees = 0): string {
  const k = 0.5522847498;
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const p = (x: number, y: number) => `${r2(cx + x * cos - y * sin)} ${r2(cy + x * sin + y * cos)}`;
  return (
    `M ${p(rx, 0)} C ${p(rx, k * ry)} ${p(k * rx, ry)} ${p(0, ry)} C ${p(-k * rx, ry)} ${p(-rx, k * ry)} ${p(-rx, 0)} ` +
    `C ${p(-rx, -k * ry)} ${p(-k * rx, -ry)} ${p(0, -ry)} C ${p(k * rx, -ry)} ${p(rx, -k * ry)} ${p(rx, 0)} Z`
  );
}

const line = (x1: number, y1: number, x2: number, y2: number) => `M ${r2(x1)} ${r2(y1)} L ${r2(x2)} ${r2(y2)}`;
const rect = (x: number, y: number, w: number, h: number) => `M ${r2(x)} ${r2(y)} h ${w} v ${h} h ${-w} Z`;

/** A beam is a parallelogram as thick as the beam, measured upright like an engraved one. */
function beamPath(b: BeamDraw): string {
  const h = b.width / 2;
  return `M ${r2(b.x1)} ${r2(b.y1 - h)} L ${r2(b.x2)} ${r2(b.y2 - h)} L ${r2(b.x2)} ${r2(b.y2 + h)} L ${r2(b.x1)} ${r2(b.y1 + h)} Z`;
}

/** Characters of a title that the PDF's standard font cannot draw become `?`. */
export function pdfSafeText(text: string, supported: ReadonlySet<number>): string {
  let out = '';
  for (const ch of text.replace(/\s+/g, ' ').trim()) out += supported.has(ch.codePointAt(0) as number) ? ch : '?';
  return out;
}

/** Where each system goes: the page it is on and its distance from the top of the page, in points. */
export interface Placement {
  page: number;
  top: number;
}

/** Breaks the systems into pages (the first one has less room: it holds the title). */
export function paginate(systems: number, systemPt: number): { placements: Placement[]; pages: number } {
  const room = PAGE_H - 2 * MARGIN - FOOTER_H;
  const first = Math.max(1, Math.floor((room - HEADER_H) / systemPt));
  const other = Math.max(1, Math.floor(room / systemPt));
  const placements: Placement[] = [];
  let page = 0;
  let used = 0;
  let capacity = first;
  for (let i = 0; i < systems; i++) {
    if (used === capacity) {
      page++;
      used = 0;
      capacity = other;
    }
    placements.push({ page, top: MARGIN + (page === 0 ? HEADER_H : 0) + used * systemPt });
    used++;
  }
  return { placements, pages: Math.max(1, page + 1) };
}

/** Draws the score and returns the bytes of the PDF. */
export async function buildScorePdf(score: ScoreDto, labels: PdfLabels): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, LineCapStyle } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  const supported = new Set(bold.getCharacterSet());
  const ink = rgb(INK, INK, INK);
  const grey = rgb(0.45, 0.45, 0.45);

  const title = pdfSafeText(score.title, supported) || labels.untitled;
  doc.setTitle(title);
  doc.setCreator('Piano Practice Tracker');
  doc.setProducer('Piano Practice Tracker');
  doc.setCreationDate(new Date());

  const layout = layoutOf(score, printPpq(score), printWidth(), PRINT_METRICS);
  const systemPt = layout.systemH * UNIT;
  const { placements, pages } = paginate(layout.systems.length, systemPt);
  const pdfPages = Array.from({ length: pages }, () => doc.addPage([PAGE_W, PAGE_H]));

  const { notes, beams } = drawNotes(score, layout);
  const rests = drawRests(score, layout);
  const ties = drawTies(score, layout, notes);
  const slurs = drawSlurs(score, layout, notes);
  const views = systemViews(score, layout);
  const sysIndexOf = (tick: number) => systemAt(layout, tick).index;
  const byNote = new Map(notes.map((n) => [n.id, n]));

  const originX = MARGIN + BRACE_W;
  for (const view of views) {
    const sys = view.sys;
    const place = placements[sys.index];
    const page = pdfPages[place.page];
    // The SVG origin of this system: layout (x, y) lands at (originX + x * UNIT, PAGE_H - place.top - (y - sys.top) * UNIT).
    const ox = originX;
    const oy = PAGE_H - place.top + sys.top * UNIT;

    const path = (d: string, o: { fill?: boolean; width?: number; cap?: boolean; scale?: number }) =>
      page.drawSvgPath(d, {
        x: ox,
        y: oy,
        scale: o.scale ?? UNIT,
        ...(o.fill ? { color: ink } : {}),
        ...(o.width ? { borderColor: ink, borderWidth: o.width, ...(o.cap ? { borderLineCap: LineCapStyle.Round } : {}) } : {}),
      });
    const glyph = (name: MusicGlyph, x: number, y: number, size: number) =>
      page.drawSvgPath(MUSIC_GLYPHS[name].d, { x: ox + x * UNIT, y: oy - y * UNIT, scale: (size / GLYPH_EM) * UNIT, color: ink });

    drawSystemFurniture(view, { score, path, glyph, page, bold, plain, ink, grey, ox, oy });

    // Notes of this system
    for (const n of notes) if (sysIndexOf(n.start) === sys.index) drawNote(n, path, glyph);
    for (const b of beams) if (byNote.get(b.ids[0]) && sysIndexOf(byNote.get(b.ids[0])!.start) === sys.index) path(beamPath(b), { fill: true });
    for (const r of rests) if (sysIndexOf(r.tick) === sys.index) drawRest(r, path, glyph);
    for (const c of [...ties, ...slurs]) if (curveSystem(c, layout) === sys.index) path(c.d, { width: 1.7, cap: true });
  }

  // Header and footer
  const first = pdfPages[0];
  const titleSize = 22;
  first.drawText(title, { x: (PAGE_W - bold.widthOfTextAtSize(title, titleSize)) / 2, y: PAGE_H - MARGIN - titleSize + 4, size: titleSize, font: bold, color: ink });
  drawTempo(first, score.bpm, plain, { x: MARGIN + BRACE_W + 2, y: PAGE_H - MARGIN - titleSize - 24 }, ink);

  pdfPages.forEach((page, i) => {
    const text = labels.page(i + 1, pages);
    const y = MARGIN - 12;
    page.drawText('Piano Practice Tracker', { x: MARGIN, y, size: 8, font: plain, color: grey });
    page.drawText(text, { x: PAGE_W - MARGIN - plain.widthOfTextAtSize(text, 8), y, size: 8, font: plain, color: grey });
  });

  return doc.save();
}

type PathFn = (d: string, o: { fill?: boolean; width?: number; cap?: boolean; scale?: number }) => void;
type GlyphFn = (name: MusicGlyph, x: number, y: number, size: number) => void;

/** The system a curve belongs to: the one its first point is in. */
function curveSystem(c: CurveDraw, l: ScoreLayout): number {
  const m = /^M\s*(-?[\d.]+)\s+(-?[\d.]+)/.exec(c.d);
  const y = m ? Number(m[2]) : 0;
  return Math.max(0, Math.min(l.systems.length - 1, Math.floor(y / l.systemH)));
}

/** A quarter note and `= bpm`, left aligned on the first page. */
function drawTempo(page: import('pdf-lib').PDFPage, bpm: number, font: import('pdf-lib').PDFFont, at: { x: number; y: number }, ink: ReturnType<typeof import('pdf-lib').rgb>): void {
  const head = ellipsePath(0, 0, 3.4, 2.5, -20);
  page.drawSvgPath(head, { x: at.x + 3.4, y: at.y + 2.5, scale: 1, color: ink });
  page.drawLine({ start: { x: at.x + 6.4, y: at.y + 3.2 }, end: { x: at.x + 6.4, y: at.y + 16 }, thickness: 0.8, color: ink });
  page.drawText(`= ${Math.round(bpm)}`, { x: at.x + 13, y: at.y, size: 11, font, color: ink });
}

function drawNote(n: NoteDraw, path: PathFn, glyph: GlyphFn): void {
  for (const ly of n.ledgers) path(line(n.x - 11, ly, n.x + 11, ly), { width: 1.2 });
  if (n.kind === 'whole') path(ellipsePath(n.x, n.y, 7.4, 5), { width: 2 });
  else {
    const head = ellipsePath(n.x, n.y, 6.3, 4.6, -20);
    if (n.hollow) path(head, { width: 1.7 });
    else path(head, { fill: true, width: 1 });
    if (n.hasStem) path(line(n.stemX, n.stemBase, n.stemX, n.stemEnd), { width: 1.4 });
    for (let f = 0; f < n.flags; f++) path(flagPath(n, f), { width: 1.8, cap: true });
  }
  if (n.dotted) path(ellipsePath(n.dotX, n.dotY, 1.9, 1.9), { fill: true });
  if (n.accidental) glyph(n.accidental, n.accX, n.y + 5, 40);
}

function drawRest(r: RestDraw, path: PathFn, glyph: GlyphFn): void {
  const { x, box } = r;
  if (r.shape === 'bar') path(rect(x - 6, box.top + LINE_SPACING, 12, 5), { fill: true });
  else if (r.shape === 'half') path(rect(x - 6, box.top + 2 * LINE_SPACING - 5, 12, 5), { fill: true });
  else glyph(r.shape === 'quarter' ? 'quarterRest' : r.shape === 'eighth' ? 'eighthRest' : 'sixteenthRest', x - 5, box.bottom, 40);
}

interface Furniture {
  score: ScoreDto;
  path: PathFn;
  glyph: GlyphFn;
  page: import('pdf-lib').PDFPage;
  bold: import('pdf-lib').PDFFont;
  plain: import('pdf-lib').PDFFont;
  ink: ReturnType<typeof import('pdf-lib').rgb>;
  grey: ReturnType<typeof import('pdf-lib').rgb>;
  ox: number;
  oy: number;
}

/** Staff lines, bar lines, clefs, brace, time signature, repeat sign and the bar number of a system. */
function drawSystemFurniture(view: SystemView, f: Furniture): void {
  const sys: SystemBox = view.sys;
  const { treble, bass } = sys.staves;
  const top = treble.top;
  const bottom = bass.bottom;

  for (const staff of STAFF_NAMES) {
    const box = sys.staves[staff];
    for (let i = 0; i < 5; i++) f.path(line(0, box.top + i * LINE_SPACING, sys.right, box.top + i * LINE_SPACING), { width: 1 });
  }
  for (const m of view.marks) f.path(line(m.x, top, m.x, bottom), { width: 1.2 });
  if (view.isLast) {
    f.path(line(sys.right - 6, top, sys.right - 6, bottom), { width: 1.2 });
    f.path(line(sys.right, top, sys.right, bottom), { width: 3.2 });
  } else f.path(line(sys.right, top, sys.right, bottom), { width: 1.2 });
  if (view.repeat) {
    if (!view.repeat.final) {
      f.path(line(view.repeat.x - 6, top, view.repeat.x - 6, bottom), { width: 1.2 });
      f.path(line(view.repeat.x, top, view.repeat.x, bottom), { width: 3.2 });
    }
    for (const staff of STAFF_NAMES) {
      const box = sys.staves[staff];
      f.path(ellipsePath(view.repeat.x - 13, box.top + 15, 2.2, 2.2), { fill: true });
      f.path(ellipsePath(view.repeat.x - 13, box.top + 25, 2.2, 2.2), { fill: true });
    }
  }

  // The line that joins the staves, and the brace in front of it.
  f.path(line(1, top, 1, bottom), { width: 1.6 });
  const brace = MUSIC_GLYPHS.brace;
  const [, by1, bx2, by2] = brace.box;
  const fit = (bottom - top) / (by2 - by1);
  // Its right edge sits 3 units left of the joining line, and its top on the top line of the treble staff.
  f.page.drawSvgPath(brace.d, { x: f.ox + (-3 - bx2 * fit) * UNIT, y: f.oy - (top - by1 * fit) * UNIT, scale: fit * UNIT, color: f.ink });

  for (const staff of STAFF_NAMES) {
    const c = clefOrigin(sys.staves[staff], staff);
    f.glyph(staff === 'treble' ? 'treble' : 'bass', c.x, c.y, 40);
  }

  if (sys.index === 0) {
    const size = 25 * UNIT;
    for (const staff of STAFF_NAMES) {
      const box = sys.staves[staff];
      for (const [text, y] of [[`${f.score.beats}`, box.top + LINE_SPACING], [`${f.score.beat_unit}`, box.top + 3 * LINE_SPACING]] as const) {
        f.page.drawText(text, { x: f.ox + TIME_SIG_X * UNIT - f.bold.widthOfTextAtSize(text, size) / 2, y: f.oy - y * UNIT - size * 0.36, size, font: f.bold, color: f.ink });
      }
    }
  } else {
    // A small number over the first bar of the system (the first system starts at the start of the score).
    const first = view.marks[0];
    const n = first ? barLabel(f.score, first.index) : null;
    if (first && n !== null) f.page.drawText(`${n}`, { x: f.ox + (first.x + 1) * UNIT, y: f.oy - (top - 20) * UNIT, size: 8, font: f.plain, color: f.grey });
  }
}
