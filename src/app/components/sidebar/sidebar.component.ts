import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { dateGroupLabel, formatMs, formatRelative, formatShortDate, plural } from '../../core/format';
import type { SessionSummaryDto } from '../../core/models';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { SyncStore, type CloudState } from '../../core/sync.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';

@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex h-full w-[280px] shrink-0 flex-col border-r border-line bg-ink-950' },
  templateUrl: './sidebar.component.html',
})
export class SidebarComponent {
  protected readonly store = inject(SessionStore);
  protected readonly rec = inject(RecordingStore);
  protected readonly sync = inject(SyncStore);
  protected readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);

  protected readonly formatMs = formatMs;
  protected readonly formatShortDate = formatShortDate;
  protected readonly formatRelative = formatRelative;
  protected readonly plural = plural;

  protected readonly totalCount = computed(() => this.store.sessions().length);

  /** Sesiones agrupadas por semana / mes, respetando el orden de la lista. */
  protected readonly groups = computed(() => {
    const now = new Date();
    const groups: { label: string; items: SessionSummaryDto[] }[] = [];
    for (const s of this.store.filteredSessions()) {
      const label = dateGroupLabel(s.session_date || s.updated_at, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(s);
      else groups.push({ label, items: [s] });
    }
    return groups;
  });

  /** Estado del teclado elegido para el pie de la barra lateral. */
  protected readonly port = computed(() => {
    const p = this.rec.selectedPort();
    if (!p) {
      return this.rec.ports().length
        ? { name: 'Teclado no encontrado', detail: 'Elige otra entrada al grabar', ok: false }
        : { name: 'Sin entrada MIDI', detail: 'Conecta un teclado USB', ok: false };
    }
    if (p.is_virtual) return { name: p.name, detail: 'Notas de prueba, sin teclado', ok: false };
    return { name: p.name, detail: 'Teclado conectado', ok: true };
  });

  protected select(s: SessionSummaryDto): void {
    if (this.rec.isRecording() && this.rec.recordingSessionId() !== s.id) {
      this.toast.warning('Detén la grabación antes de cambiar de sesión');
      return;
    }
    void this.store.select(s.id);
  }

  protected newSession(): void {
    if (this.rec.isRecording()) {
      this.toast.warning('Detén la grabación antes de crear otra sesión');
      return;
    }
    void this.store.create();
  }

  protected cloud(s: SessionSummaryDto): CloudState {
    return this.sync.cloudState(s.sync_status);
  }

  protected toneDot(tone: string): string {
    switch (tone) {
      case 'ok':
        return 'bg-ok';
      case 'warn':
        return 'bg-accent';
      case 'err':
        return 'bg-rec';
      case 'busy':
        return 'bg-accent animate-pulse';
      default:
        return 'bg-faint';
    }
  }
}
