import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import type { ActivityBlock } from '../../core/models';
import type { TimeRange } from '../../core/timeline-drag';

const TICK_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
/** Height of the time ruler below the track (the parent's overlays use `bottom-[18px]`). */
export const RULER_H = 18;
const TRACK_BG = '#0e0e11';
/** Brass accent (`--color-accent`). */
const ACCENT_RGB = '233, 180, 76';
/** Bars of the section already played. */
const PLAYED_RGB = '207, 205, 213';

/**
 * MIDI activity canvas: bars per block (height ∝ number of notes, opacity ∝ velocity), time ruler,
 * selected range (brass bars) and the section already played (light bars). It scales by
 * devicePixelRatio and redraws with ResizeObserver. The playhead, handles and pins are overlaid in
 * the DOM by the parent.
 */
@Component({
  selector: 'app-timeline-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block relative w-full', '[style.height.px]': 'height()' },
  template: `<canvas #cv class="absolute inset-0 h-full w-full" aria-hidden="true"></canvas>`,
})
export class TimelineCanvasComponent {
  readonly blocks = input<ActivityBlock[]>([]);
  readonly durationMs = input(0);
  readonly selection = input<TimeRange | null>(null);
  readonly height = input(96);
  readonly showRuler = input(true);
  /** Base colour of the bars (r,g,b). */
  readonly barRgb = input('104, 104, 120');
  /** Playback position: earlier bars are drawn lighter (null = no progress). */
  readonly progressMs = input<number | null>(null);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);
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
    const blocks = this.blocks();
    const duration = this.durationMs();
    const sel = this.selection();
    const showRuler = this.showRuler();
    const rgb = this.barRgb();
    const progress = this.progressMs();
    // Read here so the effect redraws when the language changes.
    const emptyLabel = this.i18n.t('timeline.noActivity');
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

    const rulerH = showRuler ? RULER_H : 0;
    const trackH = h - rulerH;

    // Track background and centre line
    ctx.fillStyle = TRACK_BG;
    ctx.fillRect(0, 0, w, trackH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(trackH / 2) + 0.5);
    ctx.lineTo(w, Math.round(trackH / 2) + 0.5);
    ctx.stroke();

    const xOf = (ms: number) => (duration > 0 ? (ms / duration) * w : 0);

    // Time grid
    let stepS = TICK_STEPS_S[TICK_STEPS_S.length - 1];
    if (duration > 0) {
      const pxPerSecond = w / (duration / 1000);
      stepS = TICK_STEPS_S.find((s) => s * pxPerSecond >= 64) ?? stepS;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.beginPath();
      for (let t = stepS * 1000; t < duration; t += stepS * 1000) {
        const x = Math.round(xOf(t)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, trackH);
      }
      ctx.stroke();
    }

    // Activity bars (redrawn clipped in another colour for progress and selection)
    const maxCount = blocks.reduce((m, b) => Math.max(m, b.note_count), 0);
    const hasBars = duration > 0 && maxCount > 0;
    const drawBars = (color: string) => {
      const usable = trackH - 16;
      for (const b of blocks) {
        if (b.note_count <= 0) continue;
        const x0 = xOf(b.start_ms);
        const x1 = Math.max(x0 + 1, xOf(b.end_ms));
        const bw = Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0));
        const norm = Math.sqrt(b.note_count / maxCount);
        const bh = Math.max(2, norm * usable);
        const vel = Math.min(1, Math.max(0, b.velocity_avg / 127));
        ctx.fillStyle = `rgba(${color}, ${(0.45 + 0.55 * vel).toFixed(3)})`;
        ctx.fillRect(x0, (trackH - bh) / 2, bw, bh);
      }
    };
    const clipped = (x0: number, x1: number, paint: () => void) => {
      if (x1 <= x0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, trackH);
      ctx.clip();
      paint();
      ctx.restore();
    };
    if (hasBars) {
      drawBars(rgb);
      if (progress !== null && progress > 0) clipped(0, xOf(progress), () => drawBars(PLAYED_RGB));
    } else if (duration > 0) {
      ctx.fillStyle = 'rgba(169, 167, 176, 0.7)';
      ctx.font = '12px "Hanken Grotesk Variable", ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emptyLabel, w / 2, trackH / 2);
    }

    // Selection
    if (sel && duration > 0 && sel.end > sel.start) {
      const sx0 = xOf(sel.start);
      const sx1 = xOf(sel.end);
      ctx.fillStyle = 'rgba(8, 8, 10, 0.4)';
      ctx.fillRect(0, 0, sx0, trackH);
      ctx.fillRect(sx1, 0, w - sx1, trackH);
      ctx.fillStyle = `rgba(${ACCENT_RGB}, 0.13)`;
      ctx.fillRect(sx0, 0, sx1 - sx0, trackH);
      if (hasBars) clipped(sx0, sx1, () => drawBars(ACCENT_RGB));
    }

    // Ruler
    if (showRuler) {
      ctx.fillStyle = TRACK_BG;
      ctx.fillRect(0, trackH, w, rulerH);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.beginPath();
      ctx.moveTo(0, trackH + 0.5);
      ctx.lineTo(w, trackH + 0.5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(133, 131, 142, 0.8)';
      ctx.fillStyle = 'rgba(143, 141, 152, 1)';
      ctx.font = '10.5px "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.beginPath();
      if (duration > 0) {
        for (let t = 0; t <= duration; t += stepS * 1000) {
          const x = Math.round(xOf(t)) + 0.5;
          ctx.moveTo(x, trackH);
          ctx.lineTo(x, trackH + 5);
          const label = formatMs(t);
          ctx.textAlign = t === 0 ? 'left' : 'center';
          if (x + 18 < w) ctx.fillText(label, t === 0 ? x + 3 : x, trackH + 11);
        }
      }
      ctx.stroke();
    }
  }
}
