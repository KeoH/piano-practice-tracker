import { Injectable, inject, signal } from '@angular/core';
import { compositionKey } from './composition';
import { I18nService } from './i18n/i18n.service';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/** File name for `title` with `ext`: no path separators or characters other file systems reject. */
export function exportFileName(title: string, ext: string): string {
  const clean = title
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return `${clean || 'piano'}.${ext}`;
}

export function wavFileName(title: string): string {
  return exportFileName(title, 'wav');
}

/** What a composition is exported to. */
export type CompositionExport = 'wav' | 'mid';

/** Exports MIDI files and compositions (save dialog + work in the backend). */
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
    await this.run(file, 'wav', title, (dest) => this.api.exportAudio(file, dest));
  }

  /** Exports a composition as heard (WAV) or as a multitrack MIDI file. */
  async exportComposition(id: string, title: string, kind: CompositionExport): Promise<void> {
    const write = kind === 'wav' ? this.api.exportCompositionAudio.bind(this.api) : this.api.exportCompositionMidi.bind(this.api);
    await this.run(`${compositionKey(id)}.${kind}`, kind, title, (dest) => write(id, dest));
  }

  /** Asks where to save and runs `write`, with `key` busy meanwhile. */
  private async run(key: string, kind: CompositionExport, title: string, write: (dest: string) => Promise<string>): Promise<void> {
    if (this.isBusy(key)) return;
    const wav = kind === 'wav';
    const failed = this.i18n.t(wav ? 'export.errors.failed' : 'export.errors.midiFailed');
    let dest: string | null;
    try {
      dest = wav
        ? await this.api.pickWavSavePath(this.i18n.t('export.pickTitle'), exportFileName(title, 'wav'))
        : await this.api.pickSavePath(this.i18n.t('export.midiPickTitle'), exportFileName(title, 'mid'), { name: 'MIDI', extensions: ['mid'] });
    } catch (err) {
      this.toast.error(err, failed);
      return;
    }
    if (!dest) return;
    this.busy.update((s) => new Set(s).add(key));
    try {
      const written = await write(dest);
      this.toast.success(this.i18n.t(wav ? 'export.done' : 'export.midiDone', { path: written }));
    } catch (err) {
      this.toast.error(err, failed);
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }
}
