import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ChallengeStore } from '../../core/challenge.store';
import { completedChronological, masteredTempo, noteMissRates, runningMax, trend } from '../../core/challenge-stats';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { MelodySummaryDto } from '../../core/models';
import { NavStore } from '../../core/nav.store';
import { AttemptHistoryComponent } from '../attempt-history/attempt-history.component';
import { IconComponent } from '../icon/icon.component';
import { CHART_COLORS, LineChartComponent, type ChartSeries } from '../line-chart/line-chart.component';
import { PianoRollComponent } from '../piano-roll/piano-roll.component';
import { SparklineComponent } from '../sparkline/sparkline.component';

/** Attempts used for the error map. */
const HEAT_ATTEMPTS = 10;
/** Accuracy change (in 0-1) that counts as a trend. */
const TREND_THRESHOLD = 0.02;

/**
 * Challenge progress, inside the Statistics view. Without a melody selected: a table with the
 * progress of every melody. With one: key figures, accuracy and tempo over the attempts, and the
 * map of the notes that fail most. The selection is the Challenges view's one.
 */
@Component({
  selector: 'app-challenge-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, LineChartComponent, SparklineComponent, PianoRollComponent, AttemptHistoryComponent, TranslatePipe, PluralPipe],
  templateUrl: './challenge-progress.component.html',
})
export class ChallengeProgressComponent {
  protected readonly store = inject(ChallengeStore);
  protected readonly nav = inject(NavStore);
  protected readonly i18n = inject(I18nService);

  protected readonly completed = computed(() => completedChronological(this.store.attempts()));
  protected readonly accuracyTrend = computed(() => trend(this.completed().map((a) => a.summary.accuracy)));
  protected readonly mastered = computed(() => masteredTempo(this.store.attempts()));
  protected readonly best = computed(() => Math.max(0, ...this.completed().map((a) => a.summary.score)));
  protected readonly heat = computed(() => noteMissRates(this.store.notes().length, this.store.attempts(), HEAT_ATTEMPTS));
  protected readonly heatCount = computed(() => Math.min(HEAT_ATTEMPTS, this.completed().length));

  protected readonly labels = computed(() =>
    this.completed().map((a) =>
      this.i18n.t('challengeStats.pointLabel', {
        date: this.i18n.shortDate(a.summary.created_at),
        tempo: a.summary.tempo_pct,
      }),
    ),
  );

  protected readonly accuracySeries = computed<ChartSeries[]>(() => {
    const acc = this.completed().map((a) => a.summary.accuracy);
    return [
      { name: this.i18n.t('challengeStats.series.accuracy'), color: CHART_COLORS.primary, values: acc },
      { name: this.i18n.t('challengeStats.series.bestSoFar'), color: CHART_COLORS.secondary, values: runningMax(acc), step: true, dashed: true },
    ];
  });

  protected readonly tempoSeries = computed<ChartSeries[]>(() => [
    { name: this.i18n.t('challengeStats.series.tempo'), color: CHART_COLORS.primary, values: this.completed().map((a) => a.summary.tempo_pct), step: true },
  ]);

  protected readonly tempoRange = computed(() => {
    const t = this.completed().map((a) => a.summary.tempo_pct);
    const lo = Math.max(0, Math.floor((Math.min(...t, 100) - 10) / 10) * 10);
    const hi = Math.ceil((Math.max(...t, 100) + 10) / 10) * 10;
    const ticks: number[] = [];
    const step = hi - lo > 60 ? 20 : 10;
    for (let v = lo; v <= hi; v += step) ticks.push(v);
    return { lo, hi, ticks };
  });

  protected readonly pctFormat = (v: number) => `${Math.round(v * 100)} %`;
  protected readonly tempoFormat = (v: number) => `${Math.round(v)} %`;

  protected trendOf(values: readonly number[]): number | null {
    return trend(values);
  }

  protected trendIcon(t: number | null): 'arrow-up' | 'arrow-down' | null {
    if (t === null || Math.abs(t) < TREND_THRESHOLD) return null;
    return t > 0 ? 'arrow-up' : 'arrow-down';
  }

  protected trendText(t: number | null): string {
    if (t === null) return '—';
    const points = Math.round(t * 100);
    return points > 0 ? `+${points}` : String(points);
  }

  protected sparkLabel(s: MelodySummaryDto): string {
    const last = s.recent_accuracy[s.recent_accuracy.length - 1];
    return last === undefined ? '' : this.i18n.t('challengeStats.sparkLabel', { accuracy: Math.round(last * 100) });
  }

  protected open(s: MelodySummaryDto): void {
    void this.store.select(s.melody.id);
  }

  protected play(): void {
    this.nav.view.set('challenges');
  }
}
