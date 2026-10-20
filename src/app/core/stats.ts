import type { PracticeDayDto } from './models';

// Practice statistics: pure functions over ISO dates (`YYYY-MM-DD`, local calendar days). Day
// arithmetic goes through UTC so daylight saving changes never skip or repeat a day.

/** A day counts for a streak with at least one minute of practice. */
export const MIN_STREAK_MS = 60_000;
/** Heatmap levels: minutes from which each level starts (level 0 = less than a minute). */
export const HEAT_THRESHOLDS_MIN = [1, 15, 30, 60] as const;
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

const DAY_MS = 86_400_000;

function toUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Local date of `now` as ISO. */
export function isoDate(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function addDays(iso: string, n: number): string {
  return fromUtc(toUtc(iso) + n * DAY_MS);
}

/** 1 = Monday … 7 = Sunday. */
export function dayOfWeek(iso: string): number {
  return new Date(toUtc(iso)).getUTCDay() || 7;
}

/** First day of the week containing `iso`, with weeks starting on `firstDay` (1 = Monday … 7 = Sunday). */
export function startOfWeek(iso: string, firstDay: number): string {
  return addDays(iso, -((dayOfWeek(iso) - firstDay + 7) % 7));
}

/** First day of the week for a locale (`Intl.Locale` week info; Monday if unknown). */
export function firstDayOfWeek(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay;
  } catch {
    // Old engines: fall through to the heuristic.
  }
  return /-(US|CA|MX|BR|JP|IL|PH)$/i.test(locale) ? 7 : 1;
}

function byDate(days: readonly PracticeDayDto[]): Map<string, number> {
  return new Map(days.map((d) => [d.date, d.duration_ms]));
}

/**
 * Current streak (consecutive days with practice up to today, or up to yesterday while today has
 * no practice yet) and the best streak ever.
 */
export function streaks(days: readonly PracticeDayDto[], today: string): { current: number; best: number } {
  const practiced = days.filter((d) => d.duration_ms >= MIN_STREAK_MS).map((d) => d.date).sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const date of practiced) {
    run = prev !== null && addDays(prev, 1) === date ? run + 1 : 1;
    best = Math.max(best, run);
    prev = date;
  }
  const set = new Set(practiced);
  let cursor = set.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  return { current, best };
}

/** Practice in the week that contains `today`. */
export function weekTotalMs(days: readonly PracticeDayDto[], today: string, firstDay: number): number {
  const start = startOfWeek(today, firstDay);
  return days.filter((d) => d.date >= start && d.date <= today).reduce((t, d) => t + d.duration_ms, 0);
}

/** The last `n` days up to `today` (oldest first), with 0 on days without practice. */
export function lastDays(days: readonly PracticeDayDto[], today: string, n: number): { date: string; ms: number }[] {
  const map = byDate(days);
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(today, i - n + 1);
    return { date, ms: map.get(date) ?? 0 };
  });
}

export function heatLevel(ms: number): HeatLevel {
  const minutes = ms / 60_000;
  let level = 0;
  for (const t of HEAT_THRESHOLDS_MIN) if (minutes >= t) level++;
  return level as HeatLevel;
}

export interface HeatCell {
  date: string;
  ms: number;
  level: HeatLevel;
  /** After `today`: drawn empty and without a tooltip. */
  future: boolean;
}

/**
 * Calendar heatmap: `weeks` columns of 7 days (from `firstDay`), the last column being the week of
 * `today`.
 */
export function heatmapWeeks(days: readonly PracticeDayDto[], today: string, firstDay: number, weeks = 53): HeatCell[][] {
  const map = byDate(days);
  const first = addDays(startOfWeek(today, firstDay), -7 * (weeks - 1));
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = addDays(first, w * 7 + d);
      const ms = map.get(date) ?? 0;
      const future = date > today;
      return { date, ms, level: future ? 0 : heatLevel(ms), future };
    }),
  );
}

/** Columns where a month starts (for the labels above the heatmap). */
export function monthStarts(weeks: readonly HeatCell[][]): { column: number; date: string }[] {
  const out: { column: number; date: string }[] = [];
  let lastMonth = '';
  weeks.forEach((col, i) => {
    const firstOfMonth = col.find((c) => c.date.endsWith('-01'));
    const month = (firstOfMonth ?? col[0]).date.slice(0, 7);
    if (i === 0) {
      lastMonth = col[0].date.slice(0, 7);
      return;
    }
    if (firstOfMonth && month !== lastMonth) {
      out.push({ column: i, date: firstOfMonth.date });
      lastMonth = month;
    }
  });
  return out;
}
