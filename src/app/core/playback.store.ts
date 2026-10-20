import { Injectable, inject, signal } from '@angular/core';
import type { PlaybackProgress } from './models';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';
import { I18nService } from './i18n/i18n.service';

/** A-B loop of one file (there is a single player, so a single loop). */
export interface PlaybackLoop {
  file: string;
  start: number;
  end: number;
}

/** Speeds offered in the UI (1 = original tempo). */
export const PLAYBACK_RATES = [0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;

/**
 * Single global player. The backend only plays one file at a time; progress
 * (`playback-progress`) only applies to the component whose `file_path` matches.
 * For inactive files a local "cursor" (seek position) is kept, from which the next playback
 * will start.
 * The speed is global; the loop belongs to one file and is dropped when another file plays.
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
  /** Playback speed (1 = original tempo). */
  readonly rate = signal(1);
  readonly loop = signal<PlaybackLoop | null>(null);
  /** End of preview: stops when `endMs` is reached in `file`. */
  private stopAt: { file: string; endMs: number } | null = null;
  private unlisten: (() => void) | null = null;

  async init(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await this.api.onPlaybackProgress((p) => this.onProgress(p));
    // The backend keeps its speed if only the webview was reloaded.
    if (this.api.available) void this.api.setPlaybackRate(this.rate()).catch(() => undefined);
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
    let from = Math.max(0, Math.round(startMs ?? this.positionFor(file)));
    const loop = this.loop();
    if (loop && loop.file !== file) this.loop.set(null);
    const activeLoop = loop?.file === file ? loop : null;
    if (activeLoop && (from < activeLoop.start || from >= activeLoop.end)) from = activeLoop.start;
    this.stopAt = endMs !== undefined && !activeLoop ? { file, endMs } : null;
    try {
      await this.api.playMidiFile(file, from);
      // Loading another file drops the backend loop; for the same file it is kept, but resending is harmless.
      if (activeLoop) await this.api.setPlaybackLoop(activeLoop);
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

  loopFor(file: string | null | undefined): PlaybackLoop | null {
    const l = this.loop();
    return file && l && l.file === file ? l : null;
  }

  async setRate(rate: number): Promise<void> {
    const prev = this.rate();
    this.rate.set(rate);
    try {
      this.rate.set(await this.api.setPlaybackRate(rate));
    } catch (err) {
      this.rate.set(prev);
      this.toast.error(err, this.i18n.t('playback.errors.rate'));
    }
  }

  /** Loops `[start, end)` of `file`. If the file is loaded in the backend it applies right away;
   *  otherwise on the next `play`. */
  async setLoop(file: string, start: number, end: number): Promise<void> {
    const loop = { file, start: Math.round(start), end: Math.round(end) };
    this.loop.set(loop);
    if (this.stopAt?.file === file) this.stopAt = null;
    if (this.activeFile() !== file || this.progress()?.file_path !== file) return;
    try {
      await this.api.setPlaybackLoop(loop);
    } catch (err) {
      this.loop.set(null);
      this.toast.error(err, this.i18n.t('playback.errors.loop'));
    }
  }

  async clearLoop(file?: string): Promise<void> {
    const l = this.loop();
    if (!l || (file && l.file !== file)) return;
    this.loop.set(null);
    if (this.activeFile() !== l.file) return;
    try {
      await this.api.setPlaybackLoop(null);
    } catch (err) {
      this.toast.error(err, this.i18n.t('playback.errors.loop'));
    }
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
