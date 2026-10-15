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
import { ConfirmService } from '../../core/confirm.service';
import { clamp, formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { FragmentDto, MidiActivityDto, TimelineCommentDto } from '../../core/models';
import { PlaybackStore } from '../../core/playback.store';
import { SessionStore } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';
import { TimelineCanvasComponent } from '../timeline-canvas/timeline-canvas.component';

/** Tiempo que permanece visible el popup automático de un comentario. */
const AUTO_POPUP_MS = 2500;
/** Saltos mayores se consideran seek (no se recorren los comentarios intermedios). */
const MAX_CONTINUOUS_STEP_MS = 1500;
/** Tolerancia para mostrar un comentario al aterrizar (seek/inicio) justo sobre él. */
const LANDING_WINDOW_MS = 350;

/** Tarjeta expandible de un fragmento con reproductor, pins de comentarios y panel lateral. */
@Component({
  selector: 'app-fragment-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TimelineCanvasComponent, TranslatePipe],
  templateUrl: './fragment-player.component.html',
})
export class FragmentPlayerComponent {
  readonly fragment = input.required<FragmentDto>();
  readonly index = input(0);

  private readonly api = inject(TauriApiService);
  private readonly store = inject(SessionStore);
  protected readonly playback = inject(PlaybackStore);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18nService);

  protected readonly formatMs = formatMs;

  protected readonly expanded = signal(false);
  protected readonly activity = signal<MidiActivityDto | null>(null);
  protected readonly activityLoading = signal(false);
  protected readonly titleDraft = signal('');
  protected readonly explanationDraft = signal('');
  protected readonly newComment = signal('');
  protected readonly addingComment = signal(false);
  protected readonly hoverComment = signal<TimelineCommentDto | null>(null);
  protected readonly autoComment = signal<TimelineCommentDto | null>(null);
  /** Posición durante un arrastre de scrub (null = sin arrastre). */
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
  /** Número de orden con dos cifras («01»). */
  protected readonly number = computed(() => String(this.index() + 1).padStart(2, '0'));

  constructor() {
    // Borradores de título/explicación sincronizados con el DTO
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

    // Carga la actividad al expandir (y si cambia el fichero)
    effect(() => {
      const open = this.expanded();
      const path = this.file();
      if (open && path !== this.loadedPath) untracked(() => void this.loadActivity(path));
    });

    // Se expande automáticamente cuando empieza a sonar este fragmento
    effect(() => {
      if (this.isPlaying() && !untracked(this.expanded)) this.expanded.set(true);
    });

    // Popup automático al pasar la reproducción por el instante de un comentario
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
          // Recorrido continuo: comentarios en (last, cur]; nos quedamos con el último cruzado
          for (const c of list) if (c.timestamp_ms > last && c.timestamp_ms <= cur) hit = c;
        } else if (step !== 0) {
          // Inicio o salto: comentario sobre el que se aterriza
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
      const a = await this.api.getMidiActivity(path);
      if (this.file() === path) this.activity.set(a);
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

  // ---- Transporte ----
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

  // ---- Scrub / seek en la línea de tiempo ----
  private msAt(clientX: number): number {
    const el = this.timeline()?.nativeElement;
    const d = this.durationMs();
    if (!el || d <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * d);
  }

  protected onTimelineDown(ev: PointerEvent): void {
    if (ev.button !== 0 || this.durationMs() <= 0) return;
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.scrubPointer = ev.pointerId;
    this.scrubMs.set(this.msAt(ev.clientX));
  }

  protected onTimelineMove(ev: PointerEvent): void {
    if (this.scrubPointer !== ev.pointerId) return;
    this.scrubMs.set(this.msAt(ev.clientX));
  }

  protected onTimelineUp(ev: PointerEvent): void {
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

  // ---- Comentarios ----
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

  // ---- Metadatos ----
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

  protected async deleteFragment(): Promise<void> {
    const f = this.fragment();
    const ok = await this.confirm.ask({
      title: this.i18n.t('fragments.delete'),
      message: this.i18n.plural('fragments.deleteMessage', f.comments.length, { title: f.title }),
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
