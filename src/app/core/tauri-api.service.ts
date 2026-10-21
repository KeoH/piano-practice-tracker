import { Injectable, inject } from '@angular/core';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { errorMessage } from './format';
import { I18nService } from './i18n/i18n.service';
import {
  EVENT_PLAYBACK_PROGRESS,
  type AppInfo,
  type AppLink,
  type CompositionDto,
  type CompositionSummaryDto,
  type ExtractFragmentReq,
  type FragmentCreatedResponse,
  type FragmentDto,
  type LanguageInfo,
  type LibraryFragmentDto,
  type MidiActivityDto,
  type MidiNotesDto,
  type MidiPortInfo,
  type PieceDetailDto,
  type PieceDto,
  type PieceSummaryDto,
  type PlaybackProgress,
  type PracticeStatsDto,
  type SessionDetailDto,
  type SessionDto,
  type SessionSummaryDto,
  type SoundfontInfo,
  type TimeRangeDto,
  type TimelineCommentDto,
  type TrackMixDto,
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

  getMidiNotes(filePath: string): Promise<MidiNotesDto> {
    return this.call('get_midi_notes', { filePath });
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

  /** Discards several ranges of the raw take at once (one undo step). */
  discardMidiRanges(sessionId: string, ranges: TimeRangeDto[]): Promise<SessionDto> {
    const rounded = ranges.map((r) => ({ start_ms: Math.round(r.start_ms), end_ms: Math.round(r.end_ms) }));
    return this.call('discard_midi_ranges', { sessionId, ranges: rounded });
  }

  /** Passages of the take separated by at least `minGapMs` of silence. */
  suggestMidiSegments(filePath: string, minGapMs: number): Promise<TimeRangeDto[]> {
    return this.call('suggest_midi_segments', { filePath, minGapMs: Math.round(minGapMs) });
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

  /** Playback speed (1 = original tempo); resolves with the speed applied. */
  setPlaybackRate(rate: number): Promise<number> {
    return this.call('set_playback_rate', { rate });
  }

  /** A-B loop of the loaded file; `null` removes it. */
  setPlaybackLoop(range: { start: number; end: number } | null): Promise<void> {
    return this.call('set_playback_loop', {
      startMs: range ? Math.max(0, Math.round(range.start)) : null,
      endMs: range ? Math.max(0, Math.round(range.end)) : null,
    });
  }

  // ---- Repertoire ----
  getPieces(): Promise<PieceSummaryDto[]> {
    return this.call('get_pieces');
  }

  getPieceDetail(pieceId: string): Promise<PieceDetailDto> {
    return this.call('get_piece_detail', { pieceId });
  }

  createPiece(title: string, composer: string): Promise<PieceDto> {
    return this.call('create_piece', { title, composer });
  }

  updatePiece(pieceId: string, title: string, composer: string, notes: string, archived: boolean): Promise<PieceDto> {
    return this.call('update_piece', { pieceId, title, composer, notes, archived });
  }

  deletePiece(pieceId: string): Promise<void> {
    return this.call('delete_piece', { pieceId });
  }

  /** Files a fragment under a piece and passage (`null` takes it out of its piece). */
  assignFragmentPiece(fragmentId: string, pieceId: string | null, passage: string): Promise<FragmentDto> {
    return this.call('assign_fragment_piece', { fragmentId, pieceId, passage });
  }

  // ---- Compositions ----
  getCompositions(): Promise<CompositionSummaryDto[]> {
    return this.call('get_compositions');
  }

  /** New composition with one empty piano track (an empty title gets the default one). */
  createComposition(title: string): Promise<CompositionDto> {
    return this.call('create_composition', { title });
  }

  getComposition(compositionId: string): Promise<CompositionDto> {
    return this.call('get_composition', { compositionId });
  }

  /** Saves the whole document and resolves with it as stored (new tracks and clips get their ids). */
  saveComposition(composition: CompositionDto): Promise<CompositionDto> {
    return this.call('save_composition', { composition });
  }

  deleteComposition(compositionId: string): Promise<void> {
    return this.call('delete_composition', { compositionId });
  }

  getLibraryFragments(): Promise<LibraryFragmentDto[]> {
    return this.call('get_library_fragments');
  }

  /** Compositions that would lose clips if these fragments (or the session's) were deleted. */
  countCompositionUses(fragmentIds: string[], sessionId: string | null = null): Promise<number> {
    return this.call('count_composition_uses', { fragmentIds, sessionId });
  }

  /** Plays the composition from `startMs`; progress reports it as `composition:<id>`. */
  playComposition(compositionId: string, startMs: number): Promise<void> {
    return this.call('play_composition', { compositionId, startMs: Math.max(0, Math.round(startMs)) });
  }

  /** Applies the mixer live (track order) if the composition is the one loaded in the player. */
  setCompositionMix(compositionId: string, mix: TrackMixDto[]): Promise<void> {
    return this.call('set_composition_mix', { compositionId, mix });
  }

  // ---- Practice statistics ----
  getPracticeStats(from: string, to: string): Promise<PracticeStatsDto> {
    return this.call('get_practice_stats', { from, to });
  }

  /** Weekly goal in minutes (0 = none); resolves with the value stored. */
  setWeeklyGoal(minutes: number): Promise<number> {
    return this.call('set_weekly_goal', { minutes: Math.max(0, Math.round(minutes)) });
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

  /** Renders a `.mid` file to WAV with the current SoundFont; resolves with the path written. */
  exportAudio(filePath: string, destPath: string): Promise<string> {
    return this.call('export_audio', { filePath, destPath });
  }

  /** Native "save as" dialog for a WAV file; returns null if cancelled. */
  async pickWavSavePath(title: string, defaultName: string): Promise<string | null> {
    if (!this.available) return null;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const picked = await save({ title, defaultPath: defaultName, filters: [{ name: 'WAV', extensions: ['wav'] }] });
      return typeof picked === 'string' ? picked : null;
    } catch (err) {
      throw new IpcError('dialog.save', errorMessage(err));
    }
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
