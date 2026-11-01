import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { TimelineZoom } from '../../core/timeline-zoom';
import { IconComponent } from '../icon/icon.component';

/** Zoom buttons of a timeline (the zoom itself is a `TimelineZoom`; Ctrl + wheel also works). */
@Component({
  selector: 'app-timeline-zoom-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe],
  host: { class: 'inline-flex items-center', role: 'group' },
  template: `
    @let z = zoom();
    <button
      type="button"
      class="btn btn-ghost btn-icon h-9 w-9"
      [disabled]="!z.canZoomOut()"
      [attr.aria-label]="'timeline.zoomOut' | t"
      [title]="'timeline.zoomOut' | t"
      (click)="z.zoomOut()"
    >
      <app-icon name="zoom-out" [size]="17" />
    </button>
    <button
      type="button"
      class="btn btn-ghost tabular h-9 min-w-10 px-1.5 text-[12.5px] text-muted"
      [disabled]="!z.canZoomOut()"
      [attr.aria-label]="'timeline.zoomFit' | t"
      [title]="'timeline.zoomFit' | t"
      (click)="z.fit()"
    >
      {{ z.zoom() < 10 ? z.zoom().toFixed(1) : z.zoom().toFixed(0) }}×
    </button>
    <button
      type="button"
      class="btn btn-ghost btn-icon h-9 w-9"
      [disabled]="!z.canZoomIn()"
      [attr.aria-label]="'timeline.zoomIn' | t"
      [title]="'timeline.zoomIn' | t"
      (click)="z.zoomIn()"
    >
      <app-icon name="zoom-in" [size]="17" />
    </button>
  `,
})
export class TimelineZoomControlsComponent {
  readonly zoom = input.required<TimelineZoom>();
}
