import { Injectable, inject } from '@angular/core';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { errorMessage } from './format';
import { I18nService } from './i18n/i18n.service';
import {
  EVENT_PLAYBACK_PROGRESS,
  type AppInfo,
  type AppLink,
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
  type UndoTrimResult,
  type VaultInfo,
  type VaultOpenResult,
} from './models';

/** Handled IPC error: `message` is always a readable string. */
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
 * Typed facade over the Tauri IPC commands.
 * Arguments in camelCase (Tauri v2 convention), responses in snake_case (see models.ts).
 * Every promise rejects with `IpcError` (string message).
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

  /** Webview-servable URL for a local absolute path (asset protocol). */
  fileSrc(absPath: string): string {
    if (!this.available) return absPath;
    try {
      return convertFileSrc(absPath);
    } catch {
      return absPath;
    }
  }

  // ---- MIDI devices and recording ----
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

  // ---- Slicing and playback ----
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

  /** Restores the raw take as it was before its last trim. */
  undoRawTrim(sessionId: string): Promise<UndoTrimResult> {
    return this.call('undo_raw_trim', { sessionId });
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

  // ---- Sessions, fragments and comments ----
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

  /** Returns the saved file's path RELATIVE to the vault (`media/…`). `base64Data` without the `data:` prefix. */
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

  // ---- Vault ----
  getVaultInfo(): Promise<VaultInfo> {
    return this.call('get_vault_info');
  }

  /** Creates a vault in `path` (a new or empty folder) and opens it. */
  createVault(path: string): Promise<VaultInfo> {
    return this.call('create_vault', { path });
  }

  /** Opens a vault; with `force` it ignores the warning that it is open on another computer. */
  openVault(path: string, force = false): Promise<VaultOpenResult> {
    return this.call('open_vault', { path, force });
  }

  /** Creates a vault in `path`, moving the previous version's data into it. */
  importLegacyData(path: string): Promise<VaultInfo> {
    return this.call('import_legacy_data', { path });
  }

  closeVault(): Promise<VaultInfo> {
    return this.call('close_vault');
  }

  forgetRecentVault(path: string): Promise<VaultInfo> {
    return this.call('forget_recent_vault', { path });
  }

  /** Opens the vault folder in the file manager. */
  revealVault(): Promise<void> {
    return this.call('reveal_vault');
  }

  /** Native dialog to choose a folder; returns null if cancelled. */
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

  // ---- Language ----
  getLanguage(): Promise<LanguageInfo> {
    return this.call('get_language');
  }

  /** `null` goes back to the system language. */
  setLanguage(language: string | null): Promise<LanguageInfo> {
    return this.call('set_language', { language });
  }

  // ---- About ----
  getAppInfo(): Promise<AppInfo> {
    return this.call('get_app_info');
  }

  /** Opens the website, the repository or the license in the browser. */
  openAppLink(target: AppLink): Promise<void> {
    return this.call('open_app_link', { target });
  }

  // ---- SoundFont ----
  getSoundfontInfo(): Promise<SoundfontInfo> {
    return this.call('get_soundfont_info');
  }

  /** Loads the given SoundFont (.sf2); resolves once it is playing with it. */
  setSoundfont(path: string): Promise<SoundfontInfo> {
    return this.call('set_soundfont', { path });
  }

  /** Native dialog to choose an .sf2 file; returns null if cancelled. */
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

  // ---- Events ----
  onPlaybackProgress(cb: (p: PlaybackProgress) => void): Promise<UnlistenFn> {
    return this.listenTo<PlaybackProgress>(EVENT_PLAYBACK_PROGRESS, cb);
  }

  private async listenTo<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
    if (!this.available) return () => undefined;
    try {
      return await listen<T>(event, (e) => cb(e.payload));
    } catch (err) {
      console.warn(`Could not subscribe to ${event}:`, err);
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
