import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { bestAttempt } from '../../core/challenge-stats';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { AttemptDto } from '../../core/models';
import { IconComponent } from '../icon/icon.component';

/** Table of the attempts of a melody, newest first; the record of each tempo gets a trophy. */
@Component({
  selector: 'app-attempt-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe],
  template: `
    @if (attempts().length) {
      <div class="overflow-x-auto rounded-xl border border-line">
        <table class="w-full text-left text-[13px]">
          <caption class="sr-only">{{ 'challenge.history.title' | t }}</caption>
          <thead class="bg-ink-850 text-xs text-faint">
            <tr>
              <th scope="col" class="px-3.5 py-2.5 font-medium">{{ 'challenge.history.date' | t }}</th>
              <th scope="col" class="px-3.5 py-2.5 text-right font-medium">{{ 'challenge.history.tempo' | t }}</th>
              <th scope="col" class="px-3.5 py-2.5 text-right font-medium">{{ 'challenge.history.score' | t }}</th>
              <th scope="col" class="px-3.5 py-2.5 text-right font-medium">{{ 'challenge.history.accuracy' | t }}</th>
              <th scope="col" class="px-3.5 py-2.5 text-right font-medium">{{ 'challenge.history.missed' | t }}</th>
              <th scope="col" class="px-3.5 py-2.5 text-right font-medium">{{ 'challenge.history.errors' | t }}</th>
              <th scope="col" class="px-3.5 py-2.5"><span class="sr-only">{{ 'challenge.history.actions' | t }}</span></th>
            </tr>
          </thead>
          <tbody>
            @for (a of attempts(); track a.summary.id) {
              @let s = a.summary;
              <tr class="border-t border-line" [class.text-faint]="!s.completed" [class.bg-ink-750]="a.summary.id === highlightId()">
                <td class="px-3.5 py-2">
                  <span class="flex items-center gap-2">
                    {{ i18n.dateTime(date(s.created_at)) }}
                    @if (records().has(s.id)) {
                      <app-icon name="trophy" [size]="14" class="text-accent" [attr.title]="'challenge.history.record' | t" />
                      <span class="sr-only">{{ 'challenge.history.record' | t }}</span>
                    }
                    @if (!s.completed) {
                      <span class="text-xs">({{ 'challenge.history.incomplete' | t }})</span>
                    }
                  </span>
                </td>
                <td class="tabular px-3.5 py-2 text-right">{{ s.tempo_pct }} %</td>
                <td class="tabular px-3.5 py-2 text-right">{{ s.score }}</td>
                <td class="tabular px-3.5 py-2 text-right">{{ round(s.accuracy * 100) }} %</td>
                <td class="tabular px-3.5 py-2 text-right">{{ s.misses }}</td>
                <td class="tabular px-3.5 py-2 text-right">{{ s.wrong + s.extra }}</td>
                <td class="px-2 py-1 text-right">
                  <button type="button" class="btn btn-ghost btn-icon h-8 w-8 hover:text-rec-soft" (click)="remove.emit(a)" [attr.aria-label]="'challenge.history.delete' | t" [title]="'challenge.history.delete' | t">
                    <app-icon name="trash" [size]="14" />
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <p class="text-[13px] text-muted">{{ 'challenge.history.empty' | t }}</p>
    }
  `,
})
export class AttemptHistoryComponent {
  readonly attempts = input<AttemptDto[]>([]);
  readonly highlightId = input<string | null>(null);
  readonly remove = output<AttemptDto>();

  protected readonly i18n = inject(I18nService);
  protected readonly round = Math.round;

  /** Ids of the best attempt at each tempo. */
  protected readonly records = computed(() => {
    const tempos = new Set(this.attempts().map((a) => a.summary.tempo_pct));
    const ids = new Set<string>();
    for (const t of tempos) {
      const best = bestAttempt(this.attempts(), t);
      if (best) ids.add(best.summary.id);
    }
    return ids;
  });

  protected date(iso: string): Date {
    return new Date(iso);
  }
}
