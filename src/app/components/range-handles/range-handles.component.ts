import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { clamp, formatMs } from '../../core/format';
import type { TimeRange, TimelineDrag } from '../../core/timeline-drag';

/**
 * Draggable start/end handles of a range on a timeline. `display: contents`: the handles are
 * positioned against the parent track, which wires its own pointer events to the same `drag`.
 */
@Component({
  selector: 'app-range-handles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @let r = range();
    @for (h of handles; track h) {
      <div
        class="group absolute top-0 bottom-[18px] z-10 -ml-[7px] flex w-[14px] cursor-ew-resize items-center justify-center"
        [style.left.%]="pct(h === 'start' ? r.start : r.end)"
        role="slider"
        tabindex="0"
        [attr.aria-label]="h === 'start' ? startLabel() : endLabel()"
        [attr.aria-valuemin]="h === 'start' ? 0 : r.start"
        [attr.aria-valuemax]="h === 'start' ? r.end : durationMs()"
        [attr.aria-valuenow]="h === 'start' ? r.start : r.end"
        [attr.aria-valuetext]="formatMs(h === 'start' ? r.start : r.end, true)"
        (pointerdown)="drag().handleDown($event, h)"
        (keydown)="drag().handleKey($event, h)"
      >
        <span class="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent"></span>
        <span
          class="relative w-[14px] rounded-[7px] border-2 border-ink-925 bg-accent group-hover:bg-accent-hover group-focus-visible:bg-ivory"
          [style.height.px]="knobHeight()"
        ></span>
      </div>
    }
  `,
})
export class RangeHandlesComponent {
  readonly range = input.required<TimeRange>();
  readonly durationMs = input.required<number>();
  readonly drag = input.required<TimelineDrag>();
  readonly startLabel = input('');
  readonly endLabel = input('');
  readonly knobHeight = input(44);

  protected readonly handles = ['start', 'end'] as const;
  protected readonly formatMs = formatMs;

  protected pct(ms: number): number {
    const d = this.durationMs();
    return d > 0 ? clamp((ms / d) * 100, 0, 100) : 0;
  }
}
