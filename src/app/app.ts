import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { DriveSettingsComponent } from './components/drive-settings/drive-settings.component';
import { SessionViewComponent } from './components/session-view/session-view.component';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { ToastsComponent } from './components/toasts/toasts.component';
import { ConfirmService } from './core/confirm.service';
import { PlaybackStore } from './core/playback.store';
import { RecordingStore } from './core/recording.store';
import { SessionStore } from './core/session.store';
import { SyncStore } from './core/sync.store';
import { NOT_TAURI_MESSAGE, TauriApiService } from './core/tauri-api.service';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SidebarComponent, SessionViewComponent, DriveSettingsComponent, ToastsComponent, ConfirmDialogComponent],
  templateUrl: './app.html',
  host: { '(window:keydown)': 'onGlobalKey($event)' },
})
export class App implements OnInit {
  protected readonly api = inject(TauriApiService);
  protected readonly sync = inject(SyncStore);
  private readonly sessions = inject(SessionStore);
  private readonly playback = inject(PlaybackStore);
  private readonly recording = inject(RecordingStore);
  private readonly confirm = inject(ConfirmService);

  protected readonly notTauriMessage = NOT_TAURI_MESSAGE;
  protected readonly bannerVisible = signal(!this.api.available);

  ngOnInit(): void {
    void this.playback.init();
    void this.sync.init();
    void this.recording.refreshPorts();
    void this.sessions.refreshList();
  }

  /** Espacio = play/pausa del reproductor activo (si el foco no está en un campo editable). */
  protected onGlobalKey(ev: KeyboardEvent): void {
    if (ev.code !== 'Space' || ev.repeat || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    if (this.confirm.current() || this.sync.settingsOpen()) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) || t.getAttribute('role') === 'slider')) return;
    if (!this.playback.activeFile() && !this.playback.progress()) return;
    ev.preventDefault();
    void this.playback.toggleActive();
  }
}
