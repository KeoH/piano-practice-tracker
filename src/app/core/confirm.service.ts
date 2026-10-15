import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from './i18n/i18n.service';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

/** Custom confirmation dialog (window.confirm is not reliable in the Tauri webview). */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly i18n = inject(I18nService);
  readonly current = signal<ConfirmRequest | null>(null);

  ask(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    // If one is already open, it is cancelled
    this.current()?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.current.set({
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel ?? this.i18n.t('common.confirm'),
        danger: opts.danger ?? true,
        resolve,
      });
    });
  }

  answer(ok: boolean): void {
    const req = this.current();
    if (!req) return;
    this.current.set(null);
    req.resolve(ok);
  }
}
