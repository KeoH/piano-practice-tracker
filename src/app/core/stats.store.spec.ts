import { TestBed } from '@angular/core/testing';
import { type MockApi, mockApi } from '../testing/mock-api';
import { I18nService } from './i18n/i18n.service';
import { isoDate } from './stats';
import { StatsStore } from './stats.store';
import { ToastService } from './toast.service';

describe('StatsStore', () => {
  let store: StatsStore;
  let mock: MockApi;
  const today = isoDate();

  beforeEach(() => {
    mock = mockApi({
      getPracticeStats: () =>
        Promise.resolve({ days: [{ date: today, duration_ms: 25 * 60_000, sessions: 2 }], weekly_goal_minutes: 120 }),
      setWeeklyGoal: (minutes: number) => Promise.resolve(Math.min(minutes, 600)),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(StatsStore);
  });

  it('loads the whole history up to today', async () => {
    await store.load();
    expect(mock.argsOf('getPracticeStats')).toEqual(['1970-01-01', today]);
    expect(store.todayMs()).toBe(25 * 60_000);
    expect(store.weekMs()).toBe(25 * 60_000);
    expect(store.goalMinutes()).toBe(120);
    expect(store.streaks().current).toBe(1);
    expect(store.firstDay()).toBeGreaterThanOrEqual(0);
  });

  it('keeps the goal the backend stored', async () => {
    await store.setGoal(30);
    expect(store.goalMinutes()).toBe(0); // nothing loaded yet
    await store.load();
    await store.setGoal(9999);
    expect(store.goalMinutes()).toBe(600);
  });

  it('reports failures and resets', async () => {
    mock.set('getPracticeStats', () => Promise.reject('db'));
    mock.set('setWeeklyGoal', () => Promise.reject('db'));
    await store.load();
    await store.setGoal(10);
    expect(TestBed.inject(ToastService).toasts().map((t) => t.kind)).toEqual(['error', 'error']);
    expect(store.loading()).toBe(false);
    store.reset();
    expect(store.data()).toBeNull();
    expect(store.days()).toEqual([]);
  });

  it('does not load without the backend', async () => {
    mock = mockApi({ available: false });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [mock.provider] });
    await TestBed.inject(StatsStore).load();
    expect(mock.calls).toEqual([]);
  });
});
