import type { PracticeDayDto } from './models';
import {
  addDays,
  dayOfWeek,
  firstDayOfWeek,
  heatLevel,
  heatmapWeeks,
  isoDate,
  lastDays,
  monthStarts,
  startOfWeek,
  streaks,
  weekTotalMs,
} from './stats';

const MIN = 60_000;
const day = (date: string, minutes: number): PracticeDayDto => ({ date, duration_ms: minutes * MIN, sessions: 1 });

describe('stats', () => {
  it('does day arithmetic across months, years and DST changes', () => {
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(isoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('finds the start of the week for Monday and Sunday weeks', () => {
    // 2026-10-21 is a Wednesday.
    expect(dayOfWeek('2026-10-21')).toBe(3);
    expect(dayOfWeek('2026-10-25')).toBe(7);
    expect(startOfWeek('2026-10-21', 1)).toBe('2026-10-19');
    expect(startOfWeek('2026-10-21', 7)).toBe('2026-10-18');
    expect(startOfWeek('2026-10-19', 1)).toBe('2026-10-19');
    expect(startOfWeek('2026-10-25', 1)).toBe('2026-10-19');
  });

  it('knows the first day of the week of a locale', () => {
    expect(firstDayOfWeek('es-ES')).toBe(1);
    expect(firstDayOfWeek('en-US')).toBe(7);
  });

  it('counts the current and best streaks', () => {
    const days = [
      day('2026-10-01', 20),
      day('2026-10-02', 5),
      day('2026-10-03', 40),
      day('2026-10-05', 0.5), // under a minute: does not count
      day('2026-10-19', 10),
      day('2026-10-20', 10),
    ];
    // Today without practice yet: the streak up to yesterday is still alive.
    expect(streaks(days, '2026-10-21')).toEqual({ current: 2, best: 3 });
    expect(streaks([...days, day('2026-10-21', 3)], '2026-10-21')).toEqual({ current: 3, best: 3 });
    // A missed day breaks it.
    expect(streaks(days, '2026-10-22')).toEqual({ current: 0, best: 3 });
    expect(streaks([], '2026-10-22')).toEqual({ current: 0, best: 0 });
  });

  it('adds up the current week', () => {
    const days = [day('2026-10-18', 30), day('2026-10-19', 20), day('2026-10-21', 15), day('2026-10-22', 99)];
    expect(weekTotalMs(days, '2026-10-21', 1)).toBe(35 * MIN);
    expect(weekTotalMs(days, '2026-10-21', 7)).toBe(65 * MIN);
  });

  it('fills the last days with zeros', () => {
    const got = lastDays([day('2026-10-20', 12)], '2026-10-21', 3);
    expect(got).toEqual([
      { date: '2026-10-19', ms: 0 },
      { date: '2026-10-20', ms: 12 * MIN },
      { date: '2026-10-21', ms: 0 },
    ]);
  });

  it('maps minutes to heat levels', () => {
    expect([0, 0.9, 1, 14, 15, 29, 30, 59, 60, 300].map((m) => heatLevel(m * MIN))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('builds the heatmap ending in the current week', () => {
    const weeks = heatmapWeeks([day('2026-10-20', 45), day('2025-01-01', 90)], '2026-10-21', 1);
    expect(weeks).toHaveLength(53);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    const last = weeks[52];
    expect(last[0].date).toBe('2026-10-19');
    expect(last[1]).toEqual({ date: '2026-10-20', ms: 45 * MIN, level: 3, future: false });
    expect(last[3].future).toBe(true);
    expect(weeks[0][0].date).toBe('2025-10-20');
    // Days outside the range are ignored.
    expect(weeks.flat().some((c) => c.date === '2025-01-01')).toBe(false);

    const months = monthStarts(weeks);
    expect(months[0]).toEqual({ column: 1, date: '2025-11-01' });
    expect(months.at(-1)).toEqual({ column: 49, date: '2026-10-01' });
    expect(months).toHaveLength(12);
  });
});
