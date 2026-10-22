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
import type { ActivityBlock, MidiNotesDto } from '../../core/models';
import type { TimeRange } from '../../core/timeline-drag';
import type { TimelineMode } from '../../core/ui-prefs.store';

const TICK_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
/** Height of the time ruler below the track (the parent's overlays use `bottom-[18px]`). */
export const RULER_H = 18;
const TRACK_BG = '#0e0e11';
/** Brass accent (`--color-accent`). */
const ACCENT_RGB = '233, 180, 76';
/** Bars of the section already played. */
const PLAYED_RGB = '207, 205, 213';
/** Piano roll: keys of margin above and below the notes played, and the pedal strip. */
const ROLL_KEY_MARGIN = 2;
const ROLL_PAD_Y = 6;
const PEDAL_H = 4;

interface RollGeometry {
  hi: number;
  top: number;
  rowH: number;
  /** Top of the pedal strip (null if the file has no pedal). */
  pedalY: number | null;
}

function rollGeometry(notes: MidiNotesDto, trackH: number): RollGeometry {
  const lo = Math.max(0, notes.min_key - ROLL_KEY_MARGIN);
  const hi = Math.min(127, notes.max_key + ROLL_KEY_MARGIN);
  const hasPedal = notes.pedal.length > 0;
  const pedalY = hasPedal ? trackH - ROLL_PAD_Y - PEDAL_H : null;
  const bottom = hasPedal ? trackH - ROLL_PAD_Y - PEDAL_H - 4 : trackH - ROLL_PAD_Y;
  return { hi, top: ROLL_PAD_Y, rowH: Math.max(0.5, (bottom - ROLL_PAD_Y) / (hi - lo + 1)), pedalY };
}

/**
 * MIDI timeline canvas, in one of two modes:
 * - `roll`: piano roll (a rectangle per note, opacity ∝ velocity) with the sustain pedal strip;
 * - `activity`: bars per block (height ∝ number of notes, opacity ∝ velocity). It is also the
 *   fallback while the notes load or if the file has none.
 * Plus the time ruler, the selected range (in brass) and the section already played (lighter).
 * It scales by devicePixelRatio and redraws with ResizeObserver. The notes are drawn once per
 * colour into cached layers, so a progress frame only blits them. The playhead, handles and pins
 * are overlaid in the DOM by the parent.
 */
@Component({
  selector: 'app-timeline-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block relative w-full', '[style.height.px]': 'height()' },
  template: `<canvas #cv class="absolute inset-0 h-full w-full" aria-hidden="true"></canvas>`,
})
export class TimelineCanvasComponent {
  readonly blocks = input<ActivityBlock[]>([]);
  readonly notes = input<MidiNotesDto | null>(null);
  readonly mode = input<TimelineMode>('activity');
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
  /** Note layers per colour, valid while the notes and the size don't change. */
  private rollCache: { notes: MidiNotesDto; w: number; h: number; dpr: number; layers: Map<string, HTMLCanvasElement> } | null = null;

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
    const notes = this.notes();
    const roll = this.mode() === 'roll' && !!notes && notes.notes.length > 0 ? notes : null;
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

    const xOf = (ms: number) => (duration > 0 ? (ms / duration) * w : 0);

    // Track background, and the centre line (bars) or a line under each C and the pedal (roll)
    ctx.fillStyle = TRACK_BG;
    ctx.fillRect(0, 0, w, trackH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (roll) {
      const g = rollGeometry(roll, trackH);
      const lo = Math.max(0, roll.min_key - ROLL_KEY_MARGIN);
      for (let key = lo; key <= g.hi; key++) {
        if (key % 12 !== 0) continue;
        const y = Math.round(g.top + (g.hi - key + 1) * g.rowH) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
      if (g.pedalY !== null && duration > 0) {
        ctx.fillStyle = `rgba(${ACCENT_RGB}, 0.35)`;
        for (const p of roll.pedal) {
          const x0 = xOf(p.start_ms);
          ctx.fillRect(x0, g.pedalY, Math.max(1, xOf(p.end_ms) - x0), PEDAL_H);
        }
      }
    } else {
      ctx.moveTo(0, Math.round(trackH / 2) + 0.5);
      ctx.lineTo(w, Math.round(trackH / 2) + 0.5);
      ctx.stroke();
    }

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
    const paint: ((color: string) => void) | null =
      roll && duration > 0
        ? (color) => ctx.drawImage(this.rollLayer(roll, color, w, trackH, dpr, duration), 0, 0, w, trackH)
        : hasBars
          ? drawBars
          : null;
    if (paint) {
      paint(rgb);
      if (progress !== null && progress > 0) clipped(0, xOf(progress), () => paint(PLAYED_RGB));
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
      if (paint) clipped(sx0, sx1, () => paint(ACCENT_RGB));
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

  /** Layer with every note in `color` (rgb), drawn once and reused while nothing changes. */
  private rollLayer(notes: MidiNotesDto, color: string, w: number, trackH: number, dpr: number, duration: number): HTMLCanvasElement {
    const c = this.rollCache;
    if (!c || c.notes !== notes || c.w !== w || c.h !== trackH || c.dpr !== dpr) {
      this.rollCache = { notes, w, h: trackH, dpr, layers: new Map() };
    }
    const layers = this.rollCache!.layers;
    const cached = layers.get(color);
    if (cached) return cached;

    const layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(trackH * dpr);
    const lctx = layer.getContext('2d');
    if (lctx) {
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = rollGeometry(notes, trackH);
      const noteH = Math.max(1.5, g.rowH - (g.rowH > 3 ? 1 : 0));
      // One path per velocity band: four fills instead of one per note.
      const bands: number[][] = [[], [], [], []];
      notes.notes.forEach((n, i) => bands[Math.min(3, n.velocity >> 5)].push(i));
      bands.forEach((band, b) => {
        if (!band.length) return;
        lctx.fillStyle = `rgba(${color}, ${(0.45 + (0.55 * (b + 1)) / 4).toFixed(3)})`;
        lctx.beginPath();
        for (const i of band) {
          const n = notes.notes[i];
          const x0 = (n.start_ms / duration) * w;
          const x1 = Math.max(x0 + 1.5, (n.end_ms / duration) * w);
          lctx.rect(x0, g.top + (g.hi - n.key) * g.rowH, x1 - x0, noteH);
        }
        lctx.fill();
      });
    }
    layers.set(color, layer);
    return layer;
  }
}
