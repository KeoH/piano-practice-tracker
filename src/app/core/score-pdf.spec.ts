import { PDFDocument } from 'pdf-lib';
import type { ScoreDto, ScoreNoteDto } from './models';
import { newScore } from './score';
import { buildScorePdf, ellipsePath, paginate, pdfSafeText, printPpq, printWidth } from './score-pdf';
import { PRINT_METRICS, layoutOf } from './score-layout';

let seq = 0;
function n(tick: number, dur: number, key: number, extra: Partial<ScoreNoteDto> = {}): ScoreNoteDto {
  return { id: `n${++seq}`, tick, duration_ticks: dur, key, accidental: null, tie: false, ...extra };
}

/** `bars` bars of four quarters in the right hand and a half note chord in the left. */
function longScore(bars: number, title = 'A long piece'): ScoreDto {
  const treble: ScoreNoteDto[] = [];
  const bass: ScoreNoteDto[] = [];
  for (let b = 0; b < bars; b++) {
    for (let i = 0; i < 4; i++) treble.push(n(b * 1920 + i * 480, 480, 72 + ((b + i) % 7)));
    bass.push(n(b * 1920, 960, 48), n(b * 1920, 960, 55), n(b * 1920 + 960, 960, 50));
  }
  return { ...newScore('s', title, '2026-01-01'), bars, treble, bass };
}

const labels = { page: (a: number, b: number) => `Page ${a} of ${b}`, untitled: 'Untitled' };
const text = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

describe('score pdf: spacing', () => {
  it('gives a score of quarters the minimum room and tight sixteenths more', () => {
    expect(printPpq(longScore(2))).toBe(56);
    const dense = { ...newScore('s', 't', 'x'), treble: [n(0, 120, 72), n(120, 120, 74), n(240, 120, 76)] };
    expect(printPpq(dense)).toBeGreaterThan(printPpq(longScore(2)));
  });

  it('needs more room before a note with an accidental', () => {
    const plain = { ...newScore('s', 't', 'x'), treble: [n(0, 120, 72), n(120, 120, 74)] };
    const sharp = { ...newScore('s', 't', 'x'), treble: [n(0, 120, 72), n(120, 120, 73, { accidental: 'sharp' })] };
    expect(printPpq(sharp)).toBeGreaterThan(printPpq(plain));
  });

  it('never goes past a sensible maximum, and copes with an empty score', () => {
    const crowded = { ...newScore('s', 't', 'x'), treble: [n(0, 120, 72), n(10, 110, 74, { accidental: null })] };
    expect(printPpq(crowded)).toBeLessThanOrEqual(120);
    expect(printPpq(newScore('s', 't', 'x'))).toBe(56);
  });

  it('breaks the systems to the page width', () => {
    const s = longScore(8);
    const l = layoutOf(s, printPpq(s), printWidth(), PRINT_METRICS);
    expect(l.systems.length).toBeGreaterThan(1);
    for (const sys of l.systems.slice(0, -1)) expect(sys.right).toBeLessThanOrEqual(printWidth());
  });
});

describe('score pdf: pages', () => {
  it('keeps everything on one page when it fits', () => {
    const { placements, pages } = paginate(3, 100);
    expect(pages).toBe(1);
    expect(placements.map((p) => p.page)).toEqual([0, 0, 0]);
  });

  it('puts fewer systems on the first page, which holds the title', () => {
    const systemPt = 100;
    const { placements } = paginate(30, systemPt);
    const first = placements.filter((p) => p.page === 0).length;
    const second = placements.filter((p) => p.page === 1).length;
    expect(first).toBeLessThan(second);
    // Within a page the systems follow each other without overlapping.
    for (let i = 1; i < placements.length; i++) if (placements[i].page === placements[i - 1].page) expect(placements[i].top - placements[i - 1].top).toBeCloseTo(systemPt, 6);
    // Every page starts at the top margin (the first one below the title).
    expect(placements.find((p) => p.page === 1)!.top).toBeLessThan(placements.find((p) => p.page === 0)!.top + 100 * first);
  });

  it('always puts at least one system on a page, however tall', () => {
    const { pages } = paginate(3, 5000);
    expect(pages).toBe(3);
  });
});

describe('score pdf: helpers', () => {
  it('replaces what the standard font cannot draw', () => {
    const supported = new Set([...'ABC é'].map((c) => c.codePointAt(0)!));
    expect(pdfSafeText('  AB  C é日本 ', supported)).toBe('AB C é??');
  });

  it('writes an ellipse as four curves that close', () => {
    const d = ellipsePath(10, 20, 6, 4);
    expect(d.match(/C/g)?.length).toBe(4);
    expect(d.startsWith('M 16 20')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });
});

describe('score pdf: document', () => {
  it('makes an A4 PDF with the title', async () => {
    const bytes = await buildScorePdf(longScore(2, 'Gymnopédie'), labels);
    expect(text(bytes).startsWith('%PDF-')).toBe(true);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
    expect(pdf.getTitle()).toBe('Gymnopédie');
  });

  it('adds pages for a long score', async () => {
    const pdf = await PDFDocument.load(await buildScorePdf(longScore(60), labels));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it('survives a title the standard font cannot draw, and an empty one', async () => {
    const odd = await PDFDocument.load(await buildScorePdf(longScore(1, '日本語 ñ'), labels));
    expect(odd.getTitle()).toBe('??? ñ');
    const none = await PDFDocument.load(await buildScorePdf(longScore(1, '   '), labels));
    expect(none.getTitle()).toBe('Untitled');
  });

  it('draws a score with every kind of mark without failing', async () => {
    const a = n(0, 240, 76);
    const b = n(240, 120, 77, { accidental: 'sharp' });
    const c = n(360, 120, 79);
    const d = n(480, 960, 72, { tie: true });
    const e = n(1440, 480, 72);
    const s: ScoreDto = {
      ...newScore('s', 'Everything', '2026-01-01'),
      bars: 3,
      pickup_ticks: 480,
      bpm: 88,
      repeat_bar: 1,
      treble: [a, b, c, d, e],
      bass: [n(0, 1920, 48)],
      slurs: [{ id: 'sl', from: a.id, to: c.id }],
    };
    const pdf = await PDFDocument.load(await buildScorePdf(s, labels));
    expect(pdf.getPageCount()).toBe(1);
  });
});
