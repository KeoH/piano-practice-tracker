import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { clamp, formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import type { ActivityBlock, MidiNotesDto, NoteSpan } from '../../core/models';
import { beatMs, noteName, noteValue, parseNoteNames } from '../../core/music';
import type { TimeRange } from '../../core/timeline-drag';
import type { TimelineMode } from '../../core/ui-prefs.store';

const TICK_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
/** Height of the time ruler below the track (the parent's overlays use `bottom-[18px]`). */
export const RULER_H = 18;
const TRACK_BG = '#0e0e11';
/** Brass accent (`--color-accent`). */
const ACCENT_RGB = '233, 180, 76';
/** Bars of the section already played. */
const PLAYED_RGB = '207, 205, 213';
/** Piano roll: keys of margin above and below the notes played, and the pedal lane. */
const ROLL_KEY_MARGIN = 2;
const ROLL_PAD_Y = 6;
const PEDAL_H = 12;
/** Sustain pedal lane (`--color-ok`; also the legend's swatch). */
export const PEDAL_RGB = '92, 194, 140';
/** Fainter than this many px per beat the beat grid is skipped. */
const MIN_BEAT_PX = 6;
/** Beats per bar drawn heavier (no time signature is stored, so 4/4). */
const BEATS_PER_BAR = 4;
/** Opacity of the tail of a note held by the pedal, relative to the note's own. */
const TAIL_ALPHA = 0.28;
/** Pedal presses narrower than this get no "Ped" label. */
const PEDAL_LABEL_MIN_PX = 26;
/** Slack, in px, when pointing at a note or at the pedal lane. */
const HIT_SLACK_PX = 3;

interface RollGeometry {
  hi: number;
  top: number;
  rowH: number;
  /** Top of the pedal lane (null if the file has no pedal). */
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

/** Height of a note's rectangle for a given row height. */
function noteHeight(g: RollGeometry): number {
  return Math.max(1.5, g.rowH - (g.rowH > 3 ? 1 : 0));
}

/**
 * End of each note's *sound*: the end of the pedal press that holds it when it is released
 * (`end_ms` otherwise), cut at the next time the same key is struck. Memoised per notes object.
 */
const tailCache = new WeakMap<MidiNotesDto, Float64Array>();
function tailEnds(notes: MidiNotesDto): Float64Array {
  const cached = tailCache.get(notes);
  if (cached) return cached;
  const list = notes.notes;
  const out = new Float64Array(list.length);
  // Notes are sorted by start: walking backwards gives the next strike of each key.
  const nextStart = new Float64Array(list.length);
  const lastByKey = new Map<number, number>();
  for (let i = list.length - 1; i >= 0; i--) {
    nextStart[i] = lastByKey.get(list[i].key) ?? Infinity;
    lastByKey.set(list[i].key, list[i].start_ms);
  }
  const pedal = notes.pedal;
  for (let i = 0; i < list.length; i++) {
    const end = list[i].end_ms;
    out[i] = end;
    // Last press that began at or before the release
    let lo = 0;
    let hi = pedal.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pedal[mid].start_ms <= end) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found >= 0 && pedal[found].end_ms > end) out[i] = Math.max(end, Math.min(pedal[found].end_ms, nextStart[i]));
  }
  tailCache.set(notes, out);
  return out;
}

/** Start of the first note: the beat grid is anchored there. */
function firstNoteOn(notes: MidiNotesDto): number {
  return notes.notes.length ? notes.notes[0].start_ms : 0;
}

interface Hover {
  kind: 'note' | 'pedal';
  index: number;
  x: number;
  y: number;
}

/**
 * MIDI timeline canvas, in one of two modes:
 * - `roll`: piano roll (a rectangle per note, opacity ∝ velocity; a faint tail while the pedal keeps
 *   it sounding) with a beat grid and the sustain pedal lane;
 * - `activity`: bars per block (height ∝ number of notes, opacity ∝ velocity). It is also the
 *   fallback while the notes load or if the file has none.
 * Plus the time ruler, the selected range (in brass) and the section already played (lighter).
 * It draws the window `viewStartMs`..`viewStartMs + viewSpanMs` (the whole take by default); when
 * zoomed, the parent keeps it as wide as its scroller (`viewportPx`, sticky) instead of as wide as the
 * zoomed track. It scales by devicePixelRatio and redraws with ResizeObserver. The notes are drawn
 * once per colour into cached layers, so a progress frame only blits them. The playhead, handles and
 * pins are overlaid in the DOM by the parent.
 */
@Component({
  selector: 'app-timeline-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block relative w-full',
    '[style.height.px]': 'height()',
    '[style.width.px]': 'viewportPx() || null',
    '[style.position]': 'viewportPx() ? "sticky" : null',
    '[style.left.px]': 'viewportPx() ? 0 : null',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerleave)': 'clearHover()',
    '(pointerdown)': 'clearHover()',
  },
  template: `
    <canvas #cv class="absolute inset-0 h-full w-full" aria-hidden="true"></canvas>
    @if (tip(); as t) {
      <div
        role="tooltip"
        class="pointer-events-none absolute z-30 w-max max-w-[320px] -translate-x-1/2 rounded-lg border border-line-strong bg-ink-800 px-2.5 py-1.5 text-xs leading-snug text-fg shadow-lg shadow-black/50"
        [style.left.px]="t.left"
        [style.top.px]="t.top"
      >
        <div class="tabular">{{ t.line }}</div>
        @if (t.extra) {
          <div class="tabular text-muted">{{ t.extra }}</div>
        }
      </div>
    }
  `,
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
  /** Tempo of the take: draws the beat grid and names the note values (0 = unknown). */
  readonly bpm = input(0);
  readonly showGrid = input(true);
  /** Visible window; a span of 0 means the whole take. */
  readonly viewStartMs = input(0);
  readonly viewSpanMs = input(0);
  /** Width of the scroller this canvas sticks to when zoomed (null = as wide as its parent). */
  readonly viewportPx = input<number | null>(null);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);
  private readonly size = signal({ w: 0, h: 0, dpr: 1 });
  private readonly hover = signal<Hover | null>(null);
  /** Note layers per colour, valid while the notes, the size and the window don't change. */
  private rollCache: {
    notes: MidiNotesDto;
    w: number;
    h: number;
    dpr: number;
    start: number;
    span: number;
    layers: Map<string, HTMLCanvasElement>;
  } | null = null;
  /** Geometry of the last roll drawn, for pointing at notes. */
  private lastRoll: { notes: MidiNotesDto; g: RollGeometry; start: number; span: number; w: number } | null = null;
  private pendingMove: { x: number; y: number } | null = null;
  private moveFrame = 0;

  protected readonly tip = computed(() => {
    const h = this.hover();
    const notes = this.notes();
    const bpm = this.bpm();
    if (!h || !notes) return null;
    const { w } = this.size();
    const top = h.y < 60 ? h.y + 18 : h.y - 54;
    const left = clamp(h.x, 110, Math.max(110, w - 110));
    if (h.kind === 'pedal') {
      const p = notes.pedal[h.index];
      if (!p) return null;
      return { left, top, line: this.i18n.t('timeline.tooltipPedal', { ms: p.end_ms - p.start_ms }), extra: null };
    }
    const n = notes.notes[h.index];
    if (!n) return null;
    const names = parseNoteNames(this.i18n.t('music.noteNames'));
    const parts = [noteName(n.key, names)];
    const nv = noteValue(n.end_ms - n.start_ms, bpm);
    if (nv) {
      let value = this.i18n.t(`timeline.value.${nv.kind}`);
      if (nv.dotted) value = this.i18n.t('timeline.valueDotted', { value });
      if (!nv.exact) value = this.i18n.t('timeline.valueApprox', { value });
      parts.push(`${value} (${this.i18n.t('timeline.tooltipBeats', { beats: nv.beats.toFixed(1) })})`);
    }
    parts.push(`${n.end_ms - n.start_ms} ms`, this.i18n.t('timeline.tooltipVelocity', { velocity: n.velocity }));
    const tail = tailEnds(notes)[h.index] - n.start_ms;
    const sounds = tail > n.end_ms - n.start_ms;
    return { left, top, line: parts.join(' · '), extra: sounds ? this.i18n.t('timeline.tooltipTail', { ms: Math.round(tail) }) : null };
  });

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
    destroyRef.onDestroy(() => cancelAnimationFrame(this.moveFrame));

    effect(() => this.draw());
  }

  protected onPointerMove(ev: PointerEvent): void {
    const r = this.host.nativeElement.getBoundingClientRect();
    this.pendingMove = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (!this.moveFrame) {
      this.moveFrame = requestAnimationFrame(() => {
        this.moveFrame = 0;
        const p = this.pendingMove;
        if (p) this.hover.set(this.pick(p.x, p.y));
      });
    }
  }

  protected clearHover(): void {
    this.pendingMove = null;
    if (this.hover()) this.hover.set(null);
  }

  /** The note or pedal press under a point of the canvas, if any. */
  private pick(x: number, y: number): Hover | null {
    const roll = this.lastRoll;
    const notes = this.notes();
    if (!roll || roll.notes !== notes || !notes) return null;
    const { g, start, span, w } = roll;
    const ms = start + (x / w) * span;
    const slackMs = (HIT_SLACK_PX / w) * span;
    if (g.pedalY !== null && y >= g.pedalY - HIT_SLACK_PX && y <= g.pedalY + PEDAL_H + HIT_SLACK_PX) {
      const i = notes.pedal.findIndex((p) => ms >= p.start_ms - slackMs && ms <= p.end_ms + slackMs);
      return i >= 0 ? { kind: 'pedal', index: i, x, y } : null;
    }
    const key = g.hi - Math.floor((y - g.top) / g.rowH);
    const list = notes.notes;
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.start_ms > ms + slackMs) break;
      if (n.key === key && n.end_ms >= ms - slackMs) best = i;
    }
    return best >= 0 ? { kind: 'note', index: best, x, y } : null;
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
    const bpm = this.bpm();
    const showGrid = this.showGrid();
    const hover = this.hover();
    const roll = this.mode() === 'roll' && !!notes && notes.notes.length > 0 ? notes : null;
    // The visible window (the whole take unless the parent zooms in)
    const span = this.viewSpanMs() > 0 ? this.viewSpanMs() : duration;
    const start = this.viewSpanMs() > 0 ? this.viewStartMs() : 0;
    // Read here so the effect redraws when the language changes.
    const emptyLabel = this.i18n.t('timeline.noActivity');
    const pedalLabel = this.i18n.t('timeline.pedalShort');
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

    const pxPerMs = span > 0 ? w / span : 0;
    const xOf = (ms: number) => (ms - start) * pxPerMs;
    /** Like `xOf`, but kept near the canvas so rectangles drawn far off-screen stay cheap. */
    const xClamped = (ms: number) => clamp(xOf(ms), -2, w + 2);
    const end = start + span;

    // Track background, and the centre line (bars) or a line under each C, the beat grid and the pedal (roll)
    ctx.fillStyle = TRACK_BG;
    ctx.fillRect(0, 0, w, trackH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    this.lastRoll = null;
    if (roll) {
      const g = rollGeometry(roll, trackH);
      this.lastRoll = { notes: roll, g, start, span, w };
      const lo = Math.max(0, roll.min_key - ROLL_KEY_MARGIN);
      for (let key = lo; key <= g.hi; key++) {
        if (key % 12 !== 0) continue;
        const y = Math.round(g.top + (g.hi - key + 1) * g.rowH) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Beat grid, anchored at the first note (the take's start is wherever the user began)
      if (showGrid && bpm > 0 && span > 0 && beatMs(bpm) * pxPerMs >= MIN_BEAT_PX) {
        const beat = beatMs(bpm);
        const t0 = firstNoteOn(roll);
        const first = Math.ceil((start - t0) / beat);
        const last = Math.floor((end - t0) / beat);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
        ctx.beginPath();
        const heavy: number[] = [];
        for (let i = first; i <= last; i++) {
          const x = Math.round(xOf(t0 + i * beat)) + 0.5;
          if (((i % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0) {
            heavy.push(x);
            continue;
          }
          ctx.moveTo(x, 0);
          ctx.lineTo(x, trackH);
        }
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.17)';
        ctx.beginPath();
        for (const x of heavy) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, trackH);
        }
        ctx.stroke();
      }

      if (g.pedalY !== null && span > 0) {
        ctx.font = '600 9px "Hanken Grotesk Variable", ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        for (const p of roll.pedal) {
          if (p.end_ms < start || p.start_ms > end) continue;
          const x0 = xOf(p.start_ms);
          const x1 = xOf(p.end_ms);
          const cx0 = Math.max(x0, 0);
          const cw = Math.max(1, Math.min(x1, w) - cx0);
          ctx.fillStyle = `rgba(${PEDAL_RGB}, 0.5)`;
          ctx.fillRect(cx0, g.pedalY, cw, PEDAL_H);
          // Brighter edges where the pedal goes down and up
          ctx.fillStyle = `rgba(${PEDAL_RGB}, 1)`;
          if (x0 >= 0) ctx.fillRect(x0, g.pedalY, 2, PEDAL_H);
          if (x1 <= w) ctx.fillRect(x1 - 1, g.pedalY, 1.5, PEDAL_H);
          if (cw >= PEDAL_LABEL_MIN_PX) {
            ctx.fillStyle = TRACK_BG;
            ctx.fillText(pedalLabel, cx0 + 5, g.pedalY + PEDAL_H / 2 + 0.5);
          }
        }
      }
    } else {
      ctx.moveTo(0, Math.round(trackH / 2) + 0.5);
      ctx.lineTo(w, Math.round(trackH / 2) + 0.5);
      ctx.stroke();
    }

    // Time grid
    let stepMs = TICK_STEPS_S[TICK_STEPS_S.length - 1] * 1000;
    if (span > 0) {
      stepMs = (TICK_STEPS_S.find((s) => s * 1000 * pxPerMs >= 64) ?? TICK_STEPS_S[TICK_STEPS_S.length - 1]) * 1000;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.beginPath();
      for (let t = Math.max(1, Math.ceil(start / stepMs)) * stepMs; t < Math.min(duration, end); t += stepMs) {
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
        if (b.note_count <= 0 || b.end_ms < start || b.start_ms > end) continue;
        const x0 = xClamped(b.start_ms);
        const x1 = Math.max(x0 + 1, xClamped(b.end_ms));
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
        ? (color) => ctx.drawImage(this.rollLayer(roll, color, w, trackH, dpr, start, span), 0, 0, w, trackH)
        : hasBars
          ? drawBars
          : null;
    if (paint) {
      paint(rgb);
      if (progress !== null && progress > 0) clipped(0, clamp(xOf(progress), 0, w), () => paint(PLAYED_RGB));
    } else if (duration > 0) {
      ctx.fillStyle = 'rgba(169, 167, 176, 0.7)';
      ctx.font = '12px "Hanken Grotesk Variable", ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emptyLabel, w / 2, trackH / 2);
    }

    // Selection
    if (sel && duration > 0 && sel.end > sel.start) {
      const sx0 = clamp(xOf(sel.start), 0, w);
      const sx1 = clamp(xOf(sel.end), 0, w);
      ctx.fillStyle = 'rgba(8, 8, 10, 0.4)';
      ctx.fillRect(0, 0, sx0, trackH);
      ctx.fillRect(sx1, 0, w - sx1, trackH);
      ctx.fillStyle = `rgba(${ACCENT_RGB}, 0.13)`;
      ctx.fillRect(sx0, 0, sx1 - sx0, trackH);
      if (paint) clipped(sx0, sx1, () => paint(ACCENT_RGB));
    }

    // Outline of the note under the pointer
    if (hover && roll && this.lastRoll && hover.kind === 'note') {
      const n: NoteSpan | undefined = roll.notes[hover.index];
      if (n) {
        const g = this.lastRoll.g;
        const x0 = xClamped(n.start_ms);
        ctx.strokeStyle = 'rgba(244, 241, 232, 0.95)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, g.top + (g.hi - n.key) * g.rowH - 0.5, Math.max(2, xClamped(n.end_ms) - x0), noteHeight(g) + 1);
      }
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
      if (span > 0) {
        const tenths = stepMs < 1000;
        for (let t = Math.floor(start / stepMs) * stepMs; t <= Math.min(duration, end); t += stepMs) {
          if (t < 0) continue;
          const x = Math.round(xOf(t)) + 0.5;
          ctx.moveTo(x, trackH);
          ctx.lineTo(x, trackH + 5);
          const label = formatMs(t, tenths);
          ctx.textAlign = t === 0 ? 'left' : 'center';
          const labelW = ctx.measureText(label).width;
          if (x + labelW / 2 < w && (t === 0 || x - labelW / 2 > 0)) ctx.fillText(label, t === 0 ? x + 3 : x, trackH + 11);
        }
      }
      ctx.stroke();
    }
  }

  /** Layer with every note (and its pedal tail) in `color` (rgb), drawn once and reused while nothing changes. */
  private rollLayer(notes: MidiNotesDto, color: string, w: number, trackH: number, dpr: number, start: number, span: number): HTMLCanvasElement {
    const c = this.rollCache;
    if (!c || c.notes !== notes || c.w !== w || c.h !== trackH || c.dpr !== dpr || c.start !== start || c.span !== span) {
      this.rollCache = { notes, w, h: trackH, dpr, start, span, layers: new Map() };
    }
    const layers = this.rollCache!.layers;
    const cached = layers.get(color);
    if (cached) return cached;

    const layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(trackH * dpr);
    const lctx = layer.getContext('2d');
    if (lctx && span > 0) {
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = rollGeometry(notes, trackH);
      const noteH = noteHeight(g);
      const px = w / span;
      const end = start + span;
      const tails = tailEnds(notes);
      // One path per velocity band: a few fills instead of one per note.
      const bands: number[][] = [[], [], [], []];
      notes.notes.forEach((n, i) => {
        if (tails[i] < start || n.start_ms > end) return;
        bands[Math.min(3, n.velocity >> 5)].push(i);
      });
      bands.forEach((band, b) => {
        if (!band.length) return;
        const alpha = 0.45 + (0.55 * (b + 1)) / 4;
        const tail = new Path2D();
        const body = new Path2D();
        for (const i of band) {
          const n = notes.notes[i];
          const y = g.top + (g.hi - n.key) * g.rowH;
          const x0 = clamp((n.start_ms - start) * px, -2, w + 2);
          const x1 = Math.max(x0 + 1.5, clamp((n.end_ms - start) * px, -2, w + 2));
          body.rect(x0, y, x1 - x0, noteH);
          if (tails[i] > n.end_ms) tail.rect(x1, y, clamp((tails[i] - start) * px, -2, w + 2) - x1, noteH);
        }
        lctx.fillStyle = `rgba(${color}, ${(alpha * TAIL_ALPHA).toFixed(3)})`;
        lctx.fill(tail);
        lctx.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
        lctx.fill(body);
      });
    }
    layers.set(color, layer);
    return layer;
  }
}
