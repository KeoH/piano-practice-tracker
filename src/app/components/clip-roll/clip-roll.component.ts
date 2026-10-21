import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, effect, inject, input, signal, viewChild } from '@angular/core';
import type { MidiNotesDto } from '../../core/models';

/** Keys of margin above and below the notes played. */
const KEY_MARGIN = 2;

/**
 * Small piano roll of a clip: the notes of the `[trimStart, trimStart + length)` window of a
 * fragment, repeated `repeats` times across the width, in the track's colour. Decorative: the
 * clip around it carries the accessible name. The parent sizes and positions it (`relative`
 * with a height, or `absolute` with insets).
 */
@Component({
  selector: 'app-clip-roll',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'aria-hidden': 'true' },
  template: `<canvas #cv class="absolute inset-0 h-full w-full"></canvas>`,
})
export class ClipRollComponent {
  readonly notes = input<MidiNotesDto | null>(null);
  readonly trimStart = input(0);
  readonly length = input(0);
  readonly repeats = input(1);
  /** Colour of the notes (r,g,b). */
  readonly rgb = input('233, 180, 76');

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly size = signal({ w: 0, h: 0, dpr: 1 });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const measure = () => {
        const r = el.getBoundingClientRect();
        this.size.set({ w: Math.round(r.width), h: Math.round(r.height), dpr: window.devicePixelRatio || 1 });
      };
      measure();
      const ro = new ResizeObserver(() => measure());
      ro.observe(el);
      destroyRef.onDestroy(() => ro.disconnect());
    });
    effect(() => this.draw());
  }

  private draw(): void {
    const { w, h, dpr } = this.size();
    const notes = this.notes();
    const start = this.trimStart();
    const len = this.length();
    const reps = Math.max(1, this.repeats());
    const rgb = this.rgb();
    if (w <= 0 || h <= 0) return;
    const cv = this.canvas().nativeElement;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!notes || len <= 0) return;

    const end = start + len;
    const visible = notes.notes.filter((n) => n.end_ms > start && n.start_ms < end);
    if (!visible.length) return;
    const lo = Math.max(0, Math.min(...visible.map((n) => n.key)) - KEY_MARGIN);
    const hi = Math.min(127, Math.max(...visible.map((n) => n.key)) + KEY_MARGIN);
    const rowH = h / (hi - lo + 1);
    const noteH = Math.max(1.5, Math.min(4, rowH - (rowH > 3 ? 1 : 0)));
    const repW = w / reps;
    // One fill per velocity band, as in the timeline.
    const bands: number[][] = [[], [], [], []];
    visible.forEach((n, i) => bands[Math.min(3, n.velocity >> 5)].push(i));
    bands.forEach((band, b) => {
      if (!band.length) return;
      ctx.fillStyle = `rgba(${rgb}, ${(0.45 + (0.55 * (b + 1)) / 4).toFixed(3)})`;
      ctx.beginPath();
      for (let r = 0; r < reps; r++) {
        for (const i of band) {
          const n = visible[i];
          const x0 = r * repW + ((Math.max(n.start_ms, start) - start) / len) * repW;
          const x1 = r * repW + ((Math.min(n.end_ms, end) - start) / len) * repW;
          ctx.rect(x0, (hi - n.key) * rowH, Math.max(1.5, x1 - x0), noteH);
        }
      }
      ctx.fill();
    });
  }
}
