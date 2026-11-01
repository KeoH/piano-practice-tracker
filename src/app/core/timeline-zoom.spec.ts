import { maxZoom, scrollAfterZoom, scrollToFollow, viewWindow } from './timeline-zoom';

describe('timeline-zoom', () => {
  it('shows the whole take at zoom 1', () => {
    expect(viewWindow(60_000, 1, 0, 1000)).toEqual({ startMs: 0, spanMs: 60_000 });
    expect(viewWindow(0, 4, 0, 1000)).toEqual({ startMs: 0, spanMs: 0 });
  });

  it('maps the scroll position to a window', () => {
    // 4x zoom of a 60 s take on a 1000 px viewport: a 4000 px track, scrolled a quarter of the way.
    const w = viewWindow(60_000, 4, 1000, 1000);
    expect(w.spanMs).toBe(15_000);
    expect(w.startMs).toBe(15_000);
  });

  it('caps the zoom at 1 px per millisecond', () => {
    expect(maxZoom(60_000, 1000)).toBe(60);
    expect(maxZoom(500, 1000)).toBe(1);
    expect(maxZoom(60_000_000, 1000)).toBe(400);
    expect(maxZoom(0, 1000)).toBe(1);
  });

  it('keeps the anchor in place when zooming', () => {
    // Anchor at 500 px of a 1000 px viewport while unscrolled at zoom 1 = 50 % of the take.
    const left = scrollAfterZoom(1, 4, 0, 500, 1000);
    expect(left).toBe(1500); // 50 % of 4000 px minus the 500 px anchor
    const w = viewWindow(60_000, 4, left, 1000);
    expect(w.startMs + (500 / 1000) * w.spanMs).toBeCloseTo(30_000);
  });

  it('clamps the scroll when zooming back out', () => {
    expect(scrollAfterZoom(4, 1, 3000, 500, 1000)).toBe(0);
    expect(scrollAfterZoom(4, 2, 3000, 1000, 1000)).toBeLessThanOrEqual(1000);
  });

  it('follows the playhead only when it leaves the view', () => {
    // 4000 px wide, viewport 1000 px, scrolled to 1000: the view covers 25-50 % of the take.
    expect(scrollToFollow(1000, 4, 1000, 0.3)).toBe(1000);
    expect(scrollToFollow(1000, 4, 1000, 0.6)).toBe(2300); // 2400 px minus 10 % of the viewport
    expect(scrollToFollow(1000, 4, 1000, 0.05)).toBe(100);
    expect(scrollToFollow(0, 1, 1000, 0.9)).toBe(0);
  });
});
