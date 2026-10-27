import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { attemptMistakes, suggestedTempo, timingTendency, type Mistake } from '../../core/challenge-stats';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import type { MessageKey } from '../../core/i18n/languages';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { AttemptDto, NoteDto } from '../../core/models';
import { noteName, parseNoteNames } from '../../core/music';
import { IconComponent } from '../icon/icon.component';

const MISTAKE_LABEL: Record<Mistake['kind'], MessageKey> = {
  missed: 'challenge.result.kind.missed',
  wrong: 'challenge.result.kind.wrong',
  extra: 'challenge.result.kind.extra',
};

/** Result of an attempt: accuracy, score, comparison with the record and the previous attempt, and its mistakes. */
@Component({
  selector: 'app-attempt-result',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe, PluralPipe],
  template: `
    @let s = attempt().summary;
    <section class="panel flex flex-col gap-5 p-6" [attr.aria-label]="'challenge.result.label' | t">
      <div class="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div class="flex flex-col gap-1">
          <span class="text-[13px] font-semibold text-fg-soft">{{ 'challenge.result.accuracy' | t }}</span>
          <span class="tabular text-5xl leading-none font-medium tracking-tight text-fg-strong">{{ pct(s.accuracy) }}</span>
          <span class="text-[13px] text-muted">{{ 'challenge.result.notesHit' | t: { hits: s.hits, total: notes().length } }}</span>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-[13px] font-semibold text-fg-soft">{{ 'challenge.result.score' | t }}</span>
          <span class="tabular text-5xl leading-none font-medium tracking-tight text-accent">{{ s.score }}</span>
          <span class="text-[13px] text-muted">{{ 'challenge.result.outOf' | t }}</span>
        </div>
        <div class="flex min-w-48 flex-1 flex-col gap-2 pt-1">
          @if (!s.completed) {
            <span class="chip w-fit">{{ 'challenge.result.incomplete' | t }}</span>
          } @else if (newRecord()) {
            <span class="chip w-fit border-accent/40 bg-accent/10 text-accent"><app-icon name="trophy" [size]="15" /> {{ 'challenge.result.newRecord' | t }}</span>
          }
          @if (vsRecord(); as d) {
            <p class="flex items-center gap-1.5 text-sm" [class]="d > 0 ? 'text-ok' : d < 0 ? 'text-rec-soft' : 'text-muted'">
              <app-icon [name]="d >= 0 ? 'arrow-up' : 'arrow-down'" [size]="14" />
              {{ 'challenge.result.vsRecord' | t: { delta: signed(d) } }}
            </p>
          }
          @if (vsPrevious(); as d) {
            <p class="flex items-center gap-1.5 text-sm" [class]="d > 0 ? 'text-ok' : d < 0 ? 'text-rec-soft' : 'text-muted'">
              <app-icon [name]="d >= 0 ? 'arrow-up' : 'arrow-down'" [size]="14" />
              {{ 'challenge.result.vsPrevious' | t: { delta: signed(d) } }}
            </p>
          }
          <p class="text-sm text-muted">{{ tendency() }}</p>
        </div>
      </div>

      <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-5">
        @for (c of counters(); track c.label) {
          <div class="flex flex-col gap-0.5 bg-ink-850 px-4 py-3">
            <dt class="text-xs text-faint">{{ c.label | t }}</dt>
            <dd class="tabular text-lg text-fg">{{ c.value }}</dd>
          </div>
        }
      </dl>

      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-fg">{{ 'challenge.result.mistakes' | tp: mistakes().length }}</h3>
        @if (mistakes().length) {
          <ul class="flex max-h-56 flex-col gap-0.5 overflow-y-auto pr-1">
            @for (m of mistakes(); track $index) {
              <li>
                <button type="button" class="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-ink-750" (click)="focus.emit(m.time_ms)">
                  <span class="tabular w-14 shrink-0 text-faint">{{ time(m.time_ms) }}</span>
                  <span class="dot" [class]="m.kind === 'missed' ? 'bg-rec' : 'bg-rec-soft'"></span>
                  <span class="text-fg-soft">{{ describe(m) }}</span>
                </button>
              </li>
            }
          </ul>
        } @else {
          <p class="text-[13px] text-muted">{{ 'challenge.result.noMistakes' | t }}</p>
        }
      </div>

      <div class="flex flex-wrap gap-2.5">
        <button type="button" class="btn btn-primary btn-lg" (click)="retry.emit()"><app-icon name="refresh" [size]="16" /> {{ 'challenge.result.retry' | t }}</button>
        @if (suggestion(); as sg) {
          <button type="button" class="btn btn-lg" (click)="changeTempo.emit(sg.tempo)">
            <app-icon [name]="sg.direction === 'up' ? 'arrow-up' : 'arrow-down'" [size]="16" />
            {{ (sg.direction === 'up' ? 'challenge.result.tempoUp' : 'challenge.result.tempoDown') | t: { tempo: sg.tempo } }}
          </button>
        }
        <button type="button" class="btn btn-ghost btn-lg" (click)="viewProgress.emit()"><app-icon name="chart" [size]="16" /> {{ 'challenge.result.viewProgress' | t }}</button>
      </div>
    </section>
  `,
})
export class AttemptResultComponent {
  readonly attempt = input.required<AttemptDto>();
  readonly notes = input<NoteDto[]>([]);
  readonly rival = input<AttemptDto | null>(null);
  readonly previous = input<AttemptDto | null>(null);
  readonly newRecord = input(false);
  readonly retry = output<void>();
  readonly changeTempo = output<number>();
  readonly viewProgress = output<void>();
  /** A mistake was clicked: its time in the attempt timeline. */
  readonly focus = output<number>();

  private readonly i18n = inject(I18nService);

  protected readonly mistakes = computed(() => attemptMistakes(this.notes(), this.attempt()));
  protected readonly suggestion = computed(() => suggestedTempo(this.attempt().summary));
  /** Score difference with the record at this tempo (null without one, or if this attempt is the record). */
  protected readonly vsRecord = computed(() => {
    const r = this.rival();
    const s = this.attempt().summary;
    return r && s.completed ? s.score - r.summary.score : null;
  });
  /** Accuracy difference with the previous attempt, in points. */
  protected readonly vsPrevious = computed(() => {
    const p = this.previous();
    return p ? Math.round((this.attempt().summary.accuracy - p.summary.accuracy) * 100) : null;
  });
  protected readonly counters = computed(() => {
    const s = this.attempt().summary;
    return [
      { label: 'challenge.result.perfect' as MessageKey, value: s.perfect },
      { label: 'challenge.result.good' as MessageKey, value: s.hits - s.perfect },
      { label: 'challenge.result.missed' as MessageKey, value: s.misses },
      { label: 'challenge.result.wrong' as MessageKey, value: s.wrong },
      { label: 'challenge.result.extra' as MessageKey, value: s.extra },
    ];
  });
  protected readonly tendency = computed(() => {
    const s = this.attempt().summary;
    if (!s.hits) return '';
    switch (timingTendency(s.mean_offset_ms)) {
      case 'early':
        return this.i18n.t('challenge.result.early', { ms: Math.abs(s.mean_offset_ms) });
      case 'late':
        return this.i18n.t('challenge.result.late', { ms: s.mean_offset_ms });
      default:
        return this.i18n.t('challenge.result.steady', { ms: s.mean_abs_offset_ms });
    }
  });

  protected pct(v: number): string {
    return `${Math.round(v * 100)} %`;
  }

  protected signed(v: number): string {
    return v > 0 ? `+${v}` : String(v);
  }

  protected time(ms: number): string {
    return formatMs(Math.max(0, ms), true);
  }

  protected describe(m: Mistake): string {
    const names = parseNoteNames(this.i18n.t('music.noteNames'));
    const note = noteName(m.key, names);
    if (m.kind === 'wrong' && m.expected_key !== null) {
      return this.i18n.t('challenge.result.wrongInstead', { played: note, expected: noteName(m.expected_key, names) });
    }
    return `${this.i18n.t(MISTAKE_LABEL[m.kind])}: ${note}`;
  }
}
