import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ConfirmService } from '../../core/confirm.service';
import { clamp, formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { MidiNotesDto, PieceTakeDto } from '../../core/models';
import { NavStore } from '../../core/nav.store';
import { PieceStore } from '../../core/piece.store';
import { PlaybackStore } from '../../core/playback.store';
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

  protected readonly formatMs = formatMs;

  /** Notes per file, for the mini piano rolls. */
  protected readonly notes = signal<Record<string, MidiNotesDto>>({});
  /** Fragment ids chosen for the comparison. */
  protected readonly compared = signal<string[]>([]);

  protected readonly piece = computed(() => this.store.detail()?.piece ?? null);
  protected readonly takes = computed(() => this.store.detail()?.takes ?? []);
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
    if (ok) await this.store.remove(p.id);
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
