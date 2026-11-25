import { Injectable, inject, signal } from '@angular/core';
import { compositionKey } from './composition';
import { I18nService } from './i18n/i18n.service';
import type { MessageKey } from './i18n/languages';
import type { ScoreDto } from './models';
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

type ExportKind = CompositionExport | 'pdf';

/** The texts of each kind of export: the dialog title, the success toast and the error toast. */
const MESSAGES = {
  wav: { pick: 'export.pickTitle', done: 'export.done', failed: 'export.errors.failed' },
  mid: { pick: 'export.midiPickTitle', done: 'export.midiDone', failed: 'export.errors.midiFailed' },
  pdf: { pick: 'export.pdfPickTitle', done: 'export.pdfDone', failed: 'export.errors.pdfFailed' },
} as const satisfies Record<ExportKind, { pick: MessageKey; done: MessageKey; failed: MessageKey }>;

/** Base64 of some bytes, in chunks so a big file does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Key under which the PDF export of a score is marked busy. */
export function scorePdfKey(id: string): string {
  return `score:${id}.pdf`;
}

/** Exports MIDI files, compositions and scores (save dialog + work in the backend). */
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

  /** Exports a score as a PDF that looks like printed sheet music. The PDF is drawn here, the backend only writes it. */
  async exportScore(score: ScoreDto): Promise<void> {
    await this.run(scorePdfKey(score.id), 'pdf', score.title, async (dest) => {
      const { buildScorePdf } = await import('./score-pdf');
      const bytes = await buildScorePdf(score, {
        page: (n, total) => this.i18n.t('pdf.page', { n, total }),
        untitled: this.i18n.t('pdf.untitled'),
      });
      return this.api.exportScorePdf(dest, bytesToBase64(bytes));
    });
  }

  /** Asks where to save and runs `write`, with `key` busy meanwhile. */
  private async run(key: string, kind: ExportKind, title: string, write: (dest: string) => Promise<string>): Promise<void> {
    if (this.isBusy(key)) return;
    const text = MESSAGES[kind];
    const failed = this.i18n.t(text.failed);
    let dest: string | null;
    try {
      const pick = this.i18n.t(text.pick);
      dest =
        kind === 'wav'
          ? await this.api.pickWavSavePath(pick, exportFileName(title, 'wav'))
          : kind === 'mid'
            ? await this.api.pickSavePath(pick, exportFileName(title, 'mid'), { name: 'MIDI', extensions: ['mid'] })
            : await this.api.pickSavePath(pick, exportFileName(title, 'pdf'), { name: 'PDF', extensions: ['pdf'] });
    } catch (err) {
      this.toast.error(err, failed);
      return;
    }
    if (!dest) return;
    this.busy.update((s) => new Set(s).add(key));
    try {
      const written = await write(dest);
      this.toast.success(this.i18n.t(text.done, { path: written }));
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
