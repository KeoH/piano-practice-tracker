import { Injectable, computed, inject, signal } from '@angular/core';
import type { SyncState, SyncStatusDto } from './models';
import { SessionStore } from './session.store';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/** Estado visual de la nube para una entidad. */
export type CloudState = SyncState | 'OFFLINE';

@Injectable({ providedIn: 'root' })
export class SyncStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly sessions = inject(SessionStore);

  readonly status = signal<SyncStatusDto | null>(null);
  readonly settingsOpen = signal(false);
  readonly triggering = signal(false);

  readonly connected = computed(() => !!this.status()?.connected);

  /** Resumen corto para el pie de la barra lateral. */
  readonly summary = computed<{ label: string; tone: 'ok' | 'warn' | 'err' | 'idle' | 'busy' }>(() => {
    const s = this.status();
    if (!this.api.available) return { label: 'Sin backend', tone: 'idle' };
    if (!s) return { label: 'Comprobando…', tone: 'idle' };
    if (!s.has_credentials) return { label: 'Drive sin configurar', tone: 'idle' };
    if (!s.connected) return { label: 'Drive desconectado', tone: 'idle' };
    if (s.is_syncing) return { label: 'Sincronizando…', tone: 'busy' };
    if (s.error_count > 0 || s.last_error) return { label: `Error de sync (${s.error_count})`, tone: 'err' };
    if (!s.online) return { label: `Sin red · ${s.pending_count} pendientes`, tone: 'warn' };
    if (s.pending_count > 0) return { label: `${s.pending_count} pendientes`, tone: 'warn' };
    return { label: 'Sincronizado', tone: 'ok' };
  });

  private unlisten: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    if (this.unlisten || !this.api.available) return;
    this.unlisten = await this.api.onSyncStatus((s) => this.apply(s));
    await this.refresh();
    // Respaldo por si se pierde algún evento
    this.pollTimer = setInterval(() => void this.refresh(true), 30_000);
  }

  cloudState(state: SyncState): CloudState {
    return this.connected() ? state : 'OFFLINE';
  }

  async refresh(silent = false): Promise<void> {
    if (!this.api.available) return;
    try {
      this.apply(await this.api.getSyncStatus());
    } catch (err) {
      if (!silent) this.toast.error(err, 'No se pudo obtener el estado de sincronización');
    }
  }

  async syncNow(): Promise<void> {
    this.triggering.set(true);
    try {
      this.apply(await this.api.triggerSyncNow());
    } catch (err) {
      this.toast.error(err, 'No se pudo sincronizar');
    } finally {
      this.triggering.set(false);
    }
  }

  private apply(s: SyncStatusDto): void {
    const prev = this.status();
    this.status.set(s);
    // Al terminar un ciclo de sincronización, refresca los iconos de nube de la lista
    const finished = prev && prev.is_syncing && !s.is_syncing;
    const countChanged = prev && prev.pending_count !== s.pending_count;
    if (finished || countChanged) void this.sessions.refreshList();
  }
}
