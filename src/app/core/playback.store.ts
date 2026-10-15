import { Injectable, inject, signal } from '@angular/core';
import type { PlaybackProgress } from './models';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/**
 * Reproductor global único. El backend solo reproduce un fichero a la vez; el progreso
 * (`playback-progress`) se aplica únicamente al componente cuyo `file_path` coincide.
 * Para ficheros no activos se guarda un "cursor" local (posición de seek) desde el que
 * arrancará la siguiente reproducción.
 */
@Injectable({ providedIn: 'root' })
export class PlaybackStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);

  /** Último progreso recibido (o estimado de forma optimista). */
  readonly progress = signal<PlaybackProgress | null>(null);
  /** Fichero cargado actualmente en el reproductor del backend. */
  readonly activeFile = signal<string | null>(null);
  /** Posiciones locales por fichero (seek sobre ficheros no activos). */
  readonly cursors = signal<Record<string, number>>({});
  /** Fin de preescucha: se detiene al alcanzar `endMs` en `file`. */
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

  /** Posición actual (ms) del fichero: progreso real si es el activo, si no su cursor local. */
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

  /** Reproduce `file` desde `startMs` (por defecto, su cursor). `endMs` = parar al llegar. */
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
      this.toast.error(err, 'No se pudo reproducir');
    }
  }

  async pause(): Promise<void> {
    try {
      await this.api.pauseMidiPlayback();
      const p = this.progress();
      if (p) this.progress.set({ ...p, is_playing: false });
    } catch (err) {
      this.toast.error(err, 'No se pudo pausar');
    }
  }

  async toggle(file: string, endMs?: number): Promise<void> {
    if (this.isPlaying(file)) await this.pause();
    else await this.play(file, undefined, endMs);
  }

  /** Mueve la posición. Si `file` es el activo, hace seek en el backend; si no, mueve su cursor. */
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
        this.toast.error(err, 'No se pudo posicionar');
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
      this.toast.error(err, 'No se pudo detener');
    }
    if (p) {
      this.progress.set({ ...p, current_ms: 0, is_playing: false });
      this.setCursor(p.file_path, 0);
    }
    if (file) this.setCursor(file, 0);
  }

  /** Detiene la reproducción si el fichero activo es `file` (p. ej. antes de recortarlo). */
  async stopIfActive(file: string | null | undefined): Promise<void> {
    const p = this.progress();
    if (file && p && p.file_path === file && p.is_playing) await this.stop();
  }

  /** Atajo Espacio: pausa/reanuda el último fichero usado. */
  async toggleActive(): Promise<void> {
    const file = this.activeFile() ?? this.progress()?.file_path;
    if (file) await this.toggle(file);
  }
}
