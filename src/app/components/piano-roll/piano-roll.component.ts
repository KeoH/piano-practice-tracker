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
import type { PlayedMark } from '../../core/challenge.store';
import { scaleMs } from '../../core/challenge-stats';
import { I18nService } from '../../core/i18n/i18n.service';
import type { NoteDto, NoteStatus } from '../../core/models';
import { isBlackKey, noteName, parseNoteNames } from '../../core/music';

// The canvas does not read CSS: these mirror the `@theme` tokens in styles.css.
const TRACK_BG = '#0e0e11';
const GUTTER_BG = '#111114';
const LABEL = '#8f8d98';
const ACCENT = '#e9b44c';
const PENDING = 'rgba(169, 167, 176, 0.5)';
const PERFECT = '#5cc28c';
const GOOD = 'rgba(92, 194, 140, 0.55)';
const MISSED_RGB = '242, 97, 95';
/** Left column with the note names. */
const GUTTER_W = 38;
/** Attempt time visible at once in live mode, and where the playhead sits. */
const LIVE_SPAN_MS = 6000;
const PLAYHEAD_AT = 0.22;
const MIN_KEYS = 13;

/**
 * Piano roll of a melody (time → x, pitch → y). In `live` mode it scrolls past a fixed playhead
 * following `clock` on every animation frame; in `static` mode the whole melody fits the width.
 * Notes are coloured by their state, or by their miss rate when `heat` is given. Played notes that
 * hit nothing are drawn as red marks.
 */
@Component({
  selector: 'app-piano-roll',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block relative w-full overflow-hidden rounded-xl', '[style.height.px]': 'height()' },
  template: `<canvas #cv class="absolute inset-0 h-full w-full" aria-hidden="true"></canvas>`,
})
export class PianoRollComponent {
  readonly notes = input<NoteDto[]>([]);
  readonly tempoPct = input(100);
  readonly states = input<(NoteStatus | null)[]>([]);
  readonly marks = input<PlayedMark[]>([]);
  readonly mode = input<'live' | 'static'>('static');
  /** Live mode: animates while true. */
  readonly running = input(false);
  /** Current time of the attempt timeline (ms), read on every frame in live mode. */
  readonly clock = input<() => number>(() => 0);
  /** Miss rate per note (0-1): colours the notes as a heat map instead of by state. */
  readonly heat = input<number[] | null>(null);
  /** Static mode: highlighted moment (attempt timeline, ms). */
  readonly focusMs = input<number | null>(null);
  readonly height = input(260);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);
  private readonly size = signal({ w: 0, h: 0, dpr: 1 });
  private frame = 0;

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
    destroyRef.onDestroy(() => cancelAnimationFrame(this.frame));

    effect(() => {
      // Redraws on any input change; while live and running, also on every frame.
      this.draw();
      cancelAnimationFrame(this.frame);
      if (this.mode() === 'live' && this.running()) {
        const loop = () => {
          this.draw();
          this.frame = requestAnimationFrame(loop);
        };
        this.frame = requestAnimationFrame(loop);
      }
    });
  }

  private draw(): void {
    const { w, h, dpr } = this.size();
    const notes = this.notes();
    const tempo = this.tempoPct();
    const states = this.states();
    const marks = this.marks();
    const live = this.mode() === 'live';
    const heat = this.heat();
    const focus = this.focusMs();
    const now = live ? this.clock()() : 0;
    const names = parseNoteNames(this.i18n.t('music.noteNames'));
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
    ctx.fillStyle = TRACK_BG;
    ctx.fillRect(0, 0, w, h);

    // Pitch range: the melody's keys plus a margin, at least about an octave.
    let lo = 60;
    let hi = 72;
    if (notes.length) {
      lo = Math.min(...notes.map((n) => n.key)) - 2;
      hi = Math.max(...notes.map((n) => n.key)) + 2;
    }
    while (hi - lo + 1 < MIN_KEYS) {
      lo--;
      if (hi - lo + 1 < MIN_KEYS) hi++;
    }
    const rows = hi - lo + 1;
    const rowH = h / rows;
    const yOf = (key: number) => (hi - key) * rowH;

    const plotW = w - GUTTER_W;
    const totalMs = Math.max(1000, ...notes.map((n) => scaleMs(n.end_ms, tempo))) + 400;
    const xOf = live
      ? (ms: number) => GUTTER_W + plotW * PLAYHEAD_AT + ((ms - now) / LIVE_SPAN_MS) * plotW
      : (ms: number) => GUTTER_W + 4 + (ms / totalMs) * (plotW - 8);

    // Black-key rows and C lines
    for (let k = lo; k <= hi; k++) {
      const y = yOf(k);
      if (isBlackKey(k)) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.022)';
        ctx.fillRect(GUTTER_W, y, plotW, rowH);
      }
      if (k % 12 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.fillRect(GUTTER_W, Math.round(y + rowH) - 0.5, plotW, 1);
      }
    }

    // One-second grid
    const from = live ? Math.floor((now - LIVE_SPAN_MS) / 1000) : 0;
    const to = live ? Math.ceil((now + LIVE_SPAN_MS) / 1000) : Math.ceil(totalMs / 1000);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
    for (let s = from; s <= to; s++) {
      const x = Math.round(xOf(s * 1000)) + 0.5;
      if (x > GUTTER_W && x < w) ctx.fillRect(x, 0, 1, h);
    }

    // Notes
    const noteH = Math.max(3, rowH - 2);
    const radius = Math.min(3, noteH / 2);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const x0 = xOf(scaleMs(n.start_ms, tempo));
      const x1 = Math.max(x0 + 4, xOf(scaleMs(n.end_ms, tempo)));
      if (x1 < GUTTER_W || x0 > w) continue;
      const y = yOf(n.key) + (rowH - noteH) / 2;
      ctx.beginPath();
      ctx.roundRect(x0, y, x1 - x0, noteH, radius);
      if (heat) {
        const rate = heat[i] ?? 0;
        ctx.fillStyle = rate > 0 ? `rgba(${MISSED_RGB}, ${0.25 + 0.75 * rate})` : PENDING;
        ctx.fill();
        continue;
      }
      const state = states[i] ?? null;
      if (state === 'missed') {
        ctx.fillStyle = `rgba(${MISSED_RGB}, 0.14)`;
        ctx.fill();
        ctx.strokeStyle = `rgb(${MISSED_RGB})`;
        ctx.lineWidth = 1.25;
        ctx.stroke();
      } else {
        ctx.fillStyle = state === 'perfect' ? PERFECT : state === 'good' ? GOOD : PENDING;
        ctx.fill();
      }
    }

    // Played notes that hit nothing
    if (!heat) {
      ctx.strokeStyle = `rgb(${MISSED_RGB})`;
      ctx.lineWidth = 1.75;
      const s = Math.min(5, rowH / 2);
      for (const m of marks) {
        const x = xOf(m.time_ms);
        if (x < GUTTER_W || x > w) continue;
        const cy = yOf(m.key) + rowH / 2;
        ctx.beginPath();
        ctx.moveTo(x - s, cy - s);
        ctx.lineTo(x + s, cy + s);
        ctx.moveTo(x + s, cy - s);
        ctx.lineTo(x - s, cy + s);
        ctx.stroke();
      }
    }

    // Playhead / focused moment
    if (live) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(Math.round(GUTTER_W + plotW * PLAYHEAD_AT) - 1, 0, 2, h);
    } else if (focus !== null) {
      const x = Math.round(xOf(focus));
      ctx.fillStyle = 'rgba(233, 180, 76, 0.18)';
      ctx.fillRect(x - 6, 0, 12, h);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(x - 1, 0, 2, h);
    }

    // Gutter with the C names (and every key when the rows are tall enough)
    ctx.fillStyle = GUTTER_BG;
    ctx.fillRect(0, 0, GUTTER_W, h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(GUTTER_W - 1, 0, 1, h);
    ctx.font = '500 10px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = LABEL;
    for (let k = lo; k <= hi; k++) {
      if (k % 12 === 0 || (rowH >= 14 && !isBlackKey(k))) {
        ctx.fillText(noteName(k, names), GUTTER_W - 6, yOf(k) + rowH / 2);
      }
    }
  }
}
