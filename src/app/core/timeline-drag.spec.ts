import { MIN_SELECTION_MS, TimelineDrag, type TimeRange } from './timeline-drag';

/** A 1000 px track starting at x = 100 that spans 10 s: 1 px = 10 ms. */
function setup(opts: { locked?: boolean; duration?: number } = {}) {
  const track = document.createElement('div');
  track.getBoundingClientRect = () => ({ left: 100, width: 1000, top: 0, height: 40, right: 1100, bottom: 40, x: 100, y: 0, toJSON: () => ({}) });
  track.setPointerCapture = () => undefined;
  let locked = opts.locked ?? false;
  const seeks: number[] = [];
  const commits: (TimeRange | null)[] = [];
  const drag = new TimelineDrag({
    track: () => track,
    durationMs: () => opts.duration ?? 10_000,
    locked: () => locked,
    onSeek: (ms) => seeks.push(ms),
    onCommit: (sel) => commits.push(sel),
  });
  const ev = (clientX: number, extra: Partial<PointerEvent> = {}) =>
    ({
      button: 0,
      pointerId: 1,
      clientX,
      currentTarget: track,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...extra,
    }) as unknown as PointerEvent;
  return { drag, ev, seeks, commits, lock: (v: boolean) => (locked = v) };
}

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, preventDefault: () => undefined }) as unknown as KeyboardEvent;

describe('TimelineDrag', () => {
  it('maps the pointer position to time, clamped to the track', () => {
    const { drag } = setup();
    expect(drag.msAt(100)).toBe(0);
    expect(drag.msAt(600)).toBe(5000);
    expect(drag.msAt(50)).toBe(0);
    expect(drag.msAt(5000)).toBe(10_000);
  });

  it('returns 0 without a duration', () => {
    const { drag } = setup({ duration: 0 });
    expect(drag.msAt(600)).toBe(0);
  });

  it('seeks on a click without dragging', () => {
    const { drag, ev, seeks, commits } = setup();
    drag.trackDown(ev(300));
    drag.move(ev(302));
    drag.up(ev(302));
    expect(seeks).toEqual([2020]);
    expect(commits).toEqual([]);
    expect(drag.selection()).toBeNull();
  });

  it('creates a range by dragging, in either direction', () => {
    const { drag, ev, commits } = setup();
    drag.trackDown(ev(500));
    drag.move(ev(300));
    drag.up(ev(300));
    expect(drag.selection()).toEqual({ start: 2000, end: 4000 });
    expect(commits).toEqual([{ start: 2000, end: 4000 }]);
  });

  it('drops a created range that is too short', () => {
    const { drag, ev, commits } = setup();
    drag.trackDown(ev(500));
    drag.move(ev(505));
    drag.up(ev(505));
    expect(drag.selection()).toBeNull();
    expect(commits).toEqual([null]);
  });

  it('moves the range when the drag starts inside it, without leaving the track', () => {
    const { drag, ev } = setup();
    drag.selection.set({ start: 1000, end: 3000 });
    drag.trackDown(ev(300));
    drag.move(ev(400));
    expect(drag.selection()).toEqual({ start: 2000, end: 4000 });
    drag.move(ev(5000));
    drag.up(ev(5000));
    expect(drag.selection()).toEqual({ start: 8000, end: 10_000 });
  });

  it('resizes with the handles, keeping the minimum length', () => {
    const { drag, ev } = setup();
    drag.selection.set({ start: 1000, end: 3000 });
    drag.handleDown(ev(200), 'start');
    drag.move(ev(1000));
    drag.up(ev(1000));
    expect(drag.selection()).toEqual({ start: 3000 - MIN_SELECTION_MS, end: 3000 });

    drag.handleDown(ev(400), 'end');
    drag.move(ev(700));
    drag.up(ev(700));
    expect(drag.selection()).toEqual({ start: 2900, end: 6000 });
  });

  it('ignores other pointers and buttons', () => {
    const { drag, ev } = setup();
    drag.trackDown(ev(200, { button: 2 }));
    drag.move(ev(600));
    expect(drag.selection()).toBeNull();

    drag.trackDown(ev(200));
    drag.move(ev(600, { pointerId: 2 }));
    drag.up(ev(600, { pointerId: 2 }));
    expect(drag.selection()).toBeNull();
  });

  it('only seeks while locked', () => {
    const { drag, ev, seeks, lock } = setup({ locked: true });
    drag.selection.set({ start: 1000, end: 2000 });
    drag.handleDown(ev(200), 'start');
    drag.trackDown(ev(500));
    drag.move(ev(800));
    drag.up(ev(800));
    expect(drag.selection()).toEqual({ start: 1000, end: 2000 });
    expect(seeks).toEqual([7000]);

    drag.handleKey(key('ArrowRight'), 'end');
    expect(drag.selection()).toEqual({ start: 1000, end: 2000 });
    lock(false);
    drag.handleKey(key('ArrowRight'), 'end');
    expect(drag.selection()).toEqual({ start: 1000, end: 2100 });
  });

  it('moves the handles with the arrows (1 s with Shift)', () => {
    const { drag, commits } = setup();
    drag.selection.set({ start: 1000, end: 5000 });
    drag.handleKey(key('ArrowLeft'), 'start');
    drag.handleKey(key('ArrowUp', true), 'end');
    drag.handleKey(key('ArrowDown'), 'end');
    drag.handleKey(key('Enter'), 'end');
    expect(drag.selection()).toEqual({ start: 900, end: 5900 });
    expect(commits).toHaveLength(3);
  });

  it('sets the ends from a missing selection', () => {
    const { drag } = setup();
    drag.setStart(4000);
    expect(drag.selection()).toEqual({ start: 4000, end: 10_000 });
    drag.selection.set(null);
    drag.setEnd(20_000);
    expect(drag.selection()).toEqual({ start: 0, end: 10_000 });
    drag.setEnd(0);
    expect(drag.selection()).toEqual({ start: 0, end: MIN_SELECTION_MS });
  });
});
