import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { NoteStatus, ScoreDto } from '../../core/models';
import { isBlackKey, parseNoteNames, spelledNoteName } from '../../core/music';
import {
  LINE_SPACING,
  RULER_H,
  STEP_PX,
  SYSTEM_H,
  type Hit,
  type SystemBox,
  barLineAt,
  hitAt,
  inRuler,
  layoutOf,
  noteX,
  rulerTick,
  systemAt,
  xOfTick,
  yOfStep,
} from '../../core/score-layout';
import {
  type StaffName,
  STAFF_NAMES,
  barLabel,
  barOf,
  canPlace,
  chordDuration,
  durationTicks,
  findNote,
  gridTicks,
  ledgerSteps,
  noteEnd,
  notatedValue,
  pitchAt,
  snapTickInBar,
  staffNotes,
  staffStep,
} from '../../core/score';
import { ScoreStore } from '../../core/score.store';
import {
  type CurveDraw,
  type NoteDraw,
  type RestDraw,
  type SystemView,
  drawNotes,
  drawRests,
  drawSlurs,
  drawTies,
  clefOrigin,
  flagPath,
  systemViews,
} from '../../core/score-draw';

/** Unicode music symbols that the bundled Noto Music font draws. */
const GLYPH = { treble: '\u{1D11E}', bass: '\u{1D122}', quarter: '\u{1D13D}', eighth: '\u{1D13E}', sixteenth: '\u{1D13F}', sharp: '♯', flat: '♭', natural: '♮' } as const;

const DRAG_THRESHOLD_PX = 4;

/** A notehead with the label a screen reader reads. */
type LabeledNote = NoteDraw & { label: string };

/** A preview of where a note would land. */
interface Ghost {
  staff: StaffName;
  x: number;
  y: number;
  tick: number;
  step: number;
  fits: boolean;
  ledgers: number[];
  hollow: boolean;
}

/** A note that was played in a challenge and hit nothing: where in the score, and which key. */
export interface StaffMark {
  tick: number;
  key: number;
}

interface NoteDrag {
  id: string;
  pointerId: number;
  x0: number;
  y0: number;
  moved: boolean;
  duration: number;
  target: { staff: StaffName; tick: number; step: number } | null;
}

/**
 * The grand staff as SVG: treble clef on top for the right hand, bass clef below for the left. It draws
 * the score (`ScoreStore.doc`) and turns the pointer into edits: a click puts a note of the current value,
 * a note value dragged from the palette is dropped here, a note dragged moves (even to the other hand),
 * and a click on the ruler moves the playhead. Pointer events, not HTML5 drag and drop, which the
 * desktop webview intercepts. The geometry is in `core/score-layout`.
 */
@Component({
  selector: 'app-score-staff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  host: {
    class: 'block overflow-x-auto overflow-y-hidden',
    '(window:pointermove)': 'onMove($event)',
    '(window:pointerup)': 'onUp($event)',
    '(window:pointercancel)': 'cancel()',
    '(window:resize)': 'measure()',
  },
  template: `
    @let l = layout();
    @let sc = doc();
    @if (sc) {
      <svg
        #svg
        role="group"
        class="block select-none"
        [attr.width]="l.width"
        [attr.height]="l.height"
        [attr.aria-label]="'score.staffLabel' | t: { title: sc.title }"
        (pointerdown)="rulerDown($event)"
        (click)="background($event)"
      >
        @for (v of views(); track v.sys.index) {
          @let sys = v.sys;
          <!-- Ruler: bar numbers; click to move the playhead -->
          <rect [attr.x]="sys.x0" [attr.y]="sys.top" [attr.width]="sys.right - sys.x0" [attr.height]="RULER_H" class="cursor-pointer fill-ink-850" />
          @for (m of v.marks; track m.index) {
            @if (m.label !== null) {
              <text [attr.x]="m.x + 5" [attr.y]="sys.top + 16" class="tabular pointer-events-none fill-faint" font-size="11">{{ m.label }}</text>
            }
          }

          <!-- Beat guides -->
          @for (bx of v.beatX; track bx) {
            <line [attr.x1]="bx" [attr.x2]="bx" [attr.y1]="sys.staves.treble.top - 14" [attr.y2]="sys.staves.bass.bottom + 14" class="stroke-line" stroke-dasharray="2 4" />
          }

          @for (staff of staves; track staff) {
            @let box = sys.staves[staff];
            @for (i of lineIdx; track i) {
              <line [attr.x1]="0" [attr.x2]="sys.right" [attr.y1]="box.top + i * LS" [attr.y2]="box.top + i * LS" class="stroke-muted" stroke-width="1" />
            }
          }

          <!-- Bar lines across both staves; a double line closes the score -->
          @for (m of v.marks; track m.index) {
            <line [attr.x1]="m.x" [attr.x2]="m.x" [attr.y1]="sys.staves.treble.top" [attr.y2]="sys.staves.bass.bottom" class="stroke-muted" stroke-width="1.2" />
          }
          @if (v.isLast) {
            <line [attr.x1]="sys.right - 6" [attr.x2]="sys.right - 6" [attr.y1]="sys.staves.treble.top" [attr.y2]="sys.staves.bass.bottom" class="stroke-muted" stroke-width="1.2" />
            <line [attr.x1]="sys.right" [attr.x2]="sys.right" [attr.y1]="sys.staves.treble.top" [attr.y2]="sys.staves.bass.bottom" class="stroke-muted" stroke-width="3.2" />
          } @else {
            <line [attr.x1]="sys.right" [attr.x2]="sys.right" [attr.y1]="sys.staves.treble.top" [attr.y2]="sys.staves.bass.bottom" class="stroke-muted" stroke-width="1.2" />
          }
          @if (v.repeat; as rp) {
            <!-- Repeat sign at the end of a bar: back to the start. Two dots in the middle spaces of each staff, then a thin and a thick line -->
            @let rsel = !readonly() && store.repeatSelected();
            @if (!rp.final) {
              <line [attr.x1]="rp.x - 6" [attr.x2]="rp.x - 6" [attr.y1]="sys.staves.treble.top" [attr.y2]="sys.staves.bass.bottom" [class]="rsel ? 'stroke-accent' : 'stroke-muted'" stroke-width="1.2" />
              <line [attr.x1]="rp.x" [attr.x2]="rp.x" [attr.y1]="sys.staves.treble.top" [attr.y2]="sys.staves.bass.bottom" [class]="rsel ? 'stroke-accent' : 'stroke-muted'" stroke-width="3.2" />
            }
            @for (staff of staves; track staff) {
              @let box = sys.staves[staff];
              <circle [attr.cx]="rp.x - 13" [attr.cy]="box.top + 15" r="2.2" [class]="rsel ? 'fill-accent' : 'fill-fg'" />
              <circle [attr.cx]="rp.x - 13" [attr.cy]="box.top + 25" r="2.2" [class]="rsel ? 'fill-accent' : 'fill-fg'" />
            }
            @if (!readonly()) {
              <!-- A bigger target to select the sign or drag it to another bar line -->
              <rect
                role="button"
                tabindex="0"
                class="cursor-grab touch-none outline-none"
                fill="transparent"
                [attr.x]="rp.x - 19"
                [attr.y]="sys.staves.treble.top"
                width="25"
                [attr.height]="sys.staves.bass.bottom - sys.staves.treble.top"
                [attr.aria-label]="'score.repeatSign' | t"
                [attr.aria-pressed]="rsel"
                (pointerdown)="repeatDown($event)"
                (click)="$event.stopPropagation()"
                (focus)="store.selectRepeat()"
              />
            }
          }
          <line x1="1" x2="1" [attr.y1]="sys.staves.treble.top" [attr.y2]="sys.staves.bass.bottom" class="stroke-muted" stroke-width="1.6" />

          <!-- Clefs, and the time signature on the first line -->
          <text class="music pointer-events-none fill-fg" [attr.x]="clefAt(sys, 'treble').x" [attr.y]="clefAt(sys, 'treble').y" font-size="40">{{ glyph.treble }}</text>
          <text class="music pointer-events-none fill-fg" [attr.x]="clefAt(sys, 'bass').x" [attr.y]="clefAt(sys, 'bass').y" font-size="40">{{ glyph.bass }}</text>
          @if (sys.index === 0) {
            @for (staff of staves; track staff) {
              @let box = sys.staves[staff];
              <g class="pointer-events-none fill-fg" font-weight="700" font-size="25" text-anchor="middle" dominant-baseline="central" style="font-family: 'Hanken Grotesk Variable', sans-serif">
                <text x="58" [attr.y]="box.top + LS">{{ sc.beats }}</text>
                <text x="58" [attr.y]="box.top + 3 * LS">{{ sc.beat_unit }}</text>
              </g>
            }
          }
        }

        <!-- Rests (the gaps between notes) -->
        @for (r of rests(); track r.key) {
          <g class="pointer-events-none fill-muted">
            @switch (r.shape) {
              @case ('bar') {
                <rect [attr.x]="r.x - 6" [attr.y]="r.box.top + LS" width="12" height="5" />
              }
              @case ('half') {
                <rect [attr.x]="r.x - 6" [attr.y]="r.box.top + 2 * LS - 5" width="12" height="5" />
              }
              @case ('quarter') {
                <text class="music" [attr.x]="r.x - 5" [attr.y]="r.box.bottom" font-size="40">{{ glyph.quarter }}</text>
              }
              @case ('eighth') {
                <text class="music" [attr.x]="r.x - 5" [attr.y]="r.box.bottom" font-size="40">{{ glyph.eighth }}</text>
              }
              @default {
                <text class="music" [attr.x]="r.x - 5" [attr.y]="r.box.bottom" font-size="40">{{ glyph.sixteenth }}</text>
              }
            }
          </g>
        }

        <!-- Notes -->
        @for (n of notes(); track n.id) {
          @let sel = !readonly() && store.selectedNoteId() === n.id;
          @let now = playingIds().has(n.id);
          <g
            [attr.role]="readonly() ? 'img' : 'button'"
            [attr.tabindex]="readonly() ? null : 0"
            class="outline-none"
            [class]="(readonly() ? '' : 'cursor-grab touch-none ') + (sel ? 'text-accent' : readonly() ? stateColor(n.id) : now ? 'text-ok' : 'text-fg')"
            [class.opacity-30]="draggingId() === n.id"
            [attr.aria-label]="n.label"
            [attr.aria-pressed]="readonly() ? null : sel"
            (pointerdown)="noteDown($event, n)"
            (mousedown)="keepSelection($event)"
            (click)="$event.stopPropagation()"
            (focus)="readonly() || store.selectNote(n.id)"
          >
            <!-- A bigger invisible target, easier to grab -->
            <rect [attr.x]="n.x - 11" [attr.y]="n.y - 9" width="22" height="18" fill="transparent" />
            @for (ly of n.ledgers; track ly) {
              <line [attr.x1]="n.x - 11" [attr.x2]="n.x + 11" [attr.y1]="ly" [attr.y2]="ly" stroke="currentColor" stroke-width="1.2" />
            }
            @if (n.kind === 'whole') {
              <ellipse [attr.cx]="n.x" [attr.cy]="n.y" rx="7.4" ry="5" fill="none" stroke="currentColor" stroke-width="2" />
            } @else {
              <ellipse
                [attr.cx]="n.x"
                [attr.cy]="n.y"
                rx="6.3"
                ry="4.6"
                [attr.transform]="'rotate(-20 ' + n.x + ' ' + n.y + ')'"
                [attr.fill]="n.hollow ? 'none' : 'currentColor'"
                stroke="currentColor"
                [attr.stroke-width]="n.hollow ? 1.7 : 1"
              />
              @if (n.hasStem) {
                <line [attr.x1]="n.stemX" [attr.x2]="n.stemX" [attr.y1]="n.stemBase" [attr.y2]="n.stemEnd" stroke="currentColor" stroke-width="1.4" />
              }
              @for (f of flagList(n.hasStem ? n.flags : 0); track f) {
                <path
                  [attr.d]="flagPath(n, f)"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
              }
            }
            @if (n.dotted) {
              <circle [attr.cx]="n.dotX" [attr.cy]="n.dotY" r="1.9" fill="currentColor" />
            }
            @if (n.accidental) {
              <text class="music" [attr.x]="n.accX" [attr.y]="n.y + 5" font-size="40" fill="currentColor">{{ glyph[n.accidental] }}</text>
            }
          </g>
        }

        <!-- Beams (neutral: they hang from several notes) -->
        @for (b of beams(); track b.key) {
          <line [attr.x1]="b.x1" [attr.y1]="b.y1" [attr.x2]="b.x2" [attr.y2]="b.y2" [attr.stroke-width]="b.width" class="pointer-events-none stroke-fg" />
        }

        <!-- Notes played that hit nothing (challenges) -->
        @for (m of markDraws(); track m.key) {
          <path [attr.d]="m.d" fill="none" stroke-width="1.9" stroke-linecap="round" class="pointer-events-none stroke-rec" />
        }

        <!-- Ties -->
        @for (t of ties(); track t.key) {
          <path [attr.d]="t.d" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" class="pointer-events-none text-fg" />
        }

        <!-- Slurs -->
        @for (sl of slurs(); track sl.key) {
          <path [attr.d]="sl.d" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" class="slur pointer-events-none text-fg" />
        }

        <!-- Where the repeat sign would go -->
        @if (repeatGhost(); as g) {
          <g class="pointer-events-none text-accent" opacity="0.7">
            <line [attr.x1]="g.x - 6" [attr.x2]="g.x - 6" [attr.y1]="g.top" [attr.y2]="g.bottom" stroke="currentColor" stroke-width="1.2" />
            <line [attr.x1]="g.x" [attr.x2]="g.x" [attr.y1]="g.top" [attr.y2]="g.bottom" stroke="currentColor" stroke-width="3.2" />
            @for (cy of g.dotsY; track cy) {
              <circle [attr.cx]="g.x - 13" [attr.cy]="cy" r="2.2" fill="currentColor" />
            }
          </g>
        }

        <!-- Where the note would land -->
        @if (ghost(); as g) {
          <g class="pointer-events-none" [class]="g.fits ? 'text-accent' : 'text-rec'" opacity="0.6">
            @for (ly of g.ledgers; track ly) {
              <line [attr.x1]="g.x - 11" [attr.x2]="g.x + 11" [attr.y1]="ly" [attr.y2]="ly" stroke="currentColor" stroke-width="1.2" />
            }
            <ellipse
              [attr.cx]="g.x"
              [attr.cy]="g.y"
              rx="6.3"
              ry="4.6"
              [attr.transform]="'rotate(-20 ' + g.x + ' ' + g.y + ')'"
              [attr.fill]="g.hollow ? 'none' : 'currentColor'"
              stroke="currentColor"
              stroke-width="1.5"
            />
          </g>
        }

        <!-- Playhead -->
        @if (playhead(); as ph) {
          <g class="pointer-events-none">
            <line [attr.x1]="ph.x" [attr.x2]="ph.x" [attr.y1]="ph.top + RULER_H" [attr.y2]="ph.top + SYSTEM_H" class="stroke-accent" stroke-width="1.5" />
            <path [attr.d]="'M ' + (ph.x - 5) + ' ' + (ph.top + RULER_H - 9) + ' h 10 l -5 8 z'" class="fill-accent" />
          </g>
        }
      </svg>
    }
  `,
})
export class ScoreStaffComponent {
  protected readonly store = inject(ScoreStore);
  private readonly i18n = inject(I18nService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly svg = viewChild<ElementRef<SVGSVGElement>>('svg');

  protected readonly SYSTEM_H = SYSTEM_H;
  protected readonly RULER_H = RULER_H;
  protected readonly LS = LINE_SPACING;
  protected readonly STEP_PX = STEP_PX;
  protected readonly glyph = GLYPH;
  protected readonly staves = STAFF_NAMES;
  protected readonly lineIdx = [0, 1, 2, 3, 4];

  /** Width of the view in pixels (0 until measured): the bars are broken into lines that fit it. */
  private readonly viewW = signal(0);

  /** Shows this score read-only (a challenge) instead of the one being edited. */
  readonly score = input<ScoreDto | null>(null);
  /** Read-only: how each note went, by note id (`null` = not played yet). */
  readonly noteStates = input<Record<string, NoteStatus | null> | null>(null);
  /** Read-only: notes that were played and hit nothing. */
  readonly marks = input<StaffMark[]>([]);
  /** Read-only: where the playhead is, in ticks (`null` = none). */
  readonly playheadTick = input<number | null>(null);
  /** Read-only: keep the playhead's line in view. */
  readonly follow = input(false);
  /** Read-only: pixels per quarter note (the editor uses its own zoom). */
  readonly zoom = input<number | null>(null);

  protected readonly readonly = computed(() => this.score() !== null);
  protected readonly doc = computed(() => this.score() ?? this.store.doc());

  protected readonly layout = computed(() => {
    const d = this.doc();
    const width = this.viewW();
    return layoutOf(d ?? { beats: 4, beat_unit: 4, bars: 1, pickup_ticks: 0 }, this.zoom() ?? this.store.zoom(), width > 0 ? width : Number.POSITIVE_INFINITY);
  });
  /** What each system draws apart from the notes. */
  protected readonly views = computed<SystemView[]>(() => {
    const d = this.doc();
    return d ? systemViews(d, this.layout()) : [];
  });

  /** Noteheads, stems and beams (see `core/score-draw`). */
  private readonly drawn = computed(() => {
    const d = this.doc();
    return d ? drawNotes(d, this.layout()) : { notes: [], beams: [] };
  });

  protected readonly beams = computed(() => this.drawn().beams);

  protected readonly notes = computed<LabeledNote[]>(() => {
    const d = this.doc();
    if (!d) return [];
    const names = parseNoteNames(this.i18n.t('music.noteNames'));
    return this.drawn().notes.map((n) => {
      const note = findNote(d, n.id)?.note;
      return {
        ...n,
        label: this.i18n.t('score.noteLabel', {
          note: note ? spelledNoteName(note.key, note.accidental, names) : '',
          value: this.i18n.t(`score.values.${n.kind}`),
          staff: this.i18n.t(`score.staff.${n.staff}`),
          bar: barLabel(d, barOf(d, n.start)) ?? this.i18n.t('score.pickupBar'),
        }),
      };
    });
  });

  /** Arcs joining a note to the one it is tied to, on the side opposite to the stem. */
  protected readonly ties = computed<CurveDraw[]>(() => {
    const d = this.doc();
    return d ? drawTies(d, this.layout(), this.drawn().notes) : [];
  });

  /** Slurs over the notes they cover. */
  protected readonly slurs = computed<CurveDraw[]>(() => {
    const d = this.doc();
    return d ? drawSlurs(d, this.layout(), this.drawn().notes) : [];
  });

  protected readonly rests = computed<RestDraw[]>(() => {
    const d = this.doc();
    return d ? drawRests(d, this.layout()) : [];
  });

  /** Notes under the playhead (they light up while the score plays). */
  protected readonly playingIds = computed(() => {
    const ids = new Set<string>();
    const d = this.doc();
    if (!d || this.readonly() || !this.store.playing()) return ids;
    const t = this.store.positionTicks();
    for (const staff of STAFF_NAMES) for (const n of staffNotes(d, staff)) if (n.tick <= t && t < noteEnd(n)) ids.add(n.id);
    return ids;
  });

  /** The playhead: where it is and the top of the system it is in. */
  protected readonly playhead = computed(() => {
    const d = this.doc();
    if (this.readonly()) {
      const tick = this.playheadTick();
      if (!d || tick === null) return null;
      const l = this.layout();
      return { x: xOfTick(l, tick), top: systemAt(l, tick).top };
    }
    const key = this.store.key();
    if (!d || !key) return null;
    if (!this.store.playing() && !(this.store.position() > 0)) return null;
    const l = this.layout();
    const tick = this.store.positionTicks();
    return { x: xOfTick(l, tick), top: systemAt(l, tick).top };
  });

  /** Pointer position over the staff (hover, or a value dragged from the palette). */
  private readonly hover = signal<Hit | null>(null);
  /** The pointer in SVG pixels (`null` outside the staff): where the repeat sign would snap to. */
  private readonly pointerAt = signal<{ x: number; y: number } | null>(null);

  /** The bar line the repeat sign would go on while it is being dragged or chosen. */
  protected readonly repeatGhost = computed(() => {
    const d = this.doc();
    const p = this.pointerAt();
    if (!d || !p || this.readonly() || !(this.store.repeatDrag() || this.store.repeatTool())) return null;
    const l = this.layout();
    const hit = barLineAt(l, d, p.x, p.y);
    if (!hit) return null;
    const sys = l.systems[hit.system];
    const top = sys.staves.treble.top;
    const bottom = sys.staves.bass.bottom;
    return { bar: hit.bar, x: hit.x, top, bottom, dotsY: [sys.staves.treble.top + 15, sys.staves.treble.top + 25, sys.staves.bass.top + 15, sys.staves.bass.top + 25] };
  });
  private drag: NoteDrag | null = null;
  private suppressClick = false;
  /** The note being moved (once the pointer has gone past the threshold) and where it would land. */
  protected readonly draggingId = signal<string | null>(null);
  private readonly dragTarget = signal<NoteDrag['target']>(null);

  protected readonly ghost = computed<Ghost | null>(() => {
    const d = this.doc();
    if (!d || this.readonly() || this.store.repeatDrag() || this.store.repeatTool()) return null;
    const l = this.layout();
    const palette = this.store.paletteDrag();
    // Moving a note shows the target; otherwise the tool follows the pointer.
    const moving = this.draggingId() ? this.drag : null;
    const base = moving ? moving.duration : palette ? durationTicks(palette.kind, palette.dotted) : this.store.toolTicks();
    const target = moving ? this.dragTarget() : this.hoverTarget(base);
    if (!target) return null;
    // A note put where others start joins them as a chord and takes their value.
    const duration = moving ? moving.duration : (chordDuration(d, target.staff, target.tick) ?? base);
    const accidental = moving ? findNote(d, moving.id)?.note.accidental : this.store.accidental();
    const pitch = pitchAt(target.staff, target.step, accidental);
    const sys = systemAt(l, target.tick);
    return {
      ...target,
      x: noteX(l, target.tick),
      y: yOfStep(sys, target.staff, target.step),
      fits: !!pitch && canPlace(d, target.staff, target.tick, duration, moving?.id ?? null, pitch.key),
      ledgers: ledgerSteps(target.step).map((st) => yOfStep(sys, target.staff, st)),
      hollow: duration >= 960,
    };
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.measure();
      if (typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => this.measure());
      ro.observe(this.host.nativeElement);
      destroyRef.onDestroy(() => ro.disconnect());
    });
    // Keeps the playhead in view while the score plays: it scrolls to the line it is in.
    effect(() => {
      const ph = this.playhead();
      if (!ph || !(this.readonly() ? this.follow() : this.store.playing())) return;
      untracked(() => this.scrollTo(ph.top));
    });
  }

  /** Reads the width of the view, which decides how many bars fit in a line. */
  protected measure(): void {
    this.viewW.set(Math.max(0, Math.floor(this.host.nativeElement.clientWidth)));
  }

  /** Brings the system at `top` (pixels from the top of the score) into view in the scrolling ancestor. */
  private scrollTo(top: number): void {
    const el = this.host.nativeElement;
    let parent: HTMLElement | null = el.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    if (!parent) return;
    const box = el.getBoundingClientRect();
    const view = parent.getBoundingClientRect();
    const y0 = box.top + top;
    if (y0 < view.top + 8 || y0 + SYSTEM_H > view.bottom - 8) parent.scrollTop += y0 - view.top - 80;
  }

  /** Text colour of a note by how it went in the challenge. */
  protected stateColor(id: string): string {
    switch (this.noteStates()?.[id]) {
      case 'perfect':
        return 'text-ok';
      case 'good':
        return 'text-ok/60';
      case 'missed':
        return 'text-rec';
      default:
        return 'text-fg';
    }
  }

  /** A cross where a played note hit nothing, on the line or space of its key. */
  protected readonly markDraws = computed(() => {
    const d = this.doc();
    if (!d || !this.readonly()) return [];
    const l = this.layout();
    return this.marks().map((m, i) => {
      const staff: StaffName = m.key >= 60 ? 'treble' : 'bass';
      const sys = systemAt(l, m.tick);
      const x = noteX(l, m.tick);
      const y = yOfStep(sys, staff, staffStep(staff, m.key, isBlackKey(m.key) ? 'sharp' : null));
      return { key: `${i}-${m.tick}-${m.key}`, d: `M ${x - 5} ${y - 5} L ${x + 5} ${y + 5} M ${x + 5} ${y - 5} L ${x - 5} ${y + 5}` };
    });
  });

  protected x(tick: number): number {
    return xOfTick(this.layout(), tick);
  }

  protected flagList(n: number): number[] {
    return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  }

  protected readonly flagPath = flagPath;

  /** Where a clef of a system is drawn. */
  protected clefAt(sys: SystemBox, staff: StaffName): { x: number; y: number } {
    return clefOrigin(sys.staves[staff], staff);
  }

  // ---- Pointer ----

  /** Point of the SVG under a pointer event (the SVG is drawn at its natural size). */
  private point(ev: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const el = this.svg()?.nativeElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** Where a note of `duration` would be put for a pointer position, snapped to the grid of its value. */
  private hoverTarget(duration: number): NonNullable<NoteDrag['target']> | null {
    const hit = this.hover();
    const d = this.doc();
    if (!hit || !d) return null;
    return { staff: hit.staff, step: hit.step, tick: snapTickInBar(d, hit.tick, this.gridOf(duration), duration) };
  }

  private gridOf(duration: number): number {
    return gridTicks(notatedValue(duration)?.kind ?? 'quarter');
  }


  protected onMove(ev: PointerEvent): void {
    if (this.readonly()) return;
    const p = this.point(ev);
    const l = this.layout();
    const d = this.doc();
    if (!p || !d) return;
    const hit = hitAt(l, p.x, p.y);
    const inside = p.x >= 0 && p.x <= l.width && p.y >= 0 && p.y <= l.height;
    this.pointerAt.set(inside ? p : null);
    const drag = this.drag;
    if (drag && drag.pointerId === ev.pointerId) {
      if (!drag.moved) {
        if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        this.draggingId.set(drag.id);
      }
      this.dragTarget.set(hit ? { staff: hit.staff, step: hit.step, tick: snapTickInBar(d, hit.tick, this.gridOf(drag.duration), drag.duration) } : null);
      this.hover.set(null);
      return;
    }
    // Only the current tool or a value from the palette needs the hover.
    this.hover.set(inside ? hit : null);
  }

  protected onUp(ev: PointerEvent): void {
    if (this.readonly()) return;
    const d = this.doc();
    const palette = this.store.paletteDrag();
    if (palette) {
      const g = this.ghost();
      this.store.paletteDrag.set(null);
      if (g?.fits && d) {
        this.store.setTool(palette.kind, palette.dotted);
        this.store.placeNote(g.staff, g.tick, g.step);
      }
      this.hover.set(null);
      return;
    }
    if (this.store.repeatDrag()) {
      const g = this.repeatGhost();
      this.store.repeatDrag.set(false);
      this.pointerAt.set(null);
      if (g) this.store.setRepeatBar(g.bar);
      return;
    }
    const drag = this.drag;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    const target = this.dragTarget();
    this.drag = null;
    this.draggingId.set(null);
    this.dragTarget.set(null);
    if (drag.moved) {
      // The click that follows a drag must not put a note where it ended.
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false));
      if (target) this.store.moveTo(drag.id, target.staff, target.tick, target.step);
    }
  }

  protected cancel(): void {
    this.drag = null;
    this.draggingId.set(null);
    this.dragTarget.set(null);
    this.hover.set(null);
    this.pointerAt.set(null);
    this.store.paletteDrag.set(null);
    this.store.repeatDrag.set(false);
  }

  /** Pressing the repeat sign selects it and starts dragging it to another bar line. */
  protected repeatDown(ev: PointerEvent): void {
    if (this.readonly() || ev.button !== 0) return;
    ev.stopPropagation();
    this.store.selectRepeat();
    this.store.repeatDrag.set(true);
    const p = this.point(ev);
    if (p) this.pointerAt.set(p);
  }

  /** A shift press must not focus the note (the `(focus)` handler would select it); a handler returning `false` would cancel every press. */
  protected keepSelection(ev: MouseEvent): void {
    if (ev.shiftKey) ev.preventDefault();
  }

  protected noteDown(ev: PointerEvent, n: LabeledNote): void {
    if (this.readonly() || ev.button !== 0) return;
    ev.stopPropagation();
    // Shift+click slurs the selected note to this one (if they are in the same hand). The mousedown above keeps
    // the note from taking focus, which would select it (see `(focus)`) and move the start of the next slur.
    if (ev.shiftKey && this.store.selectedNoteId() && this.store.selectedNoteId() !== n.id) {
      this.store.slurSelectedTo(n.id);
      return;
    }
    this.store.selectNote(n.id);
    const ref = this.store.selectedNote();
    this.drag = {
      id: n.id,
      pointerId: ev.pointerId,
      x0: ev.clientX,
      y0: ev.clientY,
      moved: false,
      duration: ref?.note.duration_ticks ?? 480,
      target: null,
    };
  }

  /** Pressing the ruler moves the playhead. */
  protected rulerDown(ev: PointerEvent): void {
    if (this.readonly() || ev.button !== 0) return;
    const p = this.point(ev);
    const d = this.doc();
    const l = this.layout();
    if (p && d && inRuler(l, p.x, p.y)) void this.store.seekToTick(rulerTick(l, d, p.x, p.y));
  }

  /**
   * A click on the staff puts a note of the current value. It is a click and not a press so that on a
   * touch screen a swipe scrolls the score instead of dropping notes.
   */
  protected background(ev: MouseEvent): void {
    if (this.readonly() || ev.button !== 0 || this.suppressClick) return;
    const p = this.point(ev);
    const d = this.doc();
    if (!p || !d) return;
    const l = this.layout();
    if (inRuler(l, p.x, p.y)) return;
    // With the repeat sign chosen, a click puts it on the closest bar line.
    if (this.store.repeatTool()) {
      const line = barLineAt(l, d, p.x, p.y);
      if (line) this.store.setRepeatBar(line.bar);
      return;
    }
    this.store.repeatSelected.set(false);
    const hit = hitAt(l, p.x, p.y);
    if (!hit) {
      this.store.selectNote(null);
      return;
    }
    const tick = snapTickInBar(d, hit.tick, this.gridOf(this.store.toolTicks()), this.store.toolTicks());
    if (!this.store.placeNote(hit.staff, tick, hit.step)) this.store.selectNote(null);
  }
}
