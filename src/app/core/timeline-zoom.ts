import { computed, signal } from '@angular/core';
import { clamp } from './format';

/** Zoom steps of the buttons and of each wheel notch. */
const ZOOM_STEP = 1.4;
const MAX_ZOOM = 400;
/** The deepest zoom shows 1 px per millisecond (a 16th note at 120 BPM is 125 px). */
const MAX_PX_PER_MS = 1;

/** Part of the take that is on screen, in ms. */
export interface ViewWindow {
  startMs: number;
  spanMs: number;
}

/** Highest zoom that still makes sense: a take can't be stretched beyond 1 px per millisecond. */
export function maxZoom(durationMs: number, viewportPx: number): number {
  if (durationMs <= 0 || viewportPx <= 0) return 1;
  return clamp((durationMs * MAX_PX_PER_MS) / viewportPx, 1, MAX_ZOOM);
}

/** The window that a scroller shows: `zoom` times as wide as the viewport, scrolled by `scrollLeft`. */
export function viewWindow(durationMs: number, zoom: number, scrollLeft: number, viewportPx: number): ViewWindow {
  if (durationMs <= 0 || viewportPx <= 0 || zoom <= 1) return { startMs: 0, spanMs: Math.max(0, durationMs) };
  const total = zoom * viewportPx;
  return { startMs: (scrollLeft / total) * durationMs, spanMs: durationMs / zoom };
}

/** `scrollLeft` after changing the zoom so that the ms under `anchorPx` (from the viewport's left edge) stays put. */
export function scrollAfterZoom(oldZoom: number, newZoom: number, scrollLeft: number, anchorPx: number, viewportPx: number): number {
  if (oldZoom <= 0 || viewportPx <= 0) return 0;
  const fraction = (scrollLeft + anchorPx) / (oldZoom * viewportPx);
  return clamp(fraction * newZoom * viewportPx - anchorPx, 0, Math.max(0, (newZoom - 1) * viewportPx));
}

/**
 * `scrollLeft` that keeps the playhead (`fraction` of the take) on screen: unchanged while it is
 * visible, otherwise the view jumps so the playhead sits a tenth in from the left edge.
 */
export function scrollToFollow(scrollLeft: number, zoom: number, viewportPx: number, fraction: number): number {
  if (zoom <= 1 || viewportPx <= 0) return 0;
  const total = zoom * viewportPx;
  const x = fraction * total;
  const margin = viewportPx * 0.05;
  if (x >= scrollLeft + margin && x <= scrollLeft + viewportPx - margin) return scrollLeft;
  return clamp(x - viewportPx * 0.1, 0, total - viewportPx);
}

export interface TimelineZoomOptions {
  /** The `overflow-x-auto` element whose first child is the track (`zoom × 100 %` wide). */
  scroller: () => HTMLElement | undefined;
  durationMs: () => number;
}

/**
 * Horizontal zoom of a timeline, shared by the slicer and the fragment player. The component binds
 * `zoom()` to the width of the track inside the scroller; every overlay positioned in `%` of the
 * track (handles, playhead) and `TimelineDrag` keep working unchanged. The canvas is only as wide as
 * the scroller (sticky) and draws `window()`.
 */
export class TimelineZoom {
  readonly zoom = signal(1);
  private readonly scrollLeft = signal(0);
  readonly viewportPx = signal(0);

  readonly window = computed(() => viewWindow(this.opts.durationMs(), this.zoom(), this.scrollLeft(), this.viewportPx()));
  readonly canZoomIn = computed(() => this.zoom() < maxZoom(this.opts.durationMs(), this.viewportPx()) - 1e-6);
  readonly canZoomOut = computed(() => this.zoom() > 1);

  constructor(private readonly opts: TimelineZoomOptions) {}

  /** Hooks the scroller up (call once it exists). Returns the cleanup. */
  attach(): () => void {
    const el = this.opts.scroller();
    if (!el) return () => undefined;
    const read = () => {
      this.scrollLeft.set(el.scrollLeft);
      this.viewportPx.set(el.clientWidth);
    };
    const onWheel = (ev: WheelEvent) => {
      // Ctrl + wheel zooms the timeline (a non-passive listener, or the webview would zoom itself).
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      this.zoomBy(ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ev.clientX - el.getBoundingClientRect().left);
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      el.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  }

  zoomIn(): void {
    this.zoomBy(ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomBy(1 / ZOOM_STEP);
  }

  fit(): void {
    this.zoomTo(1, 0);
  }

  /** Zoom by `factor` keeping the point `anchorPx` from the viewport's left edge in place (default: the centre). */
  zoomBy(factor: number, anchorPx = this.viewportPx() / 2): void {
    this.zoomTo(this.zoom() * factor, anchorPx);
  }

  /** Scrolls so the playhead (`ms`) is visible; called while playing. */
  follow(ms: number): void {
    const d = this.opts.durationMs();
    const el = this.opts.scroller();
    if (!el || d <= 0 || this.zoom() <= 1) return;
    const target = scrollToFollow(el.scrollLeft, this.zoom(), el.clientWidth, ms / d);
    if (Math.abs(target - el.scrollLeft) > 1) this.scrollTo(el, target);
  }

  private zoomTo(wanted: number, anchorPx: number): void {
    const el = this.opts.scroller();
    const viewport = this.viewportPx();
    const next = clamp(wanted, 1, maxZoom(this.opts.durationMs(), viewport));
    const old = this.zoom();
    if (Math.abs(next - old) < 1e-6) return;
    const left = el ? scrollAfterZoom(old, next, el.scrollLeft, anchorPx, viewport) : 0;
    this.zoom.set(next);
    if (el) {
      // Widen the track now (the template binds the same value on the next render) so the new
      // scroll position isn't clamped to the old width.
      const track = el.firstElementChild as HTMLElement | null;
      if (track) track.style.width = `${next * 100}%`;
      this.scrollTo(el, left);
    } else {
      this.scrollLeft.set(left);
    }
  }

  private scrollTo(el: HTMLElement, left: number): void {
    el.scrollLeft = left;
    this.scrollLeft.set(el.scrollLeft);
  }
}
