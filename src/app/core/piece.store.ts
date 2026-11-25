import { Injectable, computed, inject, signal } from '@angular/core';
import { I18nService } from './i18n/i18n.service';
import type { CollectionDto, FragmentDto, PieceDetailDto, PieceDto, PieceSummaryDto, ScoreSummaryDto } from './models';
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
  /** Collections of pieces, by name. */
  readonly collections = signal<CollectionDto[]>([]);
  /** Collection the list is narrowed to (`null` = the whole repertoire). */
  readonly collectionFilter = signal<string | null>(null);
  private detailRequest = 0;

  /** The collection of the filter, or null when it is gone (deleted) or not set. */
  readonly activeCollection = computed(() => this.collections().find((c) => c.id === this.collectionFilter()) ?? null);

  readonly filteredPieces = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const inCollection = this.activeCollection();
    let list = this.pieces();
    if (inCollection) list = list.filter((p) => inCollection.piece_ids.includes(p.piece.id));
    return q
      ? list.filter((p) => p.piece.title.toLowerCase().includes(q) || p.piece.composer.toLowerCase().includes(q))
      : list;
  });

  /** The collections the selected piece is in. */
  readonly selectedCollectionIds = computed(() => {
    const id = this.selectedId();
    return id ? this.collections().filter((c) => c.piece_ids.includes(id)).map((c) => c.id) : [];
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
    this.collections.set([]);
    this.collectionFilter.set(null);
  }

  async refreshList(): Promise<void> {
    if (!this.api.available) return;
    this.listLoading.set(true);
    try {
      const [pieces, collections] = await Promise.all([this.api.getPieces(), this.api.getCollections()]);
      this.pieces.set(pieces);
      this.collections.set(collections ?? []);
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

  // ---- Collections ----

  /** Creates a collection; with `pieceId` the piece goes into it. Resolves with it, or null on failure. */
  async createCollection(name: string, pieceId?: string): Promise<CollectionDto | null> {
    try {
      const created = await this.api.createCollection(name.trim());
      if (pieceId) {
        const ids = [...this.collections().filter((c) => c.piece_ids.includes(pieceId)).map((c) => c.id), created.id];
        this.collections.set(await this.api.setPieceCollections(pieceId, ids));
      } else {
        this.collections.update((l) => this.byName([...l, created]));
      }
      return created;
    } catch (err) {
      this.toast.error(err, this.i18n.t('collections.errors.create'));
      return null;
    }
  }

  async renameCollection(id: string, name: string): Promise<void> {
    try {
      const saved = await this.api.renameCollection(id, name.trim());
      this.collections.update((l) => this.byName(l.map((c) => (c.id === id ? saved : c))));
    } catch (err) {
      this.toast.error(err, this.i18n.t('collections.errors.rename'));
    }
  }

  /** Deletes the collection (not its pieces). */
  async removeCollection(id: string): Promise<boolean> {
    try {
      await this.api.deleteCollection(id);
      this.collections.update((l) => l.filter((c) => c.id !== id));
      if (this.collectionFilter() === id) this.collectionFilter.set(null);
      this.toast.success(this.i18n.t('collections.deleted'));
      return true;
    } catch (err) {
      this.toast.error(err, this.i18n.t('collections.errors.delete'));
      return false;
    }
  }

  /** Puts or takes the piece out of one collection. */
  async toggleInCollection(pieceId: string, collectionId: string): Promise<void> {
    const ids = this.collections().filter((c) => c.piece_ids.includes(pieceId)).map((c) => c.id);
    const next = ids.includes(collectionId) ? ids.filter((id) => id !== collectionId) : [...ids, collectionId];
    try {
      this.collections.set(await this.api.setPieceCollections(pieceId, next));
    } catch (err) {
      this.toast.error(err, this.i18n.t('collections.errors.assign'));
      void this.refreshList();
    }
  }

  private byName(list: CollectionDto[]): CollectionDto[] {
    return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  // ---- Scores ----

  /**
   * Files a score under a piece (`null` takes it out) and returns its new entry. The callers refresh
   * the scores list with it, because `ScoreStore` already depends on this store, not the other way.
   */
  async assignScore(scoreId: string, pieceId: string | null): Promise<ScoreSummaryDto | null> {
    try {
      const updated = await this.api.assignScorePiece(scoreId, pieceId);
      const previous = this.detail()?.scores.find((s) => s.id === scoreId)?.piece_id ?? null;
      await this.refreshList();
      const open = this.selectedId();
      if (open && (open === pieceId || open === previous)) void this.reloadDetail();
      return updated;
    } catch (err) {
      this.toast.error(err, this.i18n.t('pieces.errors.assignScore'));
      return null;
    }
  }

  /**
   * Moves a score of the open piece one place up (`-1`) or down (`1`). The list changes at once and the
   * stored order replaces it when the backend answers; a refused order reloads the piece.
   */
  async moveScore(scoreId: string, delta: -1 | 1): Promise<void> {
    const d = this.detail();
    if (!d) return;
    const from = d.scores.findIndex((s) => s.id === scoreId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= d.scores.length) return;
    const scores = [...d.scores];
    [scores[from], scores[to]] = [scores[to], scores[from]];
    this.detail.set({ ...d, scores });
    try {
      const stored = await this.api.reorderPieceScores(d.piece.id, scores.map((s) => s.id));
      const live = this.detail();
      if (live?.piece.id === d.piece.id && stored) this.detail.set({ ...live, scores: stored });
    } catch (err) {
      this.toast.error(err, this.i18n.t('pieces.errors.reorder'));
      void this.reloadDetail();
    }
  }

  /**
   * "Add to repertoire" in one step: a new piece named after the score, with the score in it.
   * Resolves with the piece, or null on failure.
   */
  async createFromScore(scoreId: string, title: string): Promise<PieceDto | null> {
    const piece = await this.create(title);
    if (!piece) return null;
    return (await this.assignScore(scoreId, piece.id)) ? piece : null;
  }
}
