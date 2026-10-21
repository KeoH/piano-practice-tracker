import { Injectable, computed, inject, signal } from '@angular/core';
import { I18nService } from './i18n/i18n.service';
import type { PracticeStatsDto } from './models';
import { firstDayOfWeek, isoDate, streaks, weekTotalMs } from './stats';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/** Practice statistics of the open vault (loaded when the statistics view opens). */
@Injectable({ providedIn: 'root' })
export class StatsStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  readonly data = signal<PracticeStatsDto | null>(null);
  readonly loading = signal(false);
  /** Date the data was loaded for (the day can change with the app open). */
  readonly today = signal(isoDate());

  readonly firstDay = computed(() => firstDayOfWeek(this.i18n.locale()));
  readonly days = computed(() => this.data()?.days ?? []);
  readonly goalMinutes = computed(() => this.data()?.weekly_goal_minutes ?? 0);
  readonly streaks = computed(() => streaks(this.days(), this.today()));
  readonly weekMs = computed(() => weekTotalMs(this.days(), this.today(), this.firstDay()));
  readonly todayMs = computed(() => this.days().find((d) => d.date === this.today())?.duration_ms ?? 0);

  reset(): void {
    this.data.set(null);
  }

  async load(): Promise<void> {
    if (!this.api.available) return;
    const today = isoDate();
    this.loading.set(true);
    try {
      // One row per day with practice: the whole history is small, and the best streak needs it.
      this.data.set(await this.api.getPracticeStats('1970-01-01', today));
      this.today.set(today);
    } catch (err) {
      this.toast.error(err, this.i18n.t('stats.errors.load'));
    } finally {
      this.loading.set(false);
    }
  }

  async setGoal(minutes: number): Promise<void> {
    try {
      const stored = await this.api.setWeeklyGoal(minutes);
      const d = this.data();
      if (d) this.data.set({ ...d, weekly_goal_minutes: stored });
    } catch (err) {
      this.toast.error(err, this.i18n.t('stats.errors.goal'));
    }
  }
}
