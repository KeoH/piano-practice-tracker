import { signal } from '@angular/core';
import { clamp } from './format';

/** Range on a timeline, in ms. */
export interface TimeRange {
  start: number;
  end: number;
}

type DragMode = 'start' | 'end' | 'move' | 'create';

interface DragState {
  mode: DragMode;
  pointerId: number;
  x0: number;
  ms0: number;
  sel0: TimeRange | null;
  moved: boolean;
}

export const MIN_SELECTION_MS = 100;
const DRAG_THRESHOLD_PX = 4;

export interface TimelineDragOptions {
  /** Element whose width spans the whole duration. */
  track: () => HTMLElement | undefined;
  durationMs: () => number;
  /** While locked the selection cannot be changed (clicks still seek). */
  locked: () => boolean;
  /** Click without dragging. */
  onSeek: (ms: number) => void;
  /** The user finished changing the selection (drag released or handle moved with the keyboard). */
  onCommit?: (sel: TimeRange | null) => void;
}

/**
 * Range selection on a timeline, shared by the slicer and the fragment loop: drag on the track to
 * create a range (or move it if the drag starts inside), drag the handles to resize it, click to
 * seek. The component wires the pointer events of the track and the handles to these methods.
 */
export class TimelineDrag {
  readonly selection = signal<TimeRange | null>(null);
  private drag: DragState | null = null;

  constructor(private readonly opts: TimelineDragOptions) {}

  msAt(clientX: number): number {
    const el = this.opts.track();
    const d = this.opts.durationMs();
    if (!el || d <= 0) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * d);
  }

  handleDown(ev: PointerEvent, mode: 'start' | 'end'): void {
    if (ev.button !== 0 || this.opts.locked()) return;
    ev.stopPropagation();
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.drag = { mode, pointerId: ev.pointerId, x0: ev.clientX, ms0: this.msAt(ev.clientX), sel0: this.selection(), moved: true };
  }

  trackDown(ev: PointerEvent): void {
    if (ev.button !== 0 || this.opts.durationMs() <= 0) return;
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    const ms = this.msAt(ev.clientX);
    const sel = this.selection();
    const inside = !!sel && ms >= sel.start && ms <= sel.end;
    this.drag = { mode: inside ? 'move' : 'create', pointerId: ev.pointerId, x0: ev.clientX, ms0: ms, sel0: sel, moved: false };
  }

  move(ev: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== ev.pointerId) return;
    if (!d.moved) {
      if (Math.abs(ev.clientX - d.x0) < DRAG_THRESHOLD_PX || this.opts.locked()) return;
      d.moved = true;
    }
    const ms = this.msAt(ev.clientX);
    const dur = this.opts.durationMs();
    const sel = this.selection();
    switch (d.mode) {
      case 'start':
        if (sel) this.selection.set({ start: clamp(ms, 0, sel.end - MIN_SELECTION_MS), end: sel.end });
        break;
      case 'end':
        if (sel) this.selection.set({ start: sel.start, end: clamp(ms, sel.start + MIN_SELECTION_MS, dur) });
        break;
      case 'move':
        if (d.sel0) {
          const len = d.sel0.end - d.sel0.start;
          const start = clamp(d.sel0.start + (ms - d.ms0), 0, Math.max(0, dur - len));
          this.selection.set({ start, end: start + len });
        }
        break;
      case 'create':
        this.selection.set({ start: Math.min(d.ms0, ms), end: Math.max(d.ms0, ms) });
        break;
    }
  }

  up(ev: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== ev.pointerId) return;
    this.drag = null;
    if (!d.moved) {
      this.opts.onSeek(this.msAt(ev.clientX));
      return;
    }
    const sel = this.selection();
    if (sel && sel.end - sel.start < MIN_SELECTION_MS) this.selection.set(d.mode === 'create' ? null : d.sel0);
    this.opts.onCommit?.(this.selection());
  }

  /** Arrows move a handle 100 ms (1 s with Shift). */
  handleKey(ev: KeyboardEvent, which: 'start' | 'end'): void {
    const sel = this.selection();
    if (!sel || this.opts.locked()) return;
    const step = ev.shiftKey ? 1000 : 100;
    let delta = 0;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') delta = -step;
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') delta = step;
    else return;
    ev.preventDefault();
    if (which === 'start') this.setStart(sel.start + delta);
    else this.setEnd(sel.end + delta);
    this.opts.onCommit?.(this.selection());
  }

  setStart(ms: number): void {
    const dur = this.opts.durationMs();
    const sel = this.selection() ?? { start: 0, end: dur };
    this.selection.set({ start: clamp(ms, 0, Math.max(0, sel.end - MIN_SELECTION_MS)), end: sel.end });
  }

  setEnd(ms: number): void {
    const dur = this.opts.durationMs();
    const sel = this.selection() ?? { start: 0, end: dur };
    this.selection.set({ start: sel.start, end: clamp(ms, sel.start + MIN_SELECTION_MS, dur) });
  }
}
