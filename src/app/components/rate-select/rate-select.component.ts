import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { PLAYBACK_RATES, PlaybackStore } from '../../core/playback.store';

/** Playback speed selector (global: it applies to whatever is playing). */
@Component({
  selector: 'app-rate-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  host: { class: 'inline-flex items-center gap-2' },
  template: `
    <label class="text-xs font-semibold text-muted" [class.sr-only]="!showLabel()" [for]="id">{{ 'playback.rate' | t }}</label>
    <select
      [id]="id"
      class="field tabular h-9 w-[84px] py-0 text-[13px]"
      [class.text-accent]="playback.rate() !== 1"
      [title]="'playback.rateHint' | t"
      (change)="playback.setRate(+$any($event.target).value)"
    >
      @for (r of rates; track r) {
        <option [value]="r" [selected]="r === playback.rate()">{{ r * 100 }} %</option>
      }
    </select>
  `,
})
export class RateSelectComponent {
  /** Without the visible label (it stays for screen readers) where space is short. */
  readonly showLabel = input(true);
  protected readonly playback = inject(PlaybackStore);
  protected readonly rates = PLAYBACK_RATES;
  private static nextId = 0;
  protected readonly id = `rate-${RateSelectComponent.nextId++}`;
}
