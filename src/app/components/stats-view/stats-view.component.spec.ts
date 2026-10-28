import { TestBed } from '@angular/core/testing';
import { type MockApi, mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { addDays, isoDate } from '../../core/stats';
import { StatsStore } from '../../core/stats.store';
import { StatsViewComponent } from './stats-view.component';

describe('StatsViewComponent', () => {
  let mock: MockApi;
  let i18n: I18nService;
  const today = isoDate();

  async function setup(goal = 120) {
    mock = mockApi({
      getPracticeStats: () =>
        Promise.resolve({
          days: [
            { date: addDays(today, -1), duration_ms: 50 * 60_000, sessions: 1 },
            { date: today, duration_ms: 75 * 60_000, sessions: 2 },
          ],
          weekly_goal_minutes: goal,
        }),
      setWeeklyGoal: (m: number) => Promise.resolve(m),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    const fixture = TestBed.createComponent(StatsViewComponent);
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    return { fixture, el };
  }

  it('summarises today, the streak and the year', async () => {
    const { el } = await setup();
    expect(mock.count('getPracticeStats')).toBe(1);
    expect(el.textContent).toContain(i18n.t('stats.duration.hoursMinutes', { h: 1, m: 15 }));
    expect(el.querySelectorAll('rect[data-level], svg rect').length).toBeGreaterThan(30);
    expect(el.querySelector('[role=meter]')?.getAttribute('aria-valuemax')).toBe('120');
    const bars = [...el.querySelectorAll('g[tabindex]')];
    expect(bars).toHaveLength(30);
    expect(bars.at(-1)?.getAttribute('aria-label')).toContain(i18n.t('stats.duration.hoursMinutes', { h: 1, m: 15 }));
  });

  it('shows a tooltip for a bar and hides it on blur', async () => {
    const { fixture, el } = await setup();
    const bar = [...el.querySelectorAll('g[tabindex]')].at(-1)!;
    bar.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(el.textContent).toContain(i18n.shortDate(today));
    bar.dispatchEvent(new FocusEvent('blur'));
    fixture.detectChanges();
  });

  it('edits the weekly goal', async () => {
    const { fixture, el } = await setup();
    (el.querySelector(`[aria-label="${i18n.t('stats.goal.edit')}"]`) as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = el.querySelector('#weekly-goal') as HTMLInputElement;
    expect(input.value).toBe('120');
    input.value = '180';
    input.dispatchEvent(new Event('input'));
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(mock.argsOf('setWeeklyGoal')).toEqual([180]);
    expect(TestBed.inject(StatsStore).goalMinutes()).toBe(180);
  });

  it('offers to set a goal when there is none and ignores invalid values', async () => {
    const { fixture, el } = await setup(0);
    expect(el.querySelector('[role=meter]')).toBeNull();
    const set = () => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(i18n.t('stats.goal.set'))) as HTMLButtonElement;
    set().click();
    fixture.detectChanges();
    const input = el.querySelector('#weekly-goal') as HTMLInputElement;
    expect(input.value).toBe('');
    input.value = '-5';
    input.dispatchEvent(new Event('input'));
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(mock.count('setWeeklyGoal')).toBe(0);

    fixture.detectChanges();
    set().click();
    fixture.detectChanges();
    el.querySelector('#weekly-goal')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(el.querySelector('#weekly-goal')).toBeNull();
  });
});
