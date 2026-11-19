import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import type { PlayedMark } from '../../core/challenge.store';
import { type ScoreMap, attemptTick } from '../../core/challenge-score';
import type { NoteStatus } from '../../core/models';
import { ScoreStaffComponent, type StaffMark } from '../score-staff/score-staff.component';

/**
 * The notation of a challenge made from a score: the staff with the notes coloured as they are played,
 * the played notes that hit nothing as red crosses, and a playhead that follows the attempt (or marks the
 * moment of a mistake chosen in the result). It takes the place of the piano roll for those melodies.
 */
@Component({
  selector: 'app-challenge-staff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScoreStaffComponent],
  host: { class: 'block rounded-xl border border-line bg-ink-925' },
  template: `
    <app-score-staff
      [score]="map().score"
      [noteStates]="states()"
      [marks]="staffMarks()"
      [playheadTick]="tick()"
      [follow]="running()"
    />
  `,
})
export class ChallengeStaffComponent {
  readonly map = input.required<ScoreMap>();
  readonly tempoPct = input(100);
  /** How each note of the score went, by id. */
  readonly states = input<Record<string, NoteStatus | null> | null>(null);
  readonly marks = input<PlayedMark[]>([]);
  readonly running = input(false);
  /** Current time of the attempt timeline (ms), read on every frame while it runs. */
  readonly clock = input<() => number>(() => 0);
  /** Highlighted moment after clicking a mistake of the result (attempt timeline, ms). */
  readonly focusMs = input<number | null>(null);

  private readonly live = signal<number | null>(null);

  protected readonly tick = computed(() => {
    if (this.running()) return this.live();
    const focus = this.focusMs();
    return focus === null ? null : attemptTick(this.map(), focus, this.tempoPct());
  });

  protected readonly staffMarks = computed<StaffMark[]>(() => {
    const map = this.map();
    const tempo = this.tempoPct();
    return this.marks().map((m) => ({ tick: attemptTick(map, m.time_ms, tempo), key: m.key }));
  });

  constructor() {
    // While the attempt runs the playhead follows the clock on every animation frame (the count-in waits on the first note).
    effect((onCleanup) => {
      if (!this.running()) {
        this.live.set(null);
        return;
      }
      const map = this.map();
      const tempo = this.tempoPct();
      const clock = this.clock();
      let frame = 0;
      const loop = () => {
        this.live.set(attemptTick(map, clock(), tempo));
        frame = requestAnimationFrame(loop);
      };
      loop();
      onCleanup(() => cancelAnimationFrame(frame));
    });
  }
}
