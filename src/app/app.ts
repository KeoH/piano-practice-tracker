import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { SettingsDialogComponent } from './components/settings-dialog/settings-dialog.component';
import { SessionViewComponent } from './components/session-view/session-view.component';
import { StatsViewComponent } from './components/stats-view/stats-view.component';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { ToastsComponent } from './components/toasts/toasts.component';
import { VaultWelcomeComponent } from './components/vault-welcome/vault-welcome.component';
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
   */
  protected onGlobalKey(ev: KeyboardEvent): void {
    if (ev.repeat || ev.altKey || ev.metaKey) return;
    const isUndo = ev.ctrlKey && !ev.shiftKey && ev.key.toLowerCase() === 'z';
    const isSpace = ev.code === 'Space' && !ev.ctrlKey;
    if (!isUndo && !isSpace) return;
    if (this.confirm.current() || this.vault.settingsOpen() || !this.vault.isOpen()) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
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
}
