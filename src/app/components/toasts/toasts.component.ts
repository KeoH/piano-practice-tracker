import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';

@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div
          class="pointer-events-auto flex items-start gap-3 rounded-xl border bg-ink-800/95 py-2.5 pr-2 pl-3.5 text-sm text-fg shadow-xl shadow-black/50 backdrop-blur"
          [class]="toneClass(t.kind)"
          [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
        >
          <span class="dot mt-[7px] h-2 w-2" [class]="dotClass(t.kind)"></span>
          <p class="flex-1 py-px leading-normal break-words">{{ t.message }}</p>
          <button type="button" class="btn btn-ghost btn-icon h-7 w-7" (click)="toast.dismiss(t.id)" aria-label="Cerrar aviso">
            <app-icon name="close" [size]="14" />
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastsComponent {
  protected readonly toast = inject(ToastService);

  protected toneClass(kind: string): string {
    switch (kind) {
      case 'error':
        return 'border-rec/40';
      case 'warning':
        return 'border-accent/40';
      case 'success':
        return 'border-ok/35';
      default:
        return 'border-line-strong';
    }
  }

  protected dotClass(kind: string): string {
    switch (kind) {
      case 'error':
        return 'bg-rec';
      case 'warning':
        return 'bg-accent';
      case 'success':
        return 'bg-ok';
      default:
        return 'bg-faint';
    }
  }
}
