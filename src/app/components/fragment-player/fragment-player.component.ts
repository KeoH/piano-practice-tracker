import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ChallengeStore } from '../../core/challenge.store';
import { CompositionStore } from '../../core/composition.store';
import { ConfirmService } from '../../core/confirm.service';
import { ExportService } from '../../core/export.service';
import { clamp, formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { FragmentDto, MidiActivityDto, MidiNotesDto, TimelineCommentDto } from '../../core/models';
import { NavStore } from '../../core/nav.store';
import { PieceStore } from '../../core/piece.store';
import { PlaybackStore } from '../../core/playback.store';
import { SessionStore } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { TimelineDrag } from '../../core/timeline-drag';
import { ToastService } from '../../core/toast.service';
import { UiPrefsStore } from '../../core/ui-prefs.store';
import { IconComponent } from '../icon/icon.component';
import { PiecePickerComponent, type PieceChoice } from '../piece-picker/piece-picker.component';
import { RangeHandlesComponent } from '../range-handles/range-handles.component';
import { RateSelectComponent } from '../rate-select/rate-select.component';
import { TimelineCanvasComponent } from '../timeline-canvas/timeline-canvas.component';
import { TimelineModeToggleComponent } from '../timeline-mode-toggle/timeline-mode-toggle.component';

/** How long a comment's automatic popup stays visible. */
const AUTO_POPUP_MS = 2500;
/** Larger jumps count as a seek (the comments in between are not walked through). */
const MAX_CONTINUOUS_STEP_MS = 1500;
/** Tolerance to show a comment when landing (seek/start) right on it. */
const LANDING_WINDOW_MS = 350;

/** Expandable fragment card with player, comment pins and side panel. */
@Component({
  selector: 'app-fragment-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, PiecePickerComponent, TimelineCanvasComponent, TimelineModeToggleComponent, RangeHandlesComponent, RateSelectComponent, TranslatePipe],
  templateUrl: './fragment-player.component.html',
})
export class FragmentPlayerComponent {
  readonly fragment = input.required<FragmentDto>();
  readonly index = input(0);

  protected readonly api = inject(TauriApiService);
  private readonly challenges = inject(ChallengeStore);
  private readonly nav = inject(NavStore);
  private readonly store = inject(SessionStore);
  protected readonly playback = inject(PlaybackStore);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18nService);

  protected readonly formatMs = formatMs;

  protected readonly expanded = signal(false);
  protected readonly prefs = inject(UiPrefsStore);
  protected readonly exporter = inject(ExportService);
  private readonly pieces = inject(PieceStore);
  private readonly compositions = inject(CompositionStore);
  protected readonly activity = signal<MidiActivityDto | null>(null);
  protected readonly notes = signal<MidiNotesDto | null>(null);
  protected readonly activityLoading = signal(false);
  protected readonly titleDraft = signal('');
  protected readonly explanationDraft = signal('');
  protected readonly newComment = signal('');
  protected readonly addingComment = signal(false);
  protected readonly hoverComment = signal<TimelineCommentDto | null>(null);
  protected readonly autoComment = signal<TimelineCommentDto | null>(null);
  /** Position during a scrub drag (null = not dragging). */
  protected readonly scrubMs = signal<number | null>(null);

  private readonly timeline = viewChild<ElementRef<HTMLElement>>('timeline');
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private scrubPointer: number | null = null;
  private loadedPath: string | null = null;

  protected readonly file = computed(() => this.fragment().file_path);
  protected readonly durationMs = computed(() => this.activity()?.duration_ms || this.fragment().duration_ms || 0);
  protected readonly isPlaying = computed(() => this.playback.isPlaying(this.file()));
  protected readonly isActive = computed(() => this.playback.progress()?.file_path === this.file());
  protected readonly position = computed(() => this.scrubMs() ?? this.playback.positionFor(this.file()));
  protected readonly comments = computed(() =>
    [...this.fragment().comments].sort((a, b) => a.timestamp_ms - b.timestamp_ms),
  );
  protected readonly popup = computed(() => this.hoverComment() ?? this.autoComment());
  /** Two-digit order number ("01"). */
  protected readonly number = computed(() => String(this.index() + 1).padStart(2, '0'));
  protected readonly piece = computed(() => this.pieces.byId(this.fragment().piece_id));
  /** A-B loop of this fragment (while it is on, dragging on the timeline edits it). */
  protected readonly loop = computed(() => this.playback.loopFor(this.file()));
  protected readonly loopDrag = new TimelineDrag({
    track: () => this.timeline()?.nativeElement,
    durationMs: () => this.durationMs(),
    locked: () => false,
    onSeek: (ms) => void this.playback.seek(this.file(), ms),
    onCommit: (sel) => {
      if (sel) void this.playback.setLoop(this.file(), sel.start, sel.end);
    },
  });

  constructor() {
    // Title/explanation drafts kept in sync with the DTO
    const srcTitle = computed(() => this.fragment().title);
    const srcExplanation = computed(() => this.fragment().explanation);
    effect(() => {
      const t = srcTitle();
      untracked(() => this.titleDraft.set(t));
    });
    effect(() => {
      const e = srcExplanation();
      untracked(() => this.explanationDraft.set(e));
    });

    // Loads the activity when expanded (and if the file changes)
    effect(() => {
      const open = this.expanded();
      const path = this.file();
      if (open && path !== this.loadedPath) untracked(() => void this.loadActivity(path));
    });

    // The handles follow the loop (also when it is dropped because another file plays)
    effect(() => {
      const l = this.loop();
      untracked(() => this.loopDrag.selection.set(l ? { start: l.start, end: l.end } : null));
    });

    // Expands automatically when this fragment starts playing
    effect(() => {
      if (this.isPlaying() && !untracked(this.expanded)) this.expanded.set(true);
    });

    // Automatic popup when playback passes a comment's instant
    let prev: number | null = null;
    effect(() => {
      const p = this.playback.progress();
      const file = this.file();
      if (!p || p.file_path !== file || !p.is_playing) {
        prev = p && p.file_path === file ? p.current_ms : null;
        return;
      }
      const cur = p.current_ms;
      const last = prev;
      prev = cur;
      untracked(() => {
        const list = this.comments();
        let hit: TimelineCommentDto | undefined;
        const step = last === null ? -1 : cur - last;
        if (last !== null && step > 0 && step <= MAX_CONTINUOUS_STEP_MS) {
          // Continuous playback: comments in (last, cur]; keep the last one crossed
          for (const c of list) if (c.timestamp_ms > last && c.timestamp_ms <= cur) hit = c;
        } else if (step !== 0) {
          // Start or jump: the comment it lands on
          hit = list.find((c) => cur >= c.timestamp_ms && cur - c.timestamp_ms <= LANDING_WINDOW_MS);
        }
        if (hit) this.showAuto(hit);
      });
    });

    inject(DestroyRef).onDestroy(() => {
      if (this.autoTimer) clearTimeout(this.autoTimer);
    });
  }

  private showAuto(c: TimelineCommentDto): void {
    this.autoComment.set(c);
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => {
      this.autoComment.set(null);
      this.autoTimer = null;
    }, AUTO_POPUP_MS);
  }

  private async loadActivity(path: string): Promise<void> {
    this.loadedPath = path;
    this.activityLoading.set(true);
    try {
      const [a, n] = await Promise.all([this.api.getMidiActivity(path), this.api.getMidiNotes(path)]);
      if (this.file() === path) {
        this.activity.set(a);
        this.notes.set(n);
      }
    } catch (err) {
      this.loadedPath = null;
      this.toast.error(err, this.i18n.t('fragments.errors.analyze'));
    } finally {
      this.activityLoading.set(false);
    }
  }

  protected pct(ms: number): number {
    const d = this.durationMs();
    return d > 0 ? clamp((ms / d) * 100, 0, 100) : 0;
  }

  protected popupLeft(ms: number): number {
    return clamp(this.pct(ms), 12, 88);
  }

  // ---- Transport ----
  protected async togglePlay(): Promise<void> {
    const f = this.file();
    if (this.isPlaying()) {
      await this.playback.pause();
      return;
    }
    const pos = this.playback.positionFor(f);
    await this.playback.play(f, pos >= this.durationMs() - 50 ? 0 : pos);
  }

  protected stop(): void {
    void this.playback.stop(this.file());
  }

  /** Turns the loop on (over the whole fragment, to narrow it by dragging) or off. */
  protected async toggleLoop(): Promise<void> {
    const f = this.file();
    if (this.loop()) {
      await this.playback.clearLoop(f);
      return;
    }
    const d = this.durationMs();
    if (d <= 0) return;
    await this.playback.setLoop(f, 0, d);
    if (!this.isPlaying()) await this.playback.play(f, this.playback.positionFor(f));
  }

  // ---- Scrub / seek on the timeline ----
  private msAt(clientX: number): number {
    const el = this.timeline()?.nativeElement;
    const d = this.durationMs();
    if (!el || d <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * d);
  }

  protected onTimelineDown(ev: PointerEvent): void {
    if (this.loop()) {
      this.loopDrag.trackDown(ev);
      return;
    }
    if (ev.button !== 0 || this.durationMs() <= 0) return;
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.scrubPointer = ev.pointerId;
    this.scrubMs.set(this.msAt(ev.clientX));
  }

  protected onTimelineMove(ev: PointerEvent): void {
    if (this.loop()) {
      this.loopDrag.move(ev);
      return;
    }
    if (this.scrubPointer !== ev.pointerId) return;
    this.scrubMs.set(this.msAt(ev.clientX));
  }

  protected onTimelineUp(ev: PointerEvent): void {
    if (this.loop()) {
      this.loopDrag.up(ev);
      return;
    }
    if (this.scrubPointer !== ev.pointerId) return;
    this.scrubPointer = null;
    const ms = this.msAt(ev.clientX);
    this.scrubMs.set(null);
    void this.playback.seek(this.file(), ms);
  }

  protected onTimelineKey(ev: KeyboardEvent): void {
    const step = ev.shiftKey ? 5000 : 1000;
    let target: number | null = null;
    if (ev.key === 'ArrowLeft') target = this.position() - step;
    else if (ev.key === 'ArrowRight') target = this.position() + step;
    else if (ev.key === 'Home') target = 0;
    else if (ev.key === 'End') target = this.durationMs();
    if (target === null) return;
    ev.preventDefault();
    void this.playback.seek(this.file(), clamp(target, 0, this.durationMs()));
  }

  // ---- Comments ----
  protected seekTo(c: TimelineCommentDto): void {
    void this.playback.seek(this.file(), c.timestamp_ms);
    this.showAuto(c);
  }

  protected playFrom(c: TimelineCommentDto): void {
    void this.playback.play(this.file(), c.timestamp_ms);
  }

  protected async addComment(): Promise<void> {
    const content = this.newComment().trim();
    if (!content || this.addingComment()) return;
    const ts = Math.round(this.playback.positionFor(this.file()));
    const fid = this.fragment().id;
    this.addingComment.set(true);
    try {
      const c = await this.api.addTimelineComment(fid, ts, content);
      this.store.patchFragment(fid, (f) => ({ ...f, comments: [...f.comments, c] }));
      this.newComment.set('');
    } catch (err) {
      this.toast.error(err, this.i18n.t('fragments.errors.addComment'));
    } finally {
      this.addingComment.set(false);
    }
  }

  protected async deleteComment(c: TimelineCommentDto): Promise<void> {
    try {
      await this.api.deleteTimelineComment(c.id);
      this.store.patchFragment(c.fragment_id, (f) => ({ ...f, comments: f.comments.filter((x) => x.id !== c.id) }));
      if (this.hoverComment()?.id === c.id) this.hoverComment.set(null);
      if (this.autoComment()?.id === c.id) this.autoComment.set(null);
    } catch (err) {
      this.toast.error(err, this.i18n.t('fragments.errors.deleteComment'));
    }
  }

  // ---- Metadata ----
  protected async saveMeta(): Promise<void> {
    const f = this.fragment();
    const title = this.titleDraft().trim();
    const explanation = this.explanationDraft();
    if (!title) {
      this.titleDraft.set(f.title);
      return;
    }
    if (title === f.title && explanation === f.explanation) return;
    try {
      await this.api.updateFragmentMeta(f.id, title, explanation);
      this.store.patchFragment(f.id, (x) => ({ ...x, title, explanation }));
    } catch (err) {
      this.toast.error(err, this.i18n.t('fragments.errors.save'));
    }
  }

  protected async assignPiece(choice: PieceChoice): Promise<void> {
    const f = this.fragment();
    if (choice.pieceId === f.piece_id && choice.passage === f.passage) return;
    await this.pieces.assign(f, choice.pieceId, choice.passage);
  }

  /** Copies the fragment as a challenge melody and opens it in the Challenges view. */
  protected async useAsChallenge(): Promise<void> {
    const m = await this.challenges.createFromFragment(this.fragment());
    if (!m) return;
    this.nav.view.set('challenges');
    await this.challenges.select(m.id);
  }

  protected async deleteFragment(): Promise<void> {
    const f = this.fragment();
    const usage = await this.compositions.usageWarning([f.id]);
    const ok = await this.confirm.ask({
      title: this.i18n.t('fragments.delete'),
      message: [this.i18n.plural('fragments.deleteMessage', f.comments.length, { title: f.title }), usage].filter(Boolean).join(' '),
      confirmLabel: this.i18n.t('fragments.delete'),
    });
    if (!ok) return;
    try {
      await this.playback.stopIfActive(f.file_path);
      await this.api.deleteFragment(f.id);
      this.store.removeFragmentLocal(f.id);
      void this.store.refreshList();
      this.toast.success(this.i18n.t('fragments.deleted'));
    } catch (err) {
      this.toast.error(err, this.i18n.t('fragments.errors.delete'));
    }
  }
}
