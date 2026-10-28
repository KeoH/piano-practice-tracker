import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CHART_COLORS } from '../line-chart/line-chart.component';

const W = 96;
const H = 26;
const P = 4;

/** Tiny trend line of values in 0-1 (accuracy of the last attempts), with the last one marked. */
@Component({
  selector: 'app-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block align-middle' },
  template: `
    @if (values().length) {
      <svg [attr.width]="w" [attr.height]="h" role="img" [attr.aria-label]="label()">
        @if (values().length > 1) {
          <path [attr.d]="path()" fill="none" [attr.stroke]="color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        }
        <circle [attr.cx]="last().x" [attr.cy]="last().y" r="3" [attr.fill]="color" />
      </svg>
    } @else {
      <span class="text-xs text-faint">—</span>
    }
  `,
})
export class SparklineComponent {
  readonly values = input<number[]>([]);
  readonly label = input('');

  protected readonly w = W;
  protected readonly h = H;
  protected readonly color = CHART_COLORS.primary;

  private readonly points = computed(() => {
    const v = this.values();
    return v.map((y, i) => ({
      x: v.length <= 1 ? W / 2 : P + (i / (v.length - 1)) * (W - 2 * P),
      y: P + (1 - Math.min(1, Math.max(0, y))) * (H - 2 * P),
    }));
  });
  protected readonly path = computed(() => this.points().map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(''));
  protected readonly last = computed(() => this.points()[this.points().length - 1] ?? { x: 0, y: 0 });
}
