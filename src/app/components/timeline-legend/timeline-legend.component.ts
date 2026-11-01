import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { beatMs } from '../../core/music';
import { PEDAL_RGB } from '../timeline-canvas/timeline-canvas.component';

/** Key to the piano roll: beat grid, sustain pedal lane and the pedal tails. Hidden when there is nothing to explain. */
@Component({
  selector: 'app-timeline-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  host: { class: 'mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted' },
  template: `
    @if (bpm() > 0) {
      <span>{{ 'timeline.legendGrid' | t: { bpm: bpm(), ms: beat() } }}</span>
    }
    @if (hasPedal()) {
      <span class="inline-flex items-center gap-1.5">
        <span class="h-2.5 w-5 rounded-[2px]" [style.background]="pedalColor"></span>{{ 'timeline.pedal' | t }}
      </span>
      <span>{{ 'timeline.legendTail' | t }}</span>
    }
    <span class="text-faint">{{ (zoomable() ? 'timeline.legendHint' : 'timeline.legendHintNoZoom') | t }}</span>
  `,
})
export class TimelineLegendComponent {
  readonly bpm = input(0);
  readonly hasPedal = input(false);
  /** Whether the timeline it describes can be zoomed. */
  readonly zoomable = input(true);
  protected readonly pedalColor = `rgba(${PEDAL_RGB}, 0.6)`;
  protected readonly beat = computed(() => (this.bpm() > 0 ? Math.round(beatMs(this.bpm())) : 0));
}
