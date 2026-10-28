import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

/** One line of the chart. Colours come from a validated palette (see `CHART_COLORS`). */
export interface ChartSeries {
  name: string;
  color: string;
  values: number[];
  /** Step line (holds each value until the next point). */
  step?: boolean;
  /** Dashed, for reference lines such as "best so far". */
  dashed?: boolean;
}

/**
 * Chart palette, validated for the dark surface (`#18181d`) with the dataviz validator: lightness
 * band, chroma floor and colour-blind separation. They are not the UI's accent on purpose: that
 * brass is too light for marks on this background.
 */
export const CHART_COLORS = { primary: '#b3801f', secondary: '#5b8fd0' } as const;

const PAD = { top: 12, right: 64, bottom: 24, left: 44 };

/**
 * Line chart over a shared x axis (one point per attempt), with a single y axis. Hovering shows a
 * crosshair and a tooltip with every series at that point. With two or more series it shows a
 * legend, and each line gets a direct label at its last point.
 */
@Component({
  selector: 'app-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative block w-full' },
  template: `
    @if (series().length > 1) {
      <ul class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" [attr.aria-label]="legendLabel()">
        @for (s of series(); track s.name) {
          <li class="flex items-center gap-1.5">
            <svg width="18" height="8" aria-hidden="true">
              <line x1="1" y1="4" x2="17" y2="4" [attr.stroke]="s.color" stroke-width="2" stroke-linecap="round" [attr.stroke-dasharray]="s.dashed ? '4 3' : null" />
            </svg>
            {{ s.name }}
          </li>
        }
      </ul>
    }
    <svg
      class="block w-full touch-none"
      [attr.height]="height()"
      [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
      role="img"
      [attr.aria-label]="ariaLabel()"
      (pointermove)="onMove($event)"
      (pointerleave)="hover.set(null)"
    >
      <!-- Recessive grid and y axis labels -->
      @for (t of yTicks(); track t) {
        <line [attr.x1]="pad.left" [attr.x2]="width() - pad.right" [attr.y1]="y(t)" [attr.y2]="y(t)" stroke="rgba(255,255,255,0.06)" />
        <text [attr.x]="pad.left - 8" [attr.y]="y(t)" text-anchor="end" dominant-baseline="middle" class="fill-faint text-[10.5px] tabular">{{ format()(t) }}</text>
      }
      @for (i of xTicks(); track i) {
        <text [attr.x]="x(i)" [attr.y]="height() - 6" text-anchor="middle" class="fill-faint text-[10.5px] tabular">{{ i + 1 }}</text>
      }
      @for (s of series(); track s.name) {
        <path [attr.d]="path(s)" fill="none" [attr.stroke]="s.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" [attr.stroke-dasharray]="s.dashed ? '5 4' : null" />
        @if (!s.dashed && s.values.length <= 60) {
          @for (v of s.values; track $index) {
            <circle [attr.cx]="x($index)" [attr.cy]="y(v)" r="4" [attr.fill]="s.color" stroke="#18181d" stroke-width="2" />
          }
        }
        @if (s.values.length && series().length > 1) {
          <text [attr.x]="x(s.values.length - 1) + 10" [attr.y]="y(s.values[s.values.length - 1])" dominant-baseline="middle" class="fill-fg-soft text-[11px]">{{ s.name }}</text>
        }
      }
      @if (hover(); as h) {
        <line [attr.x1]="x(h)" [attr.x2]="x(h)" [attr.y1]="pad.top" [attr.y2]="height() - pad.bottom" stroke="rgba(255,255,255,0.25)" />
        @for (s of series(); track s.name) {
          @if (s.values[h] !== undefined) {
            <circle [attr.cx]="x(h)" [attr.cy]="y(s.values[h])" r="5" [attr.fill]="s.color" stroke="#18181d" stroke-width="2" />
          }
        }
      }
    </svg>
    @if (hover(); as h) {
      <div
        class="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-line-hover bg-ink-950/95 px-3 py-2 text-xs shadow-lg"
        [style.left.px]="tooltipLeft(h)"
        [style.top.px]="series().length > 1 ? 30 : 6"
        role="status"
      >
        <p class="mb-1 font-semibold text-fg">{{ labels()[h] }}</p>
        @for (s of series(); track s.name) {
          <p class="flex items-center justify-between gap-3 text-muted">
            <span class="flex items-center gap-1.5"><span class="dot" [style.background]="s.color"></span>{{ s.name }}</span>
            <span class="tabular text-fg">{{ format()(s.values[h]) }}</span>
          </p>
        }
      </div>
    }
  `,
})
export class LineChartComponent {
  readonly series = input<ChartSeries[]>([]);
  /** Tooltip title of each point (e.g. date and tempo). */
  readonly labels = input<string[]>([]);
  readonly yMin = input(0);
  readonly yMax = input(1);
  readonly yTicks = input<number[]>([0, 0.5, 1]);
  readonly format = input<(v: number) => string>((v) => String(v));
  readonly height = input(200);
  readonly ariaLabel = input('');
  readonly legendLabel = input('');

  protected readonly pad = PAD;
  protected readonly width = signal(600);
  protected readonly hover = signal<number | null>(null);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly count = computed(() => Math.max(0, ...this.series().map((s) => s.values.length)));
  protected readonly xTicks = computed(() => {
    const n = this.count();
    const plot = this.width() - PAD.left - PAD.right;
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plot / 36))));
    return Array.from({ length: n }, (_, i) => i).filter((i) => i % every === 0 || i === n - 1);
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const ro = new ResizeObserver(() => this.width.set(Math.max(200, Math.round(el.getBoundingClientRect().width))));
      ro.observe(el);
      destroyRef.onDestroy(() => ro.disconnect());
    });
  }

  protected x(i: number): number {
    const n = this.count();
    const plot = this.width() - PAD.left - PAD.right;
    return n <= 1 ? PAD.left + plot / 2 : PAD.left + (i / (n - 1)) * plot;
  }

  protected y(v: number): number {
    const span = this.yMax() - this.yMin() || 1;
    const plot = this.height() - PAD.top - PAD.bottom;
    return PAD.top + (1 - (v - this.yMin()) / span) * plot;
  }

  protected path(s: ChartSeries): string {
    return s.values
      .map((v, i) => {
        if (i === 0) return `M${this.x(0)},${this.y(v)}`;
        return s.step ? `H${this.x(i)}V${this.y(v)}` : `L${this.x(i)},${this.y(v)}`;
      })
      .join('');
  }

  protected tooltipLeft(i: number): number {
    const x = this.x(i);
    return x > this.width() / 2 ? x - 160 : x + 12;
  }

  protected onMove(ev: PointerEvent): void {
    const n = this.count();
    if (!n) return;
    const rect = (ev.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * this.width();
    const plot = this.width() - PAD.left - PAD.right;
    const i = n <= 1 ? 0 : Math.round(((px - PAD.left) / plot) * (n - 1));
    this.hover.set(Math.min(n - 1, Math.max(0, i)));
  }
}
