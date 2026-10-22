import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ComposerViewComponent } from './components/composer-view/composer-view.component';
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { SettingsDialogComponent } from './components/settings-dialog/settings-dialog.component';
import { SessionViewComponent } from './components/session-view/session-view.component';
import { PiecesViewComponent } from './components/pieces-view/pieces-view.component';
import { StatsViewComponent } from './components/stats-view/stats-view.component';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { ToastsComponent } from './components/toasts/toasts.component';
import { VaultWelcomeComponent } from './components/vault-welcome/vault-welcome.component';
import { CompositionStore } from './core/composition.store';
import { ConfirmService } from './core/confirm.service';
import { TranslatePipe } from './core/i18n/translate.pipe';
import { LanguageStore } from './core/language.store';
import { NavStore } from './core/nav.store';
import { PlaybackStore } from './core/playback.store';
import { RecordingStore } from './core/recording.store';
import { SessionStore } from './core/session.store';
import { TauriApiService } from './core/tauri-api.service';
import { VaultStore } from './core/vault.store';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SidebarComponent,
    SessionViewComponent,
    StatsViewComponent,
    PiecesViewComponent,
    ComposerViewComponent,
    SettingsDialogComponent,
    VaultWelcomeComponent,
    ToastsComponent,
    ConfirmDialogComponent,
    TranslatePipe,
  ],
  templateUrl: './app.html',
  host: { '(window:keydown)': 'onGlobalKey($event)' },
})
export class App implements OnInit {
  protected readonly api = inject(TauriApiService);
  protected readonly vault = inject(VaultStore);
  private readonly playback = inject(PlaybackStore);
  private readonly recording = inject(RecordingStore);
  private readonly sessions = inject(SessionStore);
  private readonly compositions = inject(CompositionStore);
  protected readonly nav = inject(NavStore);
  private readonly confirm = inject(ConfirmService);
  private readonly language = inject(LanguageStore);

  protected readonly bannerVisible = signal(!this.api.available);

  ngOnInit(): void {
    // Language first: startup warnings (e.g. from the vault) already come out translated.
    void this.language.init();
    void this.playback.init();
    void this.vault.init();
    void this.recording.refreshPorts();
  }

  /**
   * Global shortcuts (only when focus is not on an editable field):
   * - Space: play/pause of the active player.
   * - Ctrl+Z: undo the last trim of the raw recording, on the "Record & trim" tab.
   * - In the composer, see `composerKey`.
   */
  protected onGlobalKey(ev: KeyboardEvent): void {
    if (ev.metaKey) return;
    if (this.confirm.current() || this.vault.settingsOpen() || !this.vault.isOpen()) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (this.nav.view() === 'compose' && this.composerKey(ev, t)) {
      ev.preventDefault();
      return;
    }
    if (ev.repeat || ev.altKey) return;
    const isUndo = ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === 'z';
    const isSpace = ev.code === 'Space' && !ev.ctrlKey;
    if (!isUndo && !isSpace) return;
    if (isUndo) {
      if (this.nav.view() !== 'sessions' || this.sessions.tab() !== 'record') return;
      if (this.sessions.undoDepth() === 0 || this.recording.isRecording()) return;
      ev.preventDefault();
      void this.sessions.undoTrim();
      return;
    }
    if (t && (t.tagName === 'BUTTON' || t.getAttribute('role') === 'slider')) return;
    if (!this.playback.activeFile() && !this.playback.progress()) return;
    ev.preventDefault();
    void this.playback.toggleActive();
  }

  /**
   * Composer shortcuts; returns whether the key was handled.
   * Space plays/pauses (also with a clip focused), Ctrl+Z / Ctrl+Shift+Z undo and redo, S splits
   * the selected clip at the playhead, Ctrl+D duplicates it, Delete removes it, the arrows move
   * it (Shift: 1 s), Esc deselects it, and Shift+M / Shift+S mute or solo the active track.
   */
  private composerKey(ev: KeyboardEvent, target: HTMLElement | null): boolean {
    const c = this.compositions;
    if (!c.doc()) return false;
    const key = ev.key.toLowerCase();
    const arrow = ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
    if (ev.repeat && !arrow) return false;
    if (ev.ctrlKey && !ev.altKey && (key === 'z' || key === 'y')) {
      if (key === 'y' || ev.shiftKey) c.redo();
      else c.undo();
      return true;
    }
    if (ev.altKey) return false;
    const selected = !!c.selectedClip();
    if (ev.ctrlKey) {
      if (key !== 'd' || !selected) return false;
      c.duplicateSelected();
      return true;
    }
    if (ev.code === 'Space') {
      if (target?.tagName === 'BUTTON' && !target.classList.contains('clip')) return false;
      void c.togglePlay();
      return true;
    }
    if (ev.shiftKey && (key === 'm' || key === 's')) {
      if (key === 'm') c.toggleMute(c.activeTrack());
      else c.toggleSolo(c.activeTrack());
      return true;
    }
    if (!selected) return false;
    if (key === 's') c.splitSelected();
    else if (ev.key === 'Delete' || ev.key === 'Backspace') c.removeSelected();
    else if (arrow) c.nudgeSelected((ev.key === 'ArrowLeft' ? -1 : 1) * (ev.shiftKey ? 1000 : 100));
    else if (ev.key === 'Escape') c.selectClip(null);
    else return false;
    return true;
  }
}
