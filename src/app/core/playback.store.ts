import { Injectable, inject, signal } from '@angular/core';
import type { PlaybackProgress } from './models';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';
import { I18nService } from './i18n/i18n.service';

/**
 * Single global player. The backend only plays one file at a time; progress
 * (`playback-progress`) only applies to the component whose `file_path` matches.
 * For inactive files a local "cursor" (seek position) is kept, from which the next playback
 * will start.
 */
@Injectable({ providedIn: 'root' })
export class PlaybackStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  /** Last progress received (or optimistically estimated). */
  readonly progress = signal<PlaybackProgress | null>(null);
  /** File currently loaded in the backend player. */
  readonly activeFile = signal<string | null>(null);
  /** Local positions per file (seek on inactive files). */
  readonly cursors = signal<Record<string, number>>({});
  /** End of preview: stops when `endMs` is reached in `file`. */
  private stopAt: { file: string; endMs: number } | null = null;
  private unlisten: (() => void) | null = null;

  async init(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await this.api.onPlaybackProgress((p) => this.onProgress(p));
  }

  private onProgress(p: PlaybackProgress): void {
    this.progress.set(p);
    if (p.is_playing) this.activeFile.set(p.file_path);
    this.setCursor(p.file_path, p.current_ms);
    const s = this.stopAt;
    if (s && s.file === p.file_path && p.is_playing && p.current_ms >= s.endMs) {
      this.stopAt = null;
      void this.pause().then(() => this.setCursor(p.file_path, s.endMs));
    }
  }

  private setCursor(file: string, ms: number): void {
    const cur = this.cursors();
    if (cur[file] === ms) return;
    this.cursors.set({ ...cur, [file]: ms });
  }

  /** Current position (ms) of the file: real progress if it is the active one, otherwise its local cursor. */
  positionFor(file: string | null | undefined): number {
    if (!file) return 0;
    const p = this.progress();
    if (p && p.file_path === file) return p.current_ms;
    return this.cursors()[file] ?? 0;
  }

  isPlaying(file: string | null | undefined): boolean {
    const p = this.progress();
    return !!file && !!p && p.file_path === file && p.is_playing;
  }

  /** Plays `file` from `startMs` (its cursor by default). `endMs` = stop when it is reached. */
  async play(file: string, startMs?: number, endMs?: number): Promise<void> {
    const from = Math.max(0, Math.round(startMs ?? this.positionFor(file)));
    this.stopAt = endMs !== undefined ? { file, endMs } : null;
    try {
      await this.api.playMidiFile(file, from);
      this.activeFile.set(file);
      const prev = this.progress();
      this.progress.set({
        file_path: file,
        current_ms: from,
        duration_ms: prev && prev.file_path === file ? prev.duration_ms : 0,
        is_playing: true,
      });
    } catch (err) {
      this.stopAt = null;
      this.toast.error(err, this.i18n.t('playback.errors.play'));
    }
  }

  async pause(): Promise<void> {
    try {
      await this.api.pauseMidiPlayback();
      const p = this.progress();
      if (p) this.progress.set({ ...p, is_playing: false });
    } catch (err) {
      this.toast.error(err, this.i18n.t('playback.errors.pause'));
    }
  }

  async toggle(file: string, endMs?: number): Promise<void> {
    if (this.isPlaying(file)) await this.pause();
    else await this.play(file, undefined, endMs);
  }

  /** Moves the position. If `file` is the active one, seeks in the backend; otherwise moves its cursor. */
  async seek(file: string, ms: number): Promise<void> {
    const target = Math.max(0, Math.round(ms));
    const p = this.progress();
    this.setCursor(file, target);
    if (p && p.file_path === file && this.activeFile() === file) {
      this.progress.set({ ...p, current_ms: target });
      if (this.stopAt && target >= this.stopAt.endMs) this.stopAt = null;
      try {
        await this.api.seekMidiPlayback(target);
      } catch (err) {
        this.toast.error(err, this.i18n.t('playback.errors.seek'));
      }
    }
  }

  async stop(file?: string): Promise<void> {
    const p = this.progress();
    if (file && p && p.file_path !== file) {
      this.setCursor(file, 0);
      return;
    }
    this.stopAt = null;
    try {
      await this.api.stopMidiPlayback();
    } catch (err) {
      this.toast.error(err, this.i18n.t('playback.errors.stop'));
    }
    if (p) {
      this.progress.set({ ...p, current_ms: 0, is_playing: false });
      this.setCursor(p.file_path, 0);
    }
    if (file) this.setCursor(file, 0);
  }

  /** Stops playback if the active file is `file` (e.g. before slicing it). */
  async stopIfActive(file: string | null | undefined): Promise<void> {
    const p = this.progress();
    if (file && p && p.file_path === file && p.is_playing) await this.stop();
  }

  /** Space shortcut: pauses/resumes the last file used. */
  async toggleActive(): Promise<void> {
    const file = this.activeFile() ?? this.progress()?.file_path;
    if (file) await this.toggle(file);
  }
}
