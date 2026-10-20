import { Injectable, inject, signal } from '@angular/core';
import { I18nService } from './i18n/i18n.service';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/** File name for `title`: no path separators or characters other file systems reject. */
export function wavFileName(title: string): string {
  const clean = title
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return `${clean || 'piano'}.wav`;
}

/** Exports MIDI files to WAV (save dialog + offline render in the backend). */
@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  /** Files being exported right now. */
  readonly busy = signal<ReadonlySet<string>>(new Set());

  isBusy(file: string | null | undefined): boolean {
    return !!file && this.busy().has(file);
  }

  async exportWav(file: string, title: string): Promise<void> {
    if (this.isBusy(file)) return;
    let dest: string | null;
    try {
      dest = await this.api.pickWavSavePath(this.i18n.t('export.pickTitle'), wavFileName(title));
    } catch (err) {
      this.toast.error(err, this.i18n.t('export.errors.failed'));
      return;
    }
    if (!dest) return;
    this.busy.update((s) => new Set(s).add(file));
    try {
      const written = await this.api.exportAudio(file, dest);
      this.toast.success(this.i18n.t('export.done', { path: written }));
    } catch (err) {
      this.toast.error(err, this.i18n.t('export.errors.failed'));
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(file);
        return next;
      });
    }
  }
}
