import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from './i18n/i18n.service';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

/** Diálogo de confirmación propio (window.confirm no es fiable en el webview de Tauri). */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly i18n = inject(I18nService);
  readonly current = signal<ConfirmRequest | null>(null);

  ask(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    // Si hubiese uno abierto, se cancela
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
