import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import type { ScoreDto, ScoreNoteDto } from '../../core/models';
import { PlaybackStore } from '../../core/playback.store';
import { newScore, scoreKey } from '../../core/score';
import { RULER_H, layoutOf, noteX, xOfTick, yOfStep } from '../../core/score-layout';
import { ScoreStore } from '../../core/score.store';
import { ScoreStaffComponent } from './score-staff.component';

const n = (id: string, tick: number, duration: number, key: number, accidental: ScoreNoteDto['accidental'] = null, tie = false): ScoreNoteDto => ({
  id,
  tick,
  duration_ticks: duration,
  key,
  accidental,
  tie,
});

describe('ScoreStaffComponent', () => {
  let fixture: ComponentFixture<ScoreStaffComponent>;
  let store: ScoreStore;
  let el: HTMLElement;
  /** The layout the component draws: lines fitted to the width the test gives the host (none: one line). */
  const layout = () => layoutOf(store.doc()!, store.zoom(), el.clientWidth > 0 ? el.clientWidth : Number.POSITIVE_INFINITY);

  /** jsdom has no layout: the SVG sits at the origin, so client coordinates are SVG coordinates. */
  const pointer = (target: EventTarget, type: string, x: number, y: number, extra: MouseEventInit = {}) =>
    target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...extra }));
  const svg = () => el.querySelector('svg')!;
  const noteEls = () => [...el.querySelectorAll<SVGGElement>('g[role="button"], g[role="img"]')];

  async function render(score: Partial<ScoreDto> = {}) {
    store.doc.set({ ...newScore('s1', 'Étude', ''), ...score });
    store.selectedId.set('s1');
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [mockApi({ previewNote: () => Promise.resolve() }).provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(ScoreStore);
    fixture = TestBed.createComponent(ScoreStaffComponent);
    el = fixture.nativeElement;
  });

  it('draws nothing without a score', () => {
    fixture.detectChanges();
    expect(svg()).toBeNull();
  });

  it('joins the eighths of a beat with one beam and leaves their flags out; a lone eighth keeps its flag', async () => {
    await render({ treble: [n('a', 0, 240, 76), n('b', 240, 240, 77), n('c', 960, 240, 79)] });
    const beams = [...el.querySelectorAll('line.stroke-fg')].filter((l) => l.getAttribute('stroke-width') === '4.2');
    expect(beams).toHaveLength(1);
    const flags = (id: string) => noteEls().find((g) => g.getAttribute('aria-label')?.includes(id === 'c' ? 'G5' : id === 'a' ? 'E5' : 'F5'))!.querySelectorAll('path').length;
    expect(flags('a')).toBe(0);
    expect(flags('b')).toBe(0);
    expect(flags('c')).toBe(1);
  });

  it('draws the clefs where the glyphs need them: the treble one on the bottom line, the bass dots on the F line', async () => {
    await render({ treble: [n('a', 0, 480, 64)] });
    const l = layout();
    const [treble, bass] = [...el.querySelectorAll<SVGTextElement>('text.music')].slice(0, 2);
    expect(Number(treble.getAttribute('y'))).toBe(l.systems[0].staves.treble.bottom + 1);
    expect(Number(bass.getAttribute('y'))).toBeCloseTo(l.systems[0].staves.bass.bottom - 30 + 25.8, 6);
  });

  it('draws a staff with five lines per hand, the bars, and a button per note with a readable label', async () => {
    await render({
      treble: [n('a', 0, 480, 64), n('b', 480, 960, 72, null)],
      bass: [n('c', 0, 1920, 43)],
    });
    expect(el.querySelectorAll('line.stroke-muted').length).toBeGreaterThanOrEqual(10);
    expect(noteEls()).toHaveLength(3);
    expect(noteEls().map((g) => g.getAttribute('aria-label')).sort()).toEqual([
      'C5, Half note, right hand, bar 1',
      'E4, Quarter note, right hand, bar 1',
      'G2, Whole note, left hand, bar 1',
    ]);
    expect(el.textContent).toContain('4'); // the time signature
    expect(svg().getAttribute('aria-label')).toBe('Score: Étude');
  });

  it('draws the gaps as rests: a bar rest per empty bar, and the rests around a note', async () => {
    await render({ bars: 2, treble: [n('a', 480, 480, 64)] });
    // Treble: half... bar 1 = quarter rest, quarter note, half rest; bar 2 = bar rest. Bass: two bar rests.
    const rects = el.querySelectorAll('g.fill-muted rect');
    const glyphs = [...el.querySelectorAll('g.fill-muted text')].map((t) => t.textContent);
    expect(rects).toHaveLength(2 /* half + bar in the treble */ + 2 /* bass bar rests */);
    expect(glyphs).toHaveLength(1); // the quarter rest
  });

  it('draws ledger lines for middle C, a dot for a dotted note and an accidental for a black key', async () => {
    await render({ treble: [n('a', 0, 720, 61, 'sharp')] }); // C♯4: first ledger line below the staff
    const g = noteEls()[0];
    expect(g.querySelectorAll('line').length).toBeGreaterThanOrEqual(2); // one ledger line and the stem
    expect(g.querySelector('circle')).not.toBeNull();
    expect(g.querySelector('text')?.textContent).toBe('♯');
  });

  it('shows the selected note and the one that is playing', async () => {
    await render({ treble: [n('a', 0, 480, 64), n('b', 480, 480, 67)] });
    store.selectNote('b');
    TestBed.inject(PlaybackStore).progress.set({ file_path: scoreKey('s1'), current_ms: 100, duration_ms: 4000, is_playing: true });
    fixture.detectChanges();
    const [a, b] = noteEls();
    expect(b.classList.contains('text-accent')).toBe(true);
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(a.classList.contains('text-ok')).toBe(true);
  });

  it('puts a note of the current value where the staff is clicked', async () => {
    await render();
    const l = layout();
    pointer(svg(), 'click', noteX(l, 480), yOfStep(l.systems[0], 'treble', 2)); // G4 on beat 2
    fixture.detectChanges();
    expect(store.doc()!.treble).toHaveLength(1);
    expect(store.doc()!.treble[0]).toMatchObject({ tick: 480, key: 67, duration_ticks: 480 });
    expect(noteEls()).toHaveLength(1);
  });

  it('snaps a click to the grid of the chosen value', async () => {
    await render();
    store.setKind('half');
    const l = layout();
    pointer(svg(), 'click', noteX(l, 700), yOfStep(l.systems[0], 'bass', 4)); // nearer to the half-note grid line at 960 than at 0
    expect(store.doc()!.bass[0]).toMatchObject({ tick: 960, duration_ticks: 960 });
  });

  it('does not put a note where there is no room, and deselects instead', async () => {
    await render({ treble: [n('a', 0, 960, 64)] });
    store.selectNote('a'); // selecting a note puts its value in the palette...
    store.setKind('quarter'); // ...and then a quarter note is chosen
    const l = layout();
    pointer(svg(), 'click', noteX(l, 480), yOfStep(l.systems[0], 'treble', 4)); // inside the half note
    expect(store.doc()!.treble).toHaveLength(1);
    expect(store.selectedNoteId()).toBeNull();
  });

  it('moves the playhead when the ruler is clicked', async () => {
    await render();
    const l = layout();
    pointer(svg(), 'pointerdown', noteX(l, 960) - 18, RULER_H / 2);
    expect(TestBed.inject(PlaybackStore).cursors()[scoreKey('s1')]).toBe(1333); // 960 ticks at 90 BPM
  });

  it('drops a note value dragged from the palette on the staff', async () => {
    await render();
    const l = layout();
    store.paletteDrag.set({ kind: 'eighth', dotted: false });
    pointer(window, 'pointermove', noteX(l, 240), yOfStep(l.systems[0], 'treble', 3));
    fixture.detectChanges();
    pointer(window, 'pointerup', noteX(l, 240), yOfStep(l.systems[0], 'treble', 3));
    expect(store.doc()!.treble[0]).toMatchObject({ tick: 240, key: 69, duration_ticks: 240 });
    expect(store.paletteDrag()).toBeNull();
  });

  it('drops nothing when the palette drag ends off the staff', async () => {
    await render();
    store.paletteDrag.set({ kind: 'quarter', dotted: false });
    pointer(window, 'pointermove', -50, -50);
    pointer(window, 'pointerup', -50, -50);
    expect(store.doc()!.treble).toHaveLength(0);
    expect(store.paletteDrag()).toBeNull();
  });

  it('does not put a note where a drag ends, and a click on a note does not either', async () => {
    await render({ treble: [n('a', 0, 480, 64)] });
    const l = layout();
    const from = { x: noteX(l, 0), y: yOfStep(l.systems[0], 'treble', 0) };
    pointer(noteEls()[0], 'pointerdown', from.x, from.y);
    pointer(window, 'pointermove', from.x + 60, from.y);
    pointer(window, 'pointerup', from.x + 60, from.y);
    pointer(svg(), 'click', from.x + 60, from.y); // the click the browser sends after the drag
    expect(store.doc()!.treble).toHaveLength(1);
    pointer(noteEls()[0], 'click', noteX(l, 480), yOfStep(l.systems[0], 'treble', 2));
    expect(store.doc()!.treble).toHaveLength(1);
  });

  it('draws a natural sign for a plain note after an altered one on the same line in the bar, and only there', async () => {
    await render({
      treble: [
        n('a', 0, 480, 61, 'sharp'), // C♯4
        n('b', 480, 480, 60), // C4: cancels the sharp
        n('c', 960, 480, 60), // C4 again: already natural
        n('d', 1440, 480, 62), // D4: a different line
        n('e', 1920, 480, 60), // C4 in the next bar: no accidental carried over
      ],
    });
    const sign = (i: number) => noteEls()[i].querySelector('text')?.textContent ?? null;
    expect([0, 1, 2, 3, 4].map(sign)).toEqual(['♯', '♮', null, null, null]);
  });

  it('cancels a flat the same way and names flats as flats', async () => {
    await render({ treble: [n('a', 0, 480, 70, 'flat'), n('b', 480, 480, 71)] });
    expect(noteEls()[0].getAttribute('aria-label')).toBe('B♭4, Quarter note, right hand, bar 1');
    expect(noteEls()[1].querySelector('text')?.textContent).toBe('♮');
  });

  it('reaches every bar of a 3/4 score with a dotted half note, the case a half-note grid missed', async () => {
    await render({ beats: 3, bars: 4 });
    store.setKind('half');
    store.toggleDotted();
    const l = layout();
    for (const bar of [0, 1, 2, 3]) {
      pointer(svg(), 'click', noteX(l, bar * 1440) + 6, yOfStep(l.systems[0], 'treble', 4)); // a little to the right of the bar start
      fixture.detectChanges();
    }
    expect(store.doc()!.treble.map((x) => [x.tick, x.duration_ticks])).toEqual([[0, 1440], [1440, 1440], [2880, 1440], [4320, 1440]]);
  });

  it('draws a chord with one stem and sets a second to the other side of it', async () => {
    await render({ treble: [n('a', 0, 480, 60), n('b', 0, 480, 64), n('c', 0, 480, 65)] }); // C4 E4 F4: E and F are neighbours
    const stems = [...el.querySelectorAll('g[role="button"] line[stroke-width="1.4"]')];
    const unique = new Set(stems.map((x) => ['x1', 'y1', 'y2'].map((a) => x.getAttribute(a)).join()));
    expect(unique.size).toBe(1); // every head draws the same chord stem
    const xs = noteEls().map((g) => +g.querySelector('ellipse')!.getAttribute('cx')!);
    expect(new Set(xs).size).toBe(2); // one head is beside the others
    expect(noteEls()).toHaveLength(3);
  });

  it('draws an arc for a tie, and none for a note that is not tied', async () => {
    await render({ treble: [n('a', 1440, 480, 60, null, true), n('b', 1920, 480, 60), n('c', 2400, 480, 64)] });
    expect(el.querySelectorAll('path.text-fg')).toHaveLength(1);
    await render({ treble: [n('a', 1440, 480, 60), n('b', 1920, 480, 60)] });
    expect(el.querySelectorAll('path.text-fg')).toHaveLength(0);
  });

  describe('slurs', () => {
    const phrase = [n('a', 0, 480, 60), n('b', 480, 480, 64), n('c', 960, 480, 67), n('d', 1440, 480, 64)];
    const slur = (id: string, from: string, to: string) => ({ id, from, to });
    const arcs = () => [...el.querySelectorAll('path.slur')];

    it('draws a curve per slur, none when there are no slurs, and leaves the ties alone', async () => {
      await render({ treble: phrase });
      expect(arcs()).toHaveLength(0);
      await render({ treble: phrase, slurs: [slur('s1', 'a', 'd'), slur('s2', 'b', 'c')] });
      expect(arcs()).toHaveLength(2);
      expect(el.querySelectorAll('path.text-fg:not(.slur)')).toHaveLength(0);
    });

    it('runs from the first note to the last, over the noteheads when the stems point down', async () => {
      await render({ treble: [n('a', 0, 480, 72), n('b', 480, 480, 76), n('c', 960, 480, 79)], slurs: [slur('s1', 'a', 'c')] });
      const l = layout();
      const nums = arcs()[0].getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number);
      expect(nums[0]).toBeCloseTo(noteX(l, 0), 0); // starts at the first notehead
      expect(nums[nums.length - 2]).toBeCloseTo(noteX(l, 960), 0); // ends at the last
      const top = Math.min(...noteEls().map((g) => +g.querySelector('ellipse')!.getAttribute('cy')!));
      expect(nums[3]).toBeLessThan(top); // the curve's control points are above every notehead
    });

    it('goes under the notes when every stem points up', async () => {
      await render({ treble: [n('a', 0, 480, 60), n('b', 480, 480, 62)], slurs: [slur('s1', 'a', 'b')] });
      const nums = arcs()[0].getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number);
      const heads = noteEls().map((g) => +g.querySelector('ellipse')!.getAttribute('cy')!);
      expect(nums[3]).toBeGreaterThan(Math.max(...heads));
    });

    it('is split in two by a line break', async () => {
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 900 });
      await render({ beats: 3, bars: 6, treble: [n('a', 3 * 480, 480, 60), n('b', 5 * 480, 480, 62)], slurs: [slur('s1', 'a', 'b')] });
      window.dispatchEvent(new Event('resize'));
      fixture.detectChanges();
      expect(layout().systems).toHaveLength(2);
      expect(arcs()).toHaveLength(1); // both notes are on the first line
      await render({ beats: 3, bars: 6, treble: [n('a', 3 * 480, 480, 60), n('b', 12 * 480, 480, 62)], slurs: [slur('s1', 'a', 'b')] });
      expect(arcs()).toHaveLength(2);
    });

    it('is drawn in a read-only view too, and shift-click slurs the selected note to another', async () => {
      await render({ treble: phrase });
      const down = (i: number, shiftKey: boolean) => {
        const g = noteEls()[i];
        const e = new MouseEvent('pointerdown', { button: 0, bubbles: true, shiftKey, clientX: 0, clientY: 0 });
        g.dispatchEvent(e);
        fixture.detectChanges();
      };
      down(0, false); // selects a
      expect(store.selectedNoteId()).toBe('a');
      down(2, true); // shift-click c
      expect(store.doc()!.slurs.map((x) => [x.from, x.to])).toEqual([['a', 'c']]);
      expect(store.selectedNoteId()).toBe('a'); // the selection stays
      fixture.detectChanges();
      expect(arcs()).toHaveLength(1);
      // A shift press must not give the note focus, which would select it and move the start of the next slur;
      // any other press keeps its default (focus, and with it the keyboard).
      const prevented = (i: number, shiftKey: boolean) => {
        const e = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true, shiftKey });
        noteEls()[i].dispatchEvent(e);
        return e.defaultPrevented;
      };
      expect([prevented(1, false), prevented(1, true), prevented(1, false)]).toEqual([false, true, false]);
      down(2, true); // the same pair again takes it away
      expect(store.doc()!.slurs).toEqual([]);
    });
  });

  describe('the repeat sign as a piece of the palette', () => {
    const midY = () => (layout().systems[0].staves.treble.top + layout().systems[0].staves.bass.bottom) / 2;
    const barX = (bar: number) => layout().systems[0].x0 + (bar + 1) * 1920 * layout().systems[0].ppt;
    const dots = () => [...el.querySelectorAll('svg > circle')].map((c) => +c.getAttribute('cx')!);

    it('shows where it would go while it is dragged, on the closest bar line, and puts it there when dropped', async () => {
      await render({ bars: 4 });
      store.repeatDrag.set(true);
      pointer(window, 'pointermove', barX(1) - 70, midY());
      fixture.detectChanges();
      const ghost = el.querySelector('svg > g.text-accent circle')!;
      expect(+ghost.getAttribute('cx')!).toBe(barX(1) - 13);
      expect(dots()).toEqual([]); // nothing is placed yet
      pointer(window, 'pointerup', barX(1) - 70, midY());
      fixture.detectChanges();
      expect(store.doc()!.repeat_bar).toBe(1);
      expect(store.repeatDrag()).toBe(false);
      expect(store.repeatSelected()).toBe(true);
      expect(new Set(dots())).toEqual(new Set([barX(1) - 13]));
      expect(el.querySelector('svg > g.text-accent circle')).toBeNull(); // the ghost is gone
    });

    it('puts nothing when the drag ends off the staff', async () => {
      await render({ bars: 4 });
      store.repeatDrag.set(true);
      pointer(window, 'pointermove', -50, -50);
      pointer(window, 'pointerup', -50, -50);
      expect(store.doc()!.repeat_bar).toBeNull();
      expect(store.repeatDrag()).toBe(false);
    });

    it('is put by a click on the staff once it is chosen, and the tool is let go afterwards', async () => {
      await render({ bars: 4 });
      store.toggleRepeatTool();
      pointer(window, 'pointermove', barX(2) - 20, midY());
      fixture.detectChanges();
      expect(el.querySelector('svg > g.text-accent circle')).not.toBeNull();
      expect(el.querySelector('svg > g.text-accent ellipse')).toBeNull(); // not a note's ghost too
      pointer(svg(), 'click', barX(2) - 20, midY());
      expect(store.doc()!.repeat_bar).toBe(2);
      expect(store.repeatTool()).toBe(false);
      expect(store.doc()!.treble).toHaveLength(0); // it did not put a note too
    });

    it('is moved by dragging the sign to another bar line, and selected by pressing it', async () => {
      await render({ bars: 4, repeat_bar: 0 });
      const target = el.querySelector<SVGRectElement>('svg > rect[role="button"]')!;
      pointer(target, 'pointerdown', barX(0) - 5, midY());
      expect(store.repeatSelected()).toBe(true);
      expect(store.repeatDrag()).toBe(true);
      pointer(window, 'pointermove', barX(2) - 5, midY());
      pointer(window, 'pointerup', barX(2) - 5, midY());
      fixture.detectChanges();
      expect(store.doc()!.repeat_bar).toBe(2);
      expect(store.selectedNoteId()).toBeNull();
    });

    it('shows the selected sign in the accent colour, and a click on empty paper lets it go', async () => {
      await render({ bars: 4, repeat_bar: 1 });
      expect(el.querySelector('svg > circle.fill-fg')).not.toBeNull();
      store.selectRepeat();
      fixture.detectChanges();
      expect(el.querySelector('svg > circle.fill-accent')).not.toBeNull();
      expect(el.querySelector('svg > circle.fill-fg')).toBeNull();
      pointer(svg(), 'click', layout().systems[0].x0 + 30, 5); // the ruler: not a click on the staff
      expect(store.repeatSelected()).toBe(true);
      pointer(svg(), 'click', layout().systems[0].x0 + 30, layout().systems[0].staves.treble.top + 20);
      expect(store.repeatSelected()).toBe(false);
    });

    it('is not offered in a read-only view', async () => {
      await render({ bars: 4, repeat_bar: 1 });
      fixture.componentRef.setInput('score', { ...store.doc()! });
      fixture.detectChanges();
      expect(el.querySelector('svg > rect[role="button"]')).toBeNull();
    });
  });

  it('draws the repeat sign (two dots in each staff before the final bar line) only when the score repeats', async () => {
    await render({ bars: 2 });
    expect(el.querySelectorAll('svg > circle')).toHaveLength(0);
    await render({ bars: 2, repeat_bar: 1 });
    expect(el.querySelectorAll('svg > circle')).toHaveLength(4);
    const xs = [...el.querySelectorAll('svg > circle')].map((c) => +c.getAttribute('cx')!);
    expect(new Set(xs).size).toBe(1);
    expect(xs[0]).toBeLessThan(layout().systems[0].right - 6); // before the final double line
  });

  it('draws the repeat sign at the end of any bar, with its own thin and thick line, and the final bar line after the rest', async () => {
    await render({ bars: 4, repeat_bar: 1 });
    const sys = layout().systems[0];
    const barEnd = sys.x0 + 2 * 1920 * sys.ppt;
    const dots = [...el.querySelectorAll('svg > circle')].map((c) => +c.getAttribute('cx')!);
    expect(dots).toHaveLength(4);
    expect(new Set(dots)).toEqual(new Set([barEnd - 13]));
    const thick = [...el.querySelectorAll('svg > line[stroke-width="3.2"]')].map((x) => +x.getAttribute('x1')!);
    expect(thick).toEqual(expect.arrayContaining([barEnd, sys.right])); // the repeat's and the closing double bar's
    expect(thick).toHaveLength(2);
    await render({ bars: 4, repeat_bar: 0 });
    expect(new Set([...el.querySelectorAll('svg > circle')].map((c) => +c.getAttribute('cx')!))).toEqual(new Set([sys.x0 + 1920 * sys.ppt - 13]));
  });

  it('draws the repeat sign in the system of its bar', async () => {
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 900 });
    await render({ beats: 3, bars: 6, repeat_bar: 1 });
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();
    expect(layout().systems).toHaveLength(2);
    const ys = [...el.querySelectorAll('svg > circle')].map((c) => +c.getAttribute('cy')!);
    expect(ys).toHaveLength(4);
    expect(ys.every((y) => y < layout().systems[1].top)).toBe(true);
  });

  it('draws the repeat sign in the last line when it closes the score', async () => {
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 900 });
    await render({ beats: 3, bars: 6, repeat_bar: 5 });
    window.dispatchEvent(new Event('resize'));
    fixture.detectChanges();
    expect(layout().systems).toHaveLength(2);
    const ys = [...el.querySelectorAll('svg > circle')].map((c) => +c.getAttribute('cy')!);
    expect(ys).toHaveLength(4);
    expect(ys.every((y) => y >= layout().systems[1].top)).toBe(true);
  });

  it('draws the closing bar of a pickup as short as what the pickup lacks, with its bar rest', async () => {
    await render({ bars: 2, pickup_ticks: 3 * 480 }); // 4/4: a pickup of three beats and a closing bar of one
    const sys = layout().systems[0];
    expect(layout().systems).toHaveLength(1);
    const xs = [...el.querySelectorAll('svg > line.stroke-muted')].map((x) => +x.getAttribute('x1')!);
    const barLines = [...new Set(xs)].sort((a, b) => a - b).filter((x) => x > 20);
    // The width of the pickup bar and of the closing bar add up to one whole bar (320 px at 80 px per beat).
    const first = barLines[1] - barLines[0];
    const last = sys.right - barLines[1];
    expect(first).toBeCloseTo(240);
    expect(last).toBeCloseTo(80);
    expect(first + last).toBeCloseTo(320);
    expect(sys.endTick).toBe(1920);
    // Short bars are not whole rests: each staff has a quarter rest and a half rest in the pickup (3 beats) and a
    // quarter rest in the closing bar (1 beat), so only the half rests are rectangles.
    expect(el.querySelectorAll('g.fill-muted rect')).toHaveLength(2);
    expect(el.querySelectorAll('g.fill-muted text')).toHaveLength(4);
  });

  it('shows no accidental on the note a tie carries over the bar line', async () => {
    await render({ treble: [n('a', 1440, 480, 61, 'sharp', true), n('b', 1920, 480, 61, 'sharp')] });
    const signs = noteEls().map((g) => g.querySelector('text')?.textContent ?? null);
    expect(signs).toEqual(['♯', null]);
  });

  it('numbers the whole bars from 1, leaves the pickup bar unnumbered and draws it short', async () => {
    await render({ bars: 3, pickup_ticks: 480 });
    const numbers = [...el.querySelectorAll('svg > text.tabular')].map((t) => t.textContent?.trim());
    expect(numbers).toEqual(['1', '2']);
    const w = +svg().getAttribute('width')!;
    store.doc.update((d) => ({ ...d!, pickup_ticks: 0 }));
    fixture.detectChanges();
    expect(+svg().getAttribute('width')!).toBeGreaterThan(w);
  });

  describe('in several lines', () => {
    /** Six 3/4 bars of 240 px in a 900 px view: three bars per line. */
    async function renderWrapped(extra: Partial<ScoreDto> = {}) {
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 900 });
      await render({ beats: 3, bars: 6, ...extra });
      window.dispatchEvent(new Event('resize'));
      fixture.detectChanges();
    }
    const clefs = () => [...el.querySelectorAll('svg > text.music')].map((t) => t.textContent);

    it('breaks the bars into lines, each with its own clefs, and the time signature only on the first', async () => {
      await renderWrapped();
      expect(layout().systems).toHaveLength(2);
      expect(+svg().getAttribute('height')!).toBe(layout().height);
      expect(clefs()).toEqual(['\u{1D11E}', '\u{1D122}', '\u{1D11E}', '\u{1D122}']);
      expect(el.querySelectorAll('svg > g[font-weight="700"]')).toHaveLength(2); // the two digits of each staff, first line only
    });

    it('numbers the bars through the lines and ends the score with a double bar on the last', async () => {
      await renderWrapped();
      expect([...el.querySelectorAll('svg > text.tabular')].map((t) => t.textContent?.trim())).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(el.querySelectorAll('line[stroke-width="3.2"]')).toHaveLength(1);
    });

    it('draws a note in the line of its bar', async () => {
      await renderWrapped({ treble: [n('a', 0, 480, 64), n('b', 4320, 480, 64)] });
      const [first, second] = layout().systems;
      const ys = noteEls().map((g) => +g.querySelector('ellipse')!.getAttribute('cy')!);
      expect(ys).toEqual([yOfStep(first, 'treble', 0), yOfStep(second, 'treble', 0)]);
    });

    it('puts a note in the second line when it is clicked there', async () => {
      await renderWrapped();
      const l = layout();
      pointer(svg(), 'click', noteX(l, 4320 + 480), yOfStep(l.systems[1], 'treble', 2));
      expect(store.doc()!.treble.map((x) => [x.tick, x.key])).toEqual([[4800, 67]]);
      pointer(svg(), 'click', noteX(l, 480), yOfStep(l.systems[0], 'bass', 4));
      expect(store.doc()!.bass.map((x) => x.tick)).toEqual([480]);
    });

    it('moves a note from one line to another', async () => {
      await renderWrapped({ treble: [n('a', 0, 480, 64)] });
      const l = layout();
      const from = { x: noteX(l, 0), y: yOfStep(l.systems[0], 'treble', 0) };
      const to = { x: noteX(l, 4320 + 480), y: yOfStep(l.systems[1], 'treble', 0) };
      pointer(noteEls()[0], 'pointerdown', from.x, from.y);
      pointer(window, 'pointermove', from.x + 20, from.y + 20);
      pointer(window, 'pointermove', to.x, to.y);
      pointer(window, 'pointerup', to.x, to.y);
      expect(store.doc()!.treble[0]).toMatchObject({ id: 'a', tick: 4800 });
    });

    it('splits a tie that crosses a line break into an arc to the end of the first line and one from the start of the next', async () => {
      await renderWrapped({ treble: [n('a', 3840, 480, 60, null, true), n('b', 4320, 480, 60)] });
      expect(el.querySelectorAll('path.text-fg')).toHaveLength(2);
      await renderWrapped({ treble: [n('a', 0, 480, 60, null, true), n('b', 480, 480, 60)] });
      expect(el.querySelectorAll('path.text-fg')).toHaveLength(1);
    });

    it('moves the playhead to the line of the position', async () => {
      await renderWrapped();
      const playback = TestBed.inject(PlaybackStore);
      playback.progress.set({ file_path: scoreKey('s1'), current_ms: 5000, duration_ms: 9000, is_playing: true }); // 90 BPM: 3375 ticks...
      fixture.detectChanges();
      const x = +el.querySelector('svg > g line.stroke-accent')!.getAttribute('y1')!;
      expect(x).toBeLessThan(layout().systems[1].top);
      playback.progress.set({ file_path: scoreKey('s1'), current_ms: 8000, duration_ms: 9000, is_playing: true }); // 5400 ticks: second line
      fixture.detectChanges();
      expect(+el.querySelector('svg > g line.stroke-accent')!.getAttribute('y1')!).toBeGreaterThan(layout().systems[1].top);
    });

    it('lays out again when the view changes width', async () => {
      await renderWrapped();
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 5000 });
      window.dispatchEvent(new Event('resize'));
      fixture.detectChanges();
      expect(layout().systems).toHaveLength(1);
      expect(+svg().getAttribute('height')!).toBe(layout().height);
    });
  });

  describe('read-only, for a challenge', () => {
    const shown = (extra: Partial<ScoreDto> = {}): ScoreDto => ({ ...newScore('c', 'Challenge', ''), ...extra });
    async function show(score: ScoreDto, inputs: Record<string, unknown> = {}) {
      fixture.componentRef.setInput('score', score);
      for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('draws the score it is given, not the one being edited', async () => {
      store.doc.set(shown({ treble: [n('x', 0, 480, 60)] }));
      await show(shown({ treble: [n('a', 0, 480, 64), n('b', 480, 480, 67)] }));
      expect(noteEls()).toHaveLength(2);
      expect(svg().getAttribute('aria-label')).toBe('Score: Challenge');
    });

    it('cannot be edited: a click, a drag or the ruler change nothing', async () => {
      const score = shown({ treble: [n('a', 0, 480, 64)] });
      await show(score);
      const l = layoutOf(score, 80);
      pointer(svg(), 'click', noteX(l, 960), yOfStep(l.systems[0], 'treble', 2));
      pointer(noteEls()[0], 'pointerdown', noteX(l, 0), yOfStep(l.systems[0], 'treble', 0));
      pointer(window, 'pointermove', noteX(l, 960), yOfStep(l.systems[0], 'treble', 4));
      pointer(window, 'pointerup', noteX(l, 960), yOfStep(l.systems[0], 'treble', 4));
      pointer(svg(), 'pointerdown', noteX(l, 480), RULER_H / 2);
      expect(score.treble).toHaveLength(1);
      expect(store.doc()).toBeNull();
      expect(store.selectedNoteId()).toBeNull();
      expect(el.querySelector('g.text-rec[opacity], g.text-accent[opacity]')).toBeNull(); // no ghost
      expect(noteEls()[0].getAttribute('role')).toBe('img');
      expect(noteEls()[0].hasAttribute('tabindex')).toBe(false);
    });

    it('colours the notes by how they went', async () => {
      await show(shown({ treble: [n('a', 0, 480, 60), n('b', 480, 480, 62), n('c', 960, 480, 64), n('d', 1440, 480, 65)] }), {
        noteStates: { a: 'perfect', b: 'good', c: 'missed', d: null },
      });
      expect(noteEls().map((g) => ['text-ok', 'text-ok/60', 'text-rec', 'text-fg'].find((c) => g.classList.contains(c)))).toEqual([
        'text-ok',
        'text-ok/60',
        'text-rec',
        'text-fg',
      ]);
    });

    it('draws a cross where a played note hit nothing, on the line of its key', async () => {
      const score = shown();
      await show(score, { marks: [{ tick: 480, key: 64 }, { tick: 960, key: 48 }] });
      const crosses = [...el.querySelectorAll('path.stroke-rec')];
      expect(crosses).toHaveLength(2);
      const l = layoutOf(score, 80);
      // E4 is the bottom line of the treble staff, C3 is below the bass staff's middle.
      expect(crosses[0].getAttribute('d')).toContain(`M ${noteX(l, 480) - 5} ${yOfStep(l.systems[0], 'treble', 0) - 5}`);
    });

    it('draws the playhead where it is told, and none otherwise', async () => {
      const score = shown({ bars: 2 });
      await show(score);
      expect(el.querySelector('svg > g line.stroke-accent')).toBeNull();
      await show(score, { playheadTick: 960 });
      const l = layoutOf(score, 80);
      expect(+el.querySelector('svg > g line.stroke-accent')!.getAttribute('x1')!).toBe(xOfTick(l, 960));
    });

    it('uses its own zoom', async () => {
      const score = shown();
      await show(score, { zoom: 48 });
      expect(+svg().getAttribute('width')!).toBe(layoutOf(score, 48).width);
    });
  });

  it('moves a dragged note to another time, line and hand', async () => {
    await render({ treble: [n('a', 0, 480, 64)] });
    const l = layout();
    const from = { x: noteX(l, 0), y: yOfStep(l.systems[0], 'treble', 0) };
    pointer(noteEls()[0], 'pointerdown', from.x, from.y);
    pointer(window, 'pointermove', from.x + 40, from.y + 40);
    fixture.detectChanges();
    const to = { x: noteX(l, 960), y: yOfStep(l.systems[0], 'bass', 4) };
    pointer(window, 'pointermove', to.x, to.y);
    pointer(window, 'pointerup', to.x, to.y);
    expect(store.doc()!.treble).toHaveLength(0);
    expect(store.doc()!.bass[0]).toMatchObject({ id: 'a', tick: 960, duration_ticks: 480 });
  });

  it('selects a note on a click without moving it', async () => {
    await render({ treble: [n('a', 0, 480, 64)] });
    const l = layout();
    pointer(noteEls()[0], 'pointerdown', noteX(l, 0), yOfStep(l.systems[0], 'treble', 0));
    pointer(window, 'pointerup', noteX(l, 0), yOfStep(l.systems[0], 'treble', 0));
    expect(store.selectedNoteId()).toBe('a');
    expect(store.canUndo()).toBe(false);
  });

  it('shows where the note would land, in red when it does not fit', async () => {
    await render({ treble: [n('a', 0, 960, 64)] });
    const l = layout();
    pointer(window, 'pointermove', noteX(l, 960), yOfStep(l.systems[0], 'treble', 2));
    fixture.detectChanges();
    expect(el.querySelector('g.text-accent[opacity]')).not.toBeNull();
    pointer(window, 'pointermove', noteX(l, 480), yOfStep(l.systems[0], 'treble', 2)); // inside the half note
    fixture.detectChanges();
    expect(el.querySelector('g.text-rec[opacity]')).not.toBeNull();
  });

  it('gets wider with the zoom and with more bars', async () => {
    await render();
    const w = (): number => +svg().getAttribute('width')!;
    const base = w();
    store.zoom.set(128);
    fixture.detectChanges();
    expect(w()).toBeGreaterThan(base);
    store.setBars(8);
    fixture.detectChanges();
    expect(w()).toBeGreaterThan(base * 1.5);
  });
});
