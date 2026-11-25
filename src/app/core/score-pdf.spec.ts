import { PDFDocument } from 'pdf-lib';
import type { ScoreDto, ScoreNoteDto } from './models';
import { newScore } from './score';
import { buildScorePdf, buildScoresPdf, ellipsePath, flow, flowLines, paginate, pdfSafeText, printPpq, printWidth, wrapText } from './score-pdf';
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

const labels = { page: (a: number, b: number) => `Page ${a} of ${b}`, untitled: 'Untitled', collection: 'Collection', notes: 'Notes' };
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

describe('score pdf: scores one after another', () => {
  it('puts a short score below the previous one when it fits', () => {
    const { scores, pages } = flow([{ systems: 2, systemPt: 80 }, { systems: 2, systemPt: 80 }]);
    expect(pages).toBe(1);
    const [a, b] = scores;
    // The second title starts below the last system of the first, with room between them.
    expect(b.header.page).toBe(0);
    expect(b.header.top).toBeGreaterThan(a.placements[1].top + 80);
    // Its first system sits below its own title.
    expect(b.placements[0].top).toBeGreaterThan(b.header.top);
  });

  it('starts a score on the next page when its title and first system do not fit', () => {
    const { scores, pages } = flow([{ systems: 5, systemPt: 100 }, { systems: 2, systemPt: 100 }]);
    const lastOfFirst = scores[0].placements.at(-1)!;
    expect(lastOfFirst.page).toBe(0);
    expect(scores[1].header.page).toBe(1);
    expect(scores[1].header.top).toBe(scores[0].header.top);
    expect(pages).toBe(2);
  });

  it('lets a score run on to the next page after its title, without repeating it', () => {
    const { scores } = flow([{ systems: 3, systemPt: 100 }, { systems: 8, systemPt: 100 }]);
    const b = scores[1];
    expect(b.header.page).toBe(0);
    expect(b.placements[0].page).toBe(0);
    expect(b.placements.at(-1)!.page).toBe(1);
    expect(b.placements.find((p) => p.page === 1)!.top).toBe(scores[0].header.top);
  });

  it('gives a single score the same pages as paginate', () => {
    const { scores } = flow([{ systems: 30, systemPt: 100 }]);
    expect(scores[0].placements).toEqual(paginate(30, 100).placements);
  });

  it('fits several short scores on one page of the PDF', async () => {
    const bytes = await buildScoresPdf([longScore(2, 'One'), longScore(2, 'Two')], labels);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe('score pdf: the intro of a piece', () => {
  const width = (s: string) => s.length * 10;

  it('wraps words to the width and cuts a word that is wider than a line', () => {
    expect(wrapText('one two three four', width, 90)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('abcdefghijklmnop', width, 50)).toEqual(['abcde', 'fghij', 'klmno', 'p']);
    expect(wrapText('', width, 50)).toEqual(['']);
  });

  it('stacks lines on a page and goes on to the next one when they run out of room', () => {
    const { placements, end } = flowLines(Array(100).fill(20));
    expect(placements[0]).toEqual({ page: 0, top: 42.5 });
    expect(placements.at(-1)!.page).toBeGreaterThan(0);
    expect(end.page).toBe(placements.at(-1)!.page);
    expect(flowLines([]).end).toEqual({ page: 0, top: 42.5 });
  });

  it('starts the scores where the intro ends, and below it when they fit', () => {
    const { scores } = flow([{ systems: 2, systemPt: 100 }], { page: 0, top: 200 });
    expect(scores[0].header.page).toBe(0);
    expect(scores[0].header.top).toBeGreaterThan(200);
    const full = flow([{ systems: 1, systemPt: 100 }], { page: 0, top: 760 });
    expect(full.scores[0].header.page).toBe(1);
  });

  const intro = { title: 'Album for the young', composer: 'Schumann', notes: 'Play slowly.\n\nWatch the pedal.' };

  it('puts the title of the piece in the document, and the scores after the intro on the same page when they fit', async () => {
    const pdf = await PDFDocument.load(await buildScoresPdf([longScore(2, 'One')], labels, intro));
    expect(pdf.getTitle()).toBe('Album for the young');
    expect(pdf.getPageCount()).toBe(1);
  });

  it('makes room for long notes, which run over several pages, and keeps the footer numbering', async () => {
    const notes = Array.from({ length: 160 }, (_, i) => `Line ${i} of the notes of the piece`).join('\n');
    const plain = await PDFDocument.load(await buildScoresPdf([longScore(2, 'One')], labels));
    const long = await PDFDocument.load(await buildScoresPdf([longScore(2, 'One')], labels, { ...intro, notes }));
    expect(long.getPageCount()).toBeGreaterThan(plain.getPageCount() + 1);
  });

  it('survives an untitled piece, text the font cannot draw, and no composer or notes', async () => {
    const odd = await PDFDocument.load(await buildScoresPdf([longScore(1)], labels, { title: '日本語', composer: 'ñ 作', notes: '音' }));
    expect(odd.getTitle()).toBe('???');
    const bare = await PDFDocument.load(await buildScoresPdf([longScore(1)], labels, { title: '  ', composer: '', notes: '\n \n' }));
    expect(bare.getTitle()).toBe('Untitled');
    expect(bare.getPageCount()).toBe(1);
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

  it('puts several scores in one PDF, and their pages add up to what the flow needs', async () => {
    const long = longScore(60, 'Long one');
    const alone = (sc: ScoreDto) => buildScorePdf(sc, labels).then((b) => PDFDocument.load(b)).then((d) => d.getPageCount());
    const a = await alone(long);
    const pdf = await PDFDocument.load(await buildScoresPdf([long, longScore(2, 'Short'), longScore(2, 'Third')], labels));
    // The short ones follow the long one: at most one page more than it, never one each.
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(a);
    expect(pdf.getPageCount()).toBeLessThanOrEqual(a + 1);
    expect(pdf.getTitle()).toBe('Collection');
  });

  it('keeps the title of a single score in the document', async () => {
    const pdf = await PDFDocument.load(await buildScoresPdf([longScore(1, 'Only')], labels));
    expect(pdf.getTitle()).toBe('Only');
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
