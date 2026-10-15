import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { ConfirmService } from '../../core/confirm.service';

@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (confirm.current(); as req) {
      <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" (click)="confirm.answer(false)">
        <div
          class="w-full max-w-md rounded-2xl border border-line-strong bg-ink-800 p-6 shadow-2xl shadow-black/60"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-msg"
          (click)="$event.stopPropagation()"
          (keydown.escape)="confirm.answer(false)"
        >
          <h2 id="confirm-title" class="text-lg font-semibold text-fg-strong">{{ req.title }}</h2>
          <p id="confirm-msg" class="mt-2 text-sm leading-relaxed whitespace-pre-line text-muted">{{ req.message }}</p>
          <div class="mt-6 flex justify-end gap-2.5">
            <button type="button" class="btn btn-lg" (click)="confirm.answer(false)">Cancelar</button>
            <button #ok type="button" class="btn btn-lg" [class.btn-danger]="req.danger" [class.btn-primary]="!req.danger" (click)="confirm.answer(true)">
              {{ req.confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmDialogComponent {
  protected readonly confirm = inject(ConfirmService);
  private readonly ok = viewChild<ElementRef<HTMLButtonElement>>('ok');

  constructor() {
    effect(() => {
      const btn = this.ok();
      if (btn) queueMicrotask(() => btn.nativeElement.focus());
    });
  }
}
