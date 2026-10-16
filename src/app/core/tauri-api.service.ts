import { Injectable, inject } from '@angular/core';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { errorMessage } from './format';
import { I18nService } from './i18n/i18n.service';
import {
  EVENT_PLAYBACK_PROGRESS,
  type ExtractFragmentReq,
  type FragmentCreatedResponse,
  type LanguageInfo,
  type MidiActivityDto,
  type MidiPortInfo,
  type PlaybackProgress,
  type SessionDetailDto,
  type SessionDto,
  type SessionSummaryDto,
  type SoundfontInfo,
  type TimelineCommentDto,
  type VaultInfo,
  type VaultOpenResult,
} from './models';

/** Error controlado de IPC: `message` siempre es un string legible. */
export class IpcError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/**
 * Fachada tipada sobre los comandos IPC de Tauri.
 * Argumentos en camelCase (convención de Tauri v2), respuestas en snake_case (ver models.ts).
 * Todas las promesas rechazan con `IpcError` (mensaje string).
 */
@Injectable({ providedIn: 'root' })
export class TauriApiService {
  private readonly i18n = inject(I18nService);
  readonly available: boolean = safeIsTauri();

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.available) throw new IpcError(command, this.i18n.t('app.notTauri'));
    try {
      return await invoke<T>(command, args);
    } catch (err) {
      throw new IpcError(command, errorMessage(err));
    }
  }

  /** URL servible por el webview para una ruta absoluta local (asset protocol). */
  fileSrc(absPath: string): string {
    if (!this.available) return absPath;
    try {
      return convertFileSrc(absPath);
    } catch {
      return absPath;
    }
  }

  // ---- Dispositivos MIDI y grabación ----
  listMidiPorts(): Promise<MidiPortInfo[]> {
    return this.call('list_midi_ports');
  }

  startRecording(
    sessionId: string,
    portId: string,
    bpm: number,
    metronomeOn: boolean,
    liveSynthOn: boolean,
  ): Promise<void> {
    return this.call('start_recording', { sessionId, portId, bpm, metronomeOn, liveSynthOn });
  }

  updateLiveRecordingSettings(bpm: number, metronomeOn: boolean, liveSynthOn: boolean): Promise<void> {
    return this.call('update_live_recording_settings', { bpm, metronomeOn, liveSynthOn });
  }

  stopRecording(sessionId: string): Promise<SessionDto> {
    return this.call('stop_recording', { sessionId });
  }

  // ---- Recorte y reproducción ----
  getMidiActivity(filePath: string): Promise<MidiActivityDto> {
    return this.call('get_midi_activity', { filePath });
  }

  extractMidiFragment(req: ExtractFragmentReq): Promise<FragmentCreatedResponse> {
    return this.call('extract_midi_fragment', { req });
  }

  discardMidiRange(sessionId: string, startMs: number, endMs: number): Promise<SessionDto> {
    return this.call('discard_midi_range', {
      sessionId,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
    });
  }

  playMidiFile(filePath: string, startMs: number): Promise<void> {
    return this.call('play_midi_file', { filePath, startMs: Math.max(0, Math.round(startMs)) });
  }

  pauseMidiPlayback(): Promise<void> {
    return this.call('pause_midi_playback');
  }

  seekMidiPlayback(ms: number): Promise<void> {
    return this.call('seek_midi_playback', { ms: Math.max(0, Math.round(ms)) });
  }

  stopMidiPlayback(): Promise<void> {
    return this.call('stop_midi_playback');
  }

  // ---- Sesiones, fragmentos y comentarios ----
  getSessions(): Promise<SessionSummaryDto[]> {
    return this.call('get_sessions');
  }

  getSessionDetail(sessionId: string): Promise<SessionDetailDto> {
    return this.call('get_session_detail', { sessionId });
  }

  createSession(title: string, bpm: number): Promise<SessionDetailDto> {
    return this.call('create_session', { title, bpm });
  }

  updateSession(sessionId: string, title: string, bpm: number, markdownNotes: string): Promise<void> {
    return this.call('update_session', { sessionId, title, bpm, markdownNotes });
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.call('delete_session', { sessionId });
  }

  /** Devuelve la ruta del fichero guardado RELATIVA a la bóveda (`media/…`). `base64Data` sin prefijo `data:`. */
  saveSessionImage(sessionId: string, fileName: string, base64Data: string): Promise<string> {
    return this.call('save_session_image', { sessionId, fileName, base64Data });
  }

  updateFragmentMeta(fragmentId: string, title: string, explanation: string): Promise<void> {
    return this.call('update_fragment_meta', { fragmentId, title, explanation });
  }

  deleteFragment(fragmentId: string): Promise<void> {
    return this.call('delete_fragment', { fragmentId });
  }

  addTimelineComment(fragmentId: string, timestampMs: number, content: string): Promise<TimelineCommentDto> {
    return this.call('add_timeline_comment', {
      fragmentId,
      timestampMs: Math.max(0, Math.round(timestampMs)),
      content,
    });
  }

  deleteTimelineComment(commentId: string): Promise<void> {
    return this.call('delete_timeline_comment', { commentId });
  }

  // ---- Bóveda ----
  getVaultInfo(): Promise<VaultInfo> {
    return this.call('get_vault_info');
  }

  /** Crea una bóveda en `path` (carpeta nueva o vacía) y la abre. */
  createVault(path: string): Promise<VaultInfo> {
    return this.call('create_vault', { path });
  }

  /** Abre una bóveda; con `force` ignora el aviso de que está abierta en otro equipo. */
  openVault(path: string, force = false): Promise<VaultOpenResult> {
    return this.call('open_vault', { path, force });
  }

  /** Crea una bóveda en `path` moviendo a ella los datos de la versión anterior. */
  importLegacyData(path: string): Promise<VaultInfo> {
    return this.call('import_legacy_data', { path });
  }

  closeVault(): Promise<VaultInfo> {
    return this.call('close_vault');
  }

  forgetRecentVault(path: string): Promise<VaultInfo> {
    return this.call('forget_recent_vault', { path });
  }

  /** Abre la carpeta de la bóveda en el gestor de archivos. */
  revealVault(): Promise<void> {
    return this.call('reveal_vault');
  }

  /** Diálogo nativo para elegir una carpeta; devuelve null si se cancela. */
  async pickFolder(title: string): Promise<string | null> {
    if (!this.available) return null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ title, multiple: false, directory: true });
      return typeof picked === 'string' ? picked : null;
    } catch (err) {
      throw new IpcError('dialog.open', errorMessage(err));
    }
  }

  // ---- Idioma ----
  getLanguage(): Promise<LanguageInfo> {
    return this.call('get_language');
  }

  /** `null` vuelve al idioma del sistema. */
  setLanguage(language: string | null): Promise<LanguageInfo> {
    return this.call('set_language', { language });
  }

  // ---- SoundFont ----
  getSoundfontInfo(): Promise<SoundfontInfo> {
    return this.call('get_soundfont_info');
  }

  /** Carga el SoundFont (.sf2) indicado; resuelve cuando ya suena con él. */
  setSoundfont(path: string): Promise<SoundfontInfo> {
    return this.call('set_soundfont', { path });
  }

  /** Diálogo nativo para elegir un fichero .sf2; devuelve null si se cancela. */
  async pickSoundfontFile(): Promise<string | null> {
    if (!this.available) return null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        title: this.i18n.t('settings.sound.pickTitle'),
        multiple: false,
        directory: false,
        filters: [{ name: 'SoundFont 2', extensions: ['sf2', 'SF2'] }],
      });
      return typeof picked === 'string' ? picked : null;
    } catch (err) {
      throw new IpcError('dialog.open', errorMessage(err));
    }
  }

  // ---- Eventos ----
  onPlaybackProgress(cb: (p: PlaybackProgress) => void): Promise<UnlistenFn> {
    return this.listenTo<PlaybackProgress>(EVENT_PLAYBACK_PROGRESS, cb);
  }

  private async listenTo<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
    if (!this.available) return () => undefined;
    try {
      return await listen<T>(event, (e) => cb(e.payload));
    } catch (err) {
      console.warn(`No se pudo suscribir a ${event}:`, err);
      return () => undefined;
    }
  }
}

function safeIsTauri(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}
