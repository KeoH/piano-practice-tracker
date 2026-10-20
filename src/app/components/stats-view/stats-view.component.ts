import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import { HEAT_THRESHOLDS_MIN, heatmapWeeks, lastDays, monthStarts } from '../../core/stats';
import { StatsStore } from '../../core/stats.store';
import { IconComponent } from '../icon/icon.component';

/** Heatmap geometry (SVG units): cell, gap between cells (surface gap), and label margins. */
const CELL = 13;
const GAP = 3;
const HEAT_LEFT = 30;
const HEAT_TOP = 18;
const WEEKS = 53;

/** Bar chart of the last days (SVG units). */
const BAR_DAYS = 30;
const BAR_W = 900;
const BAR_H = 190;
const BAR_LEFT = 44;
const BAR_BOTTOM = 22;
const BAR_TOP = 8;
const BAR_MAX_THICK = 24;
const BAR_RADIUS = 4;
/** Candidate steps of the minutes axis. */
const TICK_STEPS_MIN = [5, 10, 15, 30, 60, 120, 240];

interface Tip {
  x: number;
  y: number;
  value: string;
  label: string;
}

/** Practice statistics: today, the week against the goal, streaks, a year heatmap and the last 30 days. */
@Component({
  selector: 'app-stats-view',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe, PluralPipe],
  templateUrl: './stats-view.component.html',
})
export class StatsViewComponent {
  protected readonly stats = inject(StatsStore);
  private readonly i18n = inject(I18nService);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('chartsPanel');

  protected readonly Math = Math;
  protected readonly cell = CELL;
  protected readonly heatWidth = HEAT_LEFT + WEEKS * (CELL + GAP) - GAP;
  protected readonly heatHeight = HEAT_TOP + 7 * (CELL + GAP) - GAP;
  protected readonly barW = BAR_W;
  protected readonly barH = BAR_H;
  protected readonly barLeft = BAR_LEFT;
  protected readonly barBaseline = BAR_H - BAR_BOTTOM;

  protected readonly tip = signal<Tip | null>(null);
  protected readonly editingGoal = signal(false);
  protected readonly goalDraft = signal('');

  // ---- Heatmap ----
  protected readonly weeks = computed(() => heatmapWeeks(this.stats.days(), this.stats.today(), this.stats.firstDay(), WEEKS));
  protected readonly heatCells = computed(() =>
    this.weeks().flatMap((col, w) =>
      col.flatMap((c, row) =>
        c.future ? [] : [{ ...c, x: HEAT_LEFT + w * (CELL + GAP), y: HEAT_TOP + row * (CELL + GAP) }],
      ),
    ),
  );
  protected readonly monthLabels = computed(() => {
    const fmt = new Intl.DateTimeFormat(this.i18n.locale(), { month: 'short', timeZone: 'UTC' });
    return monthStarts(this.weeks()).map((m) => ({
      x: HEAT_LEFT + m.column * (CELL + GAP),
      label: fmt.format(new Date(`${m.date}T00:00:00Z`)).replace('.', ''),
    }));
  });
  /** Three weekday labels (rows 0, 2, 4), in the order of the locale's week. */
  protected readonly weekdayLabels = computed(() => {
    const first = this.weeks()[0];
    if (!first) return [];
    const fmt = new Intl.DateTimeFormat(this.i18n.locale(), { weekday: 'short', timeZone: 'UTC' });
    return [0, 2, 4].map((row) => ({
      y: HEAT_TOP + row * (CELL + GAP) + CELL / 2,
      label: fmt.format(new Date(`${first[row].date}T00:00:00Z`)).replace('.', ''),
    }));
  });
  protected readonly legend = computed(() => {
    const [a, b, c, d] = HEAT_THRESHOLDS_MIN;
    return [
      { level: 0, label: this.i18n.t('stats.heat.none') },
      { level: 1, label: `${a}–${b} min` },
      { level: 2, label: `${b}–${c} min` },
      { level: 3, label: `${c}–${d} min` },
      { level: 4, label: `≥ ${d} min` },
    ];
  });
  protected readonly yearMs = computed(() => this.heatCells().reduce((t, c) => t + c.ms, 0));
  protected readonly yearDays = computed(() => this.heatCells().filter((c) => c.ms >= 60_000).length);

  // ---- Last days ----
  protected readonly lastDays = computed(() => lastDays(this.stats.days(), this.stats.today(), BAR_DAYS));
  private readonly axisMaxMin = computed(() => {
    const maxMin = Math.max(...this.lastDays().map((d) => d.ms / 60_000), 0);
    const step = TICK_STEPS_MIN.find((s) => maxMin / s <= 4) ?? TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1];
    return { step, max: Math.max(step, Math.ceil(maxMin / step) * step) };
  });
  protected readonly yTicks = computed(() => {
    const { step, max } = this.axisMaxMin();
    const ticks = [];
    for (let m = 0; m <= max; m += step) ticks.push({ y: this.yOf(m * 60_000), label: this.axisLabel(m) });
    return ticks;
  });
  protected readonly bars = computed(() => {
    const days = this.lastDays();
    const slot = (BAR_W - BAR_LEFT) / days.length;
    const thick = Math.min(BAR_MAX_THICK, slot - 2);
    const fmt = new Intl.DateTimeFormat(this.i18n.locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return days.map((d, i) => {
      const x = BAR_LEFT + i * slot + (slot - thick) / 2;
      const top = this.yOf(d.ms);
      return {
        ...d,
        x,
        slotX: BAR_LEFT + i * slot,
        slot,
        path: d.ms > 0 ? roundedTopBar(x, top, thick, this.barBaseline - top) : '',
        // A date under every 7th bar, counted from today.
        tick: (days.length - 1 - i) % 7 === 0 ? fmt.format(new Date(`${d.date}T00:00:00Z`)).replace('.', '') : null,
        center: x + thick / 2,
      };
    });
  });
  protected readonly lastDaysMs = computed(() => this.lastDays().reduce((t, d) => t + d.ms, 0));

  // ---- Goal ----
  protected readonly goalMs = computed(() => this.stats.goalMinutes() * 60_000);
  protected readonly goalProgress = computed(() => {
    const g = this.goalMs();
    return g > 0 ? Math.min(1, this.stats.weekMs() / g) : 0;
  });

  constructor() {
    void this.stats.load();
  }

  private yOf(ms: number): number {
    const max = this.axisMaxMin().max * 60_000;
    const h = this.barBaseline - BAR_TOP;
    return this.barBaseline - (max > 0 ? (ms / max) * h : 0);
  }

  private axisLabel(minutes: number): string {
    if (minutes === 0) return '0';
    return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes}`;
  }

  /** "45 min", "1 h 5 min", "2 h". */
  protected duration(ms: number): string {
    const total = Math.round(ms / 60_000);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return this.i18n.t('stats.duration.minutes', { m });
    return m === 0 ? this.i18n.t('stats.duration.hours', { h }) : this.i18n.t('stats.duration.hoursMinutes', { h, m });
  }

  protected dayLabel(date: string): string {
    return this.i18n.shortDate(date);
  }

  // ---- Tooltip (hover and keyboard focus) ----
  protected showTip(ev: Event, date: string, ms: number): void {
    const panel = this.panel()?.nativeElement;
    const target = ev.target as Element | null;
    if (!panel || !target) return;
    const p = panel.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    this.tip.set({
      x: r.left + r.width / 2 - p.left,
      y: r.top - p.top,
      value: ms > 0 ? this.duration(ms) : this.i18n.t('stats.heat.none'),
      label: this.dayLabel(date),
    });
  }

  protected hideTip(): void {
    this.tip.set(null);
  }

  // ---- Goal editing ----
  protected editGoal(): void {
    this.goalDraft.set(this.stats.goalMinutes() ? String(this.stats.goalMinutes()) : '');
    this.editingGoal.set(true);
  }

  protected async saveGoal(): Promise<void> {
    const minutes = Number.parseInt(this.goalDraft().trim() || '0', 10);
    this.editingGoal.set(false);
    if (Number.isNaN(minutes) || minutes < 0) return;
    if (minutes !== this.stats.goalMinutes()) await this.stats.setGoal(minutes);
  }
}

/** Column with a 4px rounded data end and a square base on the baseline. */
function roundedTopBar(x: number, top: number, width: number, height: number): string {
  const r = Math.min(BAR_RADIUS, width / 2, height);
  const bottom = top + height;
  return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`;
}
