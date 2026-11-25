import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ExportService, piecePdfKey } from '../../core/export.service';
import { ConfirmService } from '../../core/confirm.service';
import { clamp, formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { MidiNotesDto, PieceTakeDto } from '../../core/models';
import { NavStore } from '../../core/nav.store';
import { PieceStore } from '../../core/piece.store';
import { PlaybackStore } from '../../core/playback.store';
import { ScoreStore } from '../../core/score.store';
import { SessionStore } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { UiPrefsStore } from '../../core/ui-prefs.store';
import { IconComponent } from '../icon/icon.component';
import { RateSelectComponent } from '../rate-select/rate-select.component';
import { TimelineCanvasComponent } from '../timeline-canvas/timeline-canvas.component';

/** Takes of one passage, oldest first. */
interface PassageGroup {
  passage: string;
  takes: PieceTakeDto[];
}

/** At most two takes are compared at a time. */
const MAX_COMPARED = 2;

/**
 * A piece of the repertoire: its details and notes, its takes grouped by passage (in
 * chronological order, to hear the progress), and the comparison of two takes on the same time
 * scale.
 */
@Component({
  selector: 'app-pieces-view',
  host: { class: 'block h-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TimelineCanvasComponent, RateSelectComponent, TranslatePipe, PluralPipe],
  templateUrl: './pieces-view.component.html',
})
export class PiecesViewComponent {
  protected readonly store = inject(PieceStore);
  protected readonly playback = inject(PlaybackStore);
  protected readonly prefs = inject(UiPrefsStore);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(TauriApiService);
  private readonly sessions = inject(SessionStore);
  private readonly nav = inject(NavStore);
  private readonly confirm = inject(ConfirmService);
  private readonly scoreStore = inject(ScoreStore);
  private readonly exporter = inject(ExportService);

  protected readonly formatMs = formatMs;

  /** Notes per file, for the mini piano rolls. */
  protected readonly notes = signal<Record<string, MidiNotesDto>>({});
  /** Fragment ids chosen for the comparison. */
  protected readonly compared = signal<string[]>([]);

  protected readonly piece = computed(() => this.store.detail()?.piece ?? null);
  protected readonly takes = computed(() => this.store.detail()?.takes ?? []);
  protected readonly scores = computed(() => this.store.detail()?.scores ?? []);
  /** Scores that can still be added to this piece (the ones already in it are not offered). */
  protected readonly addableScores = computed(() => {
    const id = this.store.selectedId();
    return this.scoreStore.scores().filter((s) => s.piece_id !== id);
  });
  /** Scores that have notes to print: the ones without are left out of the PDF. */
  protected readonly printable = computed(() => this.scores().filter((s) => s.note_count > 0));
  protected readonly exportingPdf = computed(() => {
    const id = this.store.selectedId();
    return !!id && this.exporter.isBusy(piecePdfKey(id));
  });
  /** `true` while the field to name a new collection is open. */
  protected readonly creatingCollection = signal(false);
  protected readonly groups = computed<PassageGroup[]>(() => {
    const groups: PassageGroup[] = [];
    for (const t of this.takes()) {
      const last = groups[groups.length - 1];
      if (last && last.passage.toLowerCase() === t.fragment.passage.toLowerCase()) last.takes.push(t);
      else groups.push({ passage: t.fragment.passage, takes: [t] });
    }
    // The whole piece (no passage) last: passages are what one usually works on.
    return [...groups.filter((g) => g.passage), ...groups.filter((g) => !g.passage)];
  });
  protected readonly comparedTakes = computed(() =>
    this.compared()
      .map((id) => this.takes().find((t) => t.fragment.id === id))
      .filter((t): t is PieceTakeDto => !!t),
  );
  /** Shared time scale of the comparison: the longest of the two takes. */
  protected readonly compareDuration = computed(() => Math.max(0, ...this.comparedTakes().map((t) => t.fragment.duration_ms)));

  constructor() {
    // The view is created each time it is shown: a score may have been renamed, filed or deleted
    // in the editor since the piece was last loaded.
    void this.scoreStore.refreshList();
    void this.store.reloadDetail();
    // Loads the notes of the takes that are not loaded yet
    effect(() => {
      const files = this.takes().map((t) => t.fragment.file_path);
      untracked(() => void this.loadNotes(files));
    });
    // A different piece starts a new comparison
    effect(() => {
      this.store.selectedId();
      untracked(() => this.compared.set([]));
    });
  }

  private async loadNotes(files: string[]): Promise<void> {
    const missing = files.filter((f) => !this.notes()[f]);
    for (const file of missing) {
      try {
        const n = await this.api.getMidiNotes(file);
        this.notes.update((m) => ({ ...m, [file]: n }));
      } catch {
        // The row keeps the empty timeline; playing it reports the error.
      }
    }
  }

  // ---- Piece details ----
  protected saveTitle(el: HTMLInputElement): void {
    const title = el.value.trim();
    const p = this.piece();
    if (!p) return;
    if (!title) {
      el.value = p.title;
      return;
    }
    if (title !== p.title) void this.store.update({ title });
  }

  protected saveComposer(value: string): void {
    const p = this.piece();
    if (p && value.trim() !== p.composer) void this.store.update({ composer: value.trim() });
  }

  protected saveNotes(value: string): void {
    const p = this.piece();
    if (p && value !== p.notes) void this.store.update({ notes: value });
  }

  protected toggleArchived(): void {
    const p = this.piece();
    if (p) void this.store.update({ archived: !p.archived });
  }

  protected async deletePiece(): Promise<void> {
    const p = this.piece();
    if (!p) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('pieces.delete'),
      message: this.i18n.plural('pieces.deleteMessage', this.takes().length, { title: p.title }),
      confirmLabel: this.i18n.t('pieces.delete'),
    });
    if (!ok) return;
    if (await this.store.remove(p.id)) void this.scoreStore.refreshList();
  }

  // ---- Collections ----
  protected inCollection(collectionId: string): boolean {
    return this.store.selectedCollectionIds().includes(collectionId);
  }

  protected toggleCollection(collectionId: string): void {
    const p = this.piece();
    if (p) void this.store.toggleInCollection(p.id, collectionId);
  }

  protected async createCollection(el: HTMLInputElement): Promise<void> {
    const name = el.value.trim();
    const p = this.piece();
    if (!name || !p) return;
    if (await this.store.createCollection(name, p.id)) {
      el.value = '';
      this.creatingCollection.set(false);
    }
  }

  // ---- Scores ----
  protected async addScore(select: HTMLSelectElement): Promise<void> {
    const p = this.piece();
    const id = select.value;
    select.value = '';
    if (p && id) await this.scoreStore.assignPiece(id, p.id);
  }

  protected removeScore(scoreId: string): Promise<void> {
    return this.scoreStore.assignPiece(scoreId, null);
  }

  protected moveScore(scoreId: string, delta: -1 | 1): void {
    void this.store.moveScore(scoreId, delta);
  }

  /** Saves what is pending in the editor and writes the scores of the piece, in order, into one PDF. */
  protected async exportPdf(): Promise<void> {
    const p = this.piece();
    if (!p || !this.printable().length) return;
    await this.scoreStore.flush();
    await this.exporter.exportPiece(p, this.printable().map((s) => s.id));
  }

  protected openScore(scoreId: string): void {
    this.nav.view.set('scores');
    void this.scoreStore.select(scoreId);
  }

  // ---- Takes ----
  protected isPlaying(t: PieceTakeDto): boolean {
    return this.playback.isPlaying(t.fragment.file_path);
  }

  protected progressOf(t: PieceTakeDto): number | null {
    const pos = this.playback.positionFor(t.fragment.file_path);
    return pos > 0 ? pos : null;
  }

  protected async togglePlay(t: PieceTakeDto): Promise<void> {
    const file = t.fragment.file_path;
    if (this.isPlaying(t)) {
      await this.playback.pause();
      return;
    }
    const pos = this.playback.positionFor(file);
    await this.playback.play(file, pos >= t.fragment.duration_ms - 50 ? 0 : pos);
  }

  protected isCompared(t: PieceTakeDto): boolean {
    return this.compared().includes(t.fragment.id);
  }

  /** Adds or removes a take; a third one replaces the oldest choice. */
  protected toggleCompare(t: PieceTakeDto): void {
    const id = t.fragment.id;
    this.compared.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id].slice(-MAX_COMPARED)));
  }

  protected pct(ms: number, duration: number): number {
    return duration > 0 ? clamp((ms / duration) * 100, 0, 100) : 0;
  }

  protected openSession(t: PieceTakeDto): void {
    this.nav.view.set('sessions');
    this.sessions.tab.set('fragments');
    void this.sessions.select(t.fragment.session_id);
  }
}
