import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { UiPrefsStore } from '../../core/ui-prefs.store';
import { IconComponent } from '../icon/icon.component';

/** Switches every timeline between the piano roll and the density bars. */
@Component({
  selector: 'app-timeline-mode-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe],
  template: `
    @let roll = prefs.timelineMode() === 'roll';
    <button
      type="button"
      class="btn btn-ghost btn-icon h-9 w-9"
      [attr.aria-label]="(roll ? 'timeline.showActivity' : 'timeline.showRoll') | t"
      [title]="(roll ? 'timeline.showActivity' : 'timeline.showRoll') | t"
      (click)="prefs.toggleTimelineMode()"
    >
      <app-icon [name]="roll ? 'bars' : 'roll'" [size]="17" />
    </button>
  `,
})
export class TimelineModeToggleComponent {
  protected readonly prefs = inject(UiPrefsStore);
}
