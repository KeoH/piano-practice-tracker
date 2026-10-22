import { Injectable, computed, inject, signal } from '@angular/core';
import { I18nService } from './i18n/i18n.service';
import type { FragmentDto, PieceDetailDto, PieceDto, PieceSummaryDto } from './models';
import { SessionStore } from './session.store';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

export interface PieceFieldsPatch {
  title?: string;
  composer?: string;
  notes?: string;
  archived?: boolean;
}

/** Repertoire: list of pieces, selected piece and its takes (fragments from any session). */
@Injectable({ providedIn: 'root' })
export class PieceStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly sessions = inject(SessionStore);

  readonly pieces = signal<PieceSummaryDto[]>([]);
  readonly listLoading = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly detail = signal<PieceDetailDto | null>(null);
  readonly detailLoading = signal(false);
  readonly filter = signal('');
  private detailRequest = 0;

  readonly filteredPieces = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.pieces();
    return q
      ? list.filter((p) => p.piece.title.toLowerCase().includes(q) || p.piece.composer.toLowerCase().includes(q))
      : list;
  });

  byId(id: string | null | undefined): PieceSummaryDto | undefined {
    return id ? this.pieces().find((p) => p.piece.id === id) : undefined;
  }

  reset(): void {
    this.detailRequest++;
    this.pieces.set([]);
    this.selectedId.set(null);
    this.detail.set(null);
    this.detailLoading.set(false);
  }

  async refreshList(): Promise<void> {
    if (!this.api.available) return;
    this.listLoading.set(true);
    try {
      this.pieces.set(await this.api.getPieces());
    } catch (err) {
      this.toast.error(err, this.i18n.t('pieces.errors.loadList'));
    } finally {
      this.listLoading.set(false);
    }
  }

  async select(id: string | null): Promise<void> {
    this.selectedId.set(id);
    if (this.detail()?.piece.id !== id) this.detail.set(null);
    if (id) await this.reloadDetail();
  }

  async reloadDetail(): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    const req = ++this.detailRequest;
    this.detailLoading.set(true);
    try {
      const d = await this.api.getPieceDetail(id);
      if (req === this.detailRequest && this.selectedId() === id) this.detail.set(d);
    } catch (err) {
      this.toast.error(err, this.i18n.t('pieces.errors.load'));
    } finally {
      if (req === this.detailRequest) this.detailLoading.set(false);
    }
  }

  async create(title: string, composer = ''): Promise<PieceDto | null> {
    try {
      const piece = await this.api.createPiece(title.trim(), composer.trim());
      await this.refreshList();
      return piece;
    } catch (err) {
      this.toast.error(err, this.i18n.t('pieces.errors.create'));
      return null;
    }
  }

  /** Saves title/composer/notes/archived of the selected piece (optimistically). */
  async update(patch: PieceFieldsPatch): Promise<void> {
    const d = this.detail();
    if (!d) return;
    const next = { ...d.piece, ...patch };
    this.detail.set({ ...d, piece: next });
    try {
      const saved = await this.api.updatePiece(next.id, next.title, next.composer, next.notes, next.archived);
      const live = this.detail();
      if (live?.piece.id === saved.id) this.detail.set({ ...live, piece: saved });
      this.pieces.update((l) => l.map((p) => (p.piece.id === saved.id ? { ...p, piece: saved } : p)));
      if (patch.archived !== undefined) void this.refreshList();
    } catch (err) {
      this.toast.error(err, this.i18n.t('pieces.errors.save'));
      void this.reloadDetail();
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.api.deletePiece(id);
      if (this.selectedId() === id) await this.select(null);
      await this.refreshList();
      // The fragments of the open session may have lost their piece.
      void this.sessions.reloadDetail();
      this.toast.success(this.i18n.t('pieces.deleted'));
      return true;
    } catch (err) {
      this.toast.error(err, this.i18n.t('pieces.errors.delete'));
      return false;
    }
  }

  /** Files `fragment` under `pieceId` / `passage` and refreshes whatever shows it. */
  async assign(fragment: FragmentDto, pieceId: string | null, passage: string): Promise<FragmentDto | null> {
    try {
      const updated = await this.api.assignFragmentPiece(fragment.id, pieceId, passage.trim());
      this.sessions.patchFragment(updated.id, (f) => ({ ...f, piece_id: updated.piece_id, passage: updated.passage }));
      await this.refreshList();
      const open = this.selectedId();
      if (open && (open === pieceId || open === fragment.piece_id)) void this.reloadDetail();
      return updated;
    } catch (err) {
      this.toast.error(err, this.i18n.t('pieces.errors.assign'));
      return null;
    }
  }
}
