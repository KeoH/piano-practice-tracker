import { Injectable, signal } from '@angular/core';
import { errorMessage } from './format';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  show(message: string, kind: ToastKind = 'info', timeoutMs = 4000): void {
    const id = this.nextId++;
    // Avoids identical consecutive duplicates
    const list = this._toasts();
    if (list.length && list[list.length - 1].message === message) return;
    this._toasts.set([...list.slice(-4), { id, kind, message }]);
    if (timeoutMs > 0) setTimeout(() => this.dismiss(id), timeoutMs);
  }

  info(message: string): void {
    this.show(message, 'info');
  }

  success(message: string): void {
    this.show(message, 'success', 2500);
  }

  warning(message: string): void {
    this.show(message, 'warning', 5000);
  }

  error(err: unknown, prefix?: string): void {
    const msg = errorMessage(err);
    this.show(prefix ? `${prefix}: ${msg}` : msg, 'error', 6500);
  }

  dismiss(id: number): void {
    this._toasts.update((l) => l.filter((t) => t.id !== id));
  }
}
