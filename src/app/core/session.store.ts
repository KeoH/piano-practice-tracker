import { Injectable, computed, inject, signal } from '@angular/core';
import type { FragmentDto, SessionDetailDto, SessionDto, SessionSummaryDto } from './models';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';
import { I18nService } from './i18n/i18n.service';

/** Pestañas de la vista de sesión. */
export type SessionTab = 'record' | 'fragments' | 'notes';

export interface SessionFieldsPatch {
  title?: string;
  bpm?: number;
  markdown_notes?: string;
}

/** Estado de sesiones: lista lateral, sesión seleccionada y su detalle. */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  readonly sessions = signal<SessionSummaryDto[]>([]);
  readonly listLoading = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly detail = signal<SessionDetailDto | null>(null);
  readonly detailLoading = signal(false);
  readonly filter = signal('');
  /** Número de guardados `update_session` en curso. */
  readonly savingCount = signal(0);
  /** Pestaña visible de la sesión (se conserva al cambiar de sesión). */
  readonly tab = signal<SessionTab>('record');

  readonly session = computed<SessionDto | null>(() => this.detail()?.session ?? null);
  readonly fragments = computed<FragmentDto[]>(() =>
    [...(this.detail()?.fragments ?? [])].sort(
      (a, b) => a.order_index - b.order_index || a.created_at.localeCompare(b.created_at),
    ),
  );

  readonly filteredSessions = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const sorted = [...this.sessions()].sort((a, b) =>
      (b.session_date || b.updated_at).localeCompare(a.session_date || a.updated_at),
    );
    return q ? sorted.filter((s) => s.title.toLowerCase().includes(q)) : sorted;
  });

  /** Cadena de guardados para serializar `update_session` y evitar escrituras fuera de orden. */
  private saveChain: Promise<unknown> = Promise.resolve();
  private detailRequest = 0;

  /** Vacía lista y selección (al cambiar de bóveda). */
  reset(): void {
    this.detailRequest++;
    this.sessions.set([]);
    this.selectedId.set(null);
    this.detail.set(null);
    this.detailLoading.set(false);
  }

  async refreshList(): Promise<void> {
    if (!this.api.available) return;
    this.listLoading.set(true);
    try {
      this.sessions.set(await this.api.getSessions());
    } catch (err) {
      this.toast.error(err, this.i18n.t('session.errors.loadList'));
    } finally {
      this.listLoading.set(false);
    }
  }

  async select(id: string | null): Promise<void> {
    if (id === this.selectedId() && this.detail()) return;
    this.selectedId.set(id);
    this.detail.set(null);
    if (id) await this.reloadDetail();
  }

  async reloadDetail(): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    const req = ++this.detailRequest;
    this.detailLoading.set(true);
    try {
      const d = await this.api.getSessionDetail(id);
      if (req === this.detailRequest && this.selectedId() === id) this.detail.set(d);
    } catch (err) {
      this.toast.error(err, this.i18n.t('session.errors.load'));
    } finally {
      if (req === this.detailRequest) this.detailLoading.set(false);
    }
  }

  async create(): Promise<void> {
    const now = new Date();
    const title = this.i18n.t('session.defaultTitle', { date: this.i18n.dateTime(now) });
    try {
      const d = await this.api.createSession(title, 120);
      this.detailRequest++;
      this.selectedId.set(d.session.id);
      this.detail.set(d);
      this.detailLoading.set(false);
      this.tab.set('record');
      await this.refreshList();
      this.toast.success(this.i18n.t('session.created'));
    } catch (err) {
      this.toast.error(err, this.i18n.t('session.errors.create'));
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.api.deleteSession(id);
      if (this.selectedId() === id) {
        this.selectedId.set(null);
        this.detail.set(null);
      }
      this.sessions.update((l) => l.filter((s) => s.id !== id));
      void this.refreshList();
      this.toast.success(this.i18n.t('session.deleted'));
      return true;
    } catch (err) {
      this.toast.error(err, this.i18n.t('session.errors.delete'));
      return false;
    }
  }

  /**
   * Aplica cambios a título/BPM/notas de la sesión seleccionada (optimista) y persiste con
   * `update_session` enviando siempre los tres campos actuales.
   */
  saveFields(patch: SessionFieldsPatch): Promise<boolean> {
    const d = this.detail();
    if (!d) return Promise.resolve(false);
    const sessionId = d.session.id;
    const updated: SessionDto = { ...d.session, ...patch };
    this.detail.set({ ...d, session: updated });
    this.sessions.update((l) =>
      l.map((s) =>
        s.id === sessionId ? { ...s, title: updated.title, bpm: updated.bpm } : s,
      ),
    );
    this.savingCount.update((n) => n + 1);
    const run = async (): Promise<boolean> => {
      // Usa los valores más recientes en el momento de ejecutar (por si llegaron más cambios).
      const live = this.detail();
      const cur = live && live.session.id === sessionId ? live.session : updated;
      try {
        await this.api.updateSession(sessionId, cur.title, cur.bpm, cur.markdown_notes);
        return true;
      } catch (err) {
        this.toast.error(err, this.i18n.t('session.errors.save'));
        return false;
      } finally {
        this.savingCount.update((n) => n - 1);
      }
    };
    const p = this.saveChain.then(run, run);
    this.saveChain = p;
    return p;
  }

  /** Sustituye el SessionDto devuelto por el backend (tras grabar/recortar). */
  applySession(s: SessionDto): void {
    const d = this.detail();
    if (d && d.session.id === s.id) this.detail.set({ ...d, session: s });
  }

  patchFragment(fragmentId: string, fn: (f: FragmentDto) => FragmentDto): void {
    const d = this.detail();
    if (!d) return;
    this.detail.set({ ...d, fragments: d.fragments.map((f) => (f.id === fragmentId ? fn(f) : f)) });
  }

  removeFragmentLocal(fragmentId: string): void {
    const d = this.detail();
    if (!d) return;
    this.detail.set({ ...d, fragments: d.fragments.filter((f) => f.id !== fragmentId) });
    const sid = d.session.id;
    this.sessions.update((l) =>
      l.map((s) => (s.id === sid ? { ...s, fragment_count: Math.max(0, s.fragment_count - 1) } : s)),
    );
  }
}
