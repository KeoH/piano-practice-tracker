import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ChallengeStore } from '../../core/challenge.store';
import { TEMPO_MAX, TEMPO_MIN, TEMPO_STEP, suggestedTempo } from '../../core/challenge-stats';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import type { MessageKey } from '../../core/i18n/languages';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { MelodySource } from '../../core/models';
import { NavStore } from '../../core/nav.store';
import { RecordingStore } from '../../core/recording.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { AttemptHistoryComponent } from '../attempt-history/attempt-history.component';
import { AttemptResultComponent } from '../attempt-result/attempt-result.component';
import { IconComponent } from '../icon/icon.component';
import { PianoRollComponent } from '../piano-roll/piano-roll.component';
import { RichTextComponent } from '../rich-text/rich-text.component';

/**
 * Challenges section: the selected melody, the tempo and sound controls, the live piano roll
 * with the ghost of the record, the result of the last attempt and the history.
 */
@Component({
  selector: 'app-challenge-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IconComponent,
    PianoRollComponent,
    AttemptResultComponent,
    AttemptHistoryComponent,
    RichTextComponent,
    TranslatePipe,
    PluralPipe,
  ],
  templateUrl: './challenge-view.component.html',
})
export class ChallengeViewComponent {
  protected readonly store = inject(ChallengeStore);
  protected readonly rec = inject(RecordingStore);
  protected readonly nav = inject(NavStore);
  protected readonly api = inject(TauriApiService);
  private readonly i18n = inject(I18nService);

  protected readonly TEMPO_MIN = TEMPO_MIN;
  protected readonly TEMPO_MAX = TEMPO_MAX;
  protected readonly TEMPO_STEP = TEMPO_STEP;
  protected readonly formatMs = formatMs;
  protected readonly sourceLabel: Record<MelodySource, MessageKey> = {
    fragment: 'challenge.source.fragment',
    import: 'challenge.source.import',
    starter: 'challenge.source.starter',
  };
  protected readonly clock = () => this.store.clock();

  protected readonly editingTitle = signal(false);
  /** Moment highlighted on the roll after clicking a mistake of the result. */
  protected readonly focusMs = signal<number | null>(null);

  /** Beat of the count-in still to go (4, 3, 2, 1), or null once it is over. */
  protected readonly countdown = computed(() => {
    const run = this.store.run();
    const p = this.store.progress();
    if (this.store.phase() !== 'countin' || !run) return null;
    const beatMs = 60_000 / run.bpm;
    const left = p ? -p.elapsed_ms : run.count_in_ms;
    return Math.max(1, Math.ceil(left / beatMs));
  });

  /** Suggested next tempo after the last attempt (also shown before playing again). */
  protected readonly suggestion = computed(() => {
    const last = this.store.attempts()[0];
    if (!last || last.summary.tempo_pct !== this.store.tempoPct()) return null;
    return suggestedTempo(last.summary);
  });

  protected readonly status = computed(() => {
    switch (this.store.phase()) {
      case 'countin':
        return this.i18n.t('challenge.status.countin');
      case 'playing':
        return this.i18n.t('challenge.status.playing');
      case 'result':
        return this.i18n.t('challenge.status.done');
      default:
        return this.i18n.t('challenge.status.ready');
    }
  });

  protected readonly portLabel = computed(() => {
    const p = this.rec.selectedPort();
    return p ? this.rec.portName(p) : this.i18n.t('sidebar.port.none');
  });

  protected onTempoInput(raw: string): void {
    this.store.setTempo(Number(raw));
  }

  protected nudgeTempo(delta: number): void {
    this.store.setTempo(this.store.tempoPct() + delta);
  }

  protected async toggleAttempt(): Promise<void> {
    this.focusMs.set(null);
    if (this.store.isRunning()) await this.store.stop();
    else await this.store.start();
  }

  protected async changeTempoAndRetry(tempo: number): Promise<void> {
    this.store.setTempo(tempo);
    this.focusMs.set(null);
    await this.store.start();
  }

  protected retry(): void {
    this.focusMs.set(null);
    void this.store.start();
  }

  protected commitTitle(el: HTMLInputElement): void {
    this.editingTitle.set(false);
    void this.store.rename(el.value);
  }

  protected signed(v: number): string {
    return v > 0 ? `+${v}` : String(v);
  }

  protected pct(v: number): string {
    return `${Math.round(v * 100)} %`;
  }
}
