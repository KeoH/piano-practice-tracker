import {
  ChangeDetectionStrategy,
  Component,
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
import { clamp, formatMs, parseTime } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { MidiActivityDto, SessionDto } from '../../core/models';
import { PlaybackStore } from '../../core/playback.store';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';
import { RichTextComponent } from '../rich-text/rich-text.component';
import { TimelineCanvasComponent, type TimeRange } from '../timeline-canvas/timeline-canvas.component';

type DragMode = 'start' | 'end' | 'move' | 'create';

interface DragState {
  mode: DragMode;
  pointerId: number;
  x0: number;
  ms0: number;
  sel0: TimeRange | null;
  moved: boolean;
}

const MIN_SELECTION_MS = 100;
const DRAG_THRESHOLD_PX = 4;

/** Recortador visual de la pista bruta de la sesión (selección, preescucha, extraer y descartar). */
@Component({
  selector: 'app-midi-slicer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TimelineCanvasComponent, RichTextComponent, TranslatePipe],
  templateUrl: './midi-slicer.component.html',
})
export class MidiSlicerComponent {
  readonly session = input.required<SessionDto>();
  readonly fragmentCount = input(0);

  private readonly api = inject(TauriApiService);
  private readonly store = inject(SessionStore);
  protected readonly playback = inject(PlaybackStore);
  private readonly rec = inject(RecordingStore);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18nService);

  protected readonly formatMs = formatMs;

  protected readonly activity = signal<MidiActivityDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly selection = signal<TimeRange | null>(null);
  protected readonly working = signal(false);

  // Modal de extracción
  protected readonly extractOpen = signal(false);
  protected readonly extractTitle = signal('');
  protected readonly extractExplanation = signal('');

  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
  private drag: DragState | null = null;

  protected readonly rawPath = computed(() => this.session().raw_midi_path ?? '');
  protected readonly durationMs = computed(
    () => this.activity()?.duration_ms || this.session().raw_duration_ms || 0,
  );
  protected readonly recordingHere = computed(() => this.rec.recordingSessionId() === this.session().id);
  protected readonly locked = computed(() => this.recordingHere() || this.working());
  protected readonly position = computed(() => this.playback.positionFor(this.rawPath()));
  protected readonly isPlaying = computed(() => this.playback.isPlaying(this.rawPath()));
  protected readonly showPlayhead = computed(
    () => this.playback.progress()?.file_path === this.rawPath() || this.position() > 0,
  );
  protected readonly validSelection = computed(() => {
    const s = this.selection();
    return !!s && s.end - s.start >= MIN_SELECTION_MS && s.start >= 0 && s.end <= this.durationMs() + 1;
  });

  constructor() {
    // Recarga la actividad cuando cambia la ruta o la duración de la pista bruta
    const rawKey = computed(() => `${this.session().raw_midi_path ?? ''}|${this.session().raw_duration_ms}`);
    effect(() => {
      rawKey();
      untracked(() => void this.loadActivity(this.session().raw_midi_path, this.session().raw_duration_ms));
    });
  }

  private async loadActivity(path: string | null, _dur: number): Promise<void> {
    if (!path) {
      this.activity.set(null);
      return;
    }
    this.loading.set(true);
    try {
      const a = await this.api.getMidiActivity(path);
      if (this.session().raw_midi_path === path) this.activity.set(a);
      // Ajusta la selección a la nueva duración
      const sel = this.selection();
      if (sel && sel.end > a.duration_ms) this.selection.set(null);
    } catch (err) {
      this.toast.error(err, this.i18n.t('slicer.errors.analyze'));
    } finally {
      this.loading.set(false);
    }
  }

  protected reload(): void {
    void this.loadActivity(this.session().raw_midi_path, this.session().raw_duration_ms);
  }

  protected pct(ms: number): number {
    const d = this.durationMs();
    return d > 0 ? clamp((ms / d) * 100, 0, 100) : 0;
  }

  private msAt(clientX: number): number {
    const r = this.track().nativeElement.getBoundingClientRect();
    const d = this.durationMs();
    if (r.width <= 0 || d <= 0) return 0;
    return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * d);
  }

  // ---- Interacción con puntero ----
  protected onHandleDown(ev: PointerEvent, mode: 'start' | 'end'): void {
    if (ev.button !== 0 || this.locked()) return;
    ev.stopPropagation();
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.drag = { mode, pointerId: ev.pointerId, x0: ev.clientX, ms0: this.msAt(ev.clientX), sel0: this.selection(), moved: true };
  }

  protected onTrackDown(ev: PointerEvent): void {
    if (ev.button !== 0 || this.durationMs() <= 0) return;
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    const ms = this.msAt(ev.clientX);
    const sel = this.selection();
    const inside = !!sel && ms >= sel.start && ms <= sel.end;
    this.drag = { mode: inside ? 'move' : 'create', pointerId: ev.pointerId, x0: ev.clientX, ms0: ms, sel0: sel, moved: false };
  }

  protected onPointerMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== ev.pointerId) return;
    if (!d.moved) {
      if (Math.abs(ev.clientX - d.x0) < DRAG_THRESHOLD_PX || this.locked()) return;
      d.moved = true;
    }
    const ms = this.msAt(ev.clientX);
    const dur = this.durationMs();
    const sel = this.selection();
    switch (d.mode) {
      case 'start':
        if (sel) this.selection.set({ start: clamp(ms, 0, sel.end - MIN_SELECTION_MS), end: sel.end });
        break;
      case 'end':
        if (sel) this.selection.set({ start: sel.start, end: clamp(ms, sel.start + MIN_SELECTION_MS, dur) });
        break;
      case 'move':
        if (d.sel0) {
          const len = d.sel0.end - d.sel0.start;
          const start = clamp(d.sel0.start + (ms - d.ms0), 0, Math.max(0, dur - len));
          this.selection.set({ start, end: start + len });
        }
        break;
      case 'create':
        this.selection.set({ start: Math.min(d.ms0, ms), end: Math.max(d.ms0, ms) });
        break;
    }
  }

  protected onPointerUp(ev: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== ev.pointerId) return;
    this.drag = null;
    if (!d.moved) {
      // Clic simple = seek
      void this.playback.seek(this.rawPath(), this.msAt(ev.clientX));
      return;
    }
    const sel = this.selection();
    if (sel && sel.end - sel.start < MIN_SELECTION_MS) this.selection.set(d.mode === 'create' ? null : d.sel0);
  }

  protected onHandleKey(ev: KeyboardEvent, which: 'start' | 'end'): void {
    const sel = this.selection();
    if (!sel || this.locked()) return;
    const step = ev.shiftKey ? 1000 : 100;
    let delta = 0;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') delta = -step;
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') delta = step;
    else return;
    ev.preventDefault();
    if (which === 'start') this.setStart(sel.start + delta);
    else this.setEnd(sel.end + delta);
  }

  // ---- Inputs mm:ss ----
  private setStart(ms: number): void {
    const dur = this.durationMs();
    const sel = this.selection() ?? { start: 0, end: dur };
    this.selection.set({ start: clamp(ms, 0, Math.max(0, sel.end - MIN_SELECTION_MS)), end: sel.end });
  }

  private setEnd(ms: number): void {
    const dur = this.durationMs();
    const sel = this.selection() ?? { start: 0, end: dur };
    this.selection.set({ start: sel.start, end: clamp(ms, sel.start + MIN_SELECTION_MS, dur) });
  }

  protected onTimeInput(el: HTMLInputElement, which: 'start' | 'end'): void {
    const ms = parseTime(el.value);
    if (ms === null) {
      this.toast.warning(this.i18n.t('slicer.invalidTime'));
    } else if (which === 'start') {
      this.setStart(ms);
    } else {
      this.setEnd(ms);
    }
    const sel = this.selection();
    el.value = sel ? formatMs(which === 'start' ? sel.start : sel.end, true) : '';
  }

  protected selectAll(): void {
    const d = this.durationMs();
    if (d > 0) this.selection.set({ start: 0, end: d });
  }

  protected clearSelection(): void {
    this.selection.set(null);
  }

  // ---- Preescucha ----
  protected async play(): Promise<void> {
    const path = this.rawPath();
    if (!path || this.isPlaying()) return;
    const sel = this.validSelection() ? this.selection() : null;
    if (sel) {
      const pos = this.position();
      const progress = this.playback.progress();
      const resumable = progress?.file_path === path && pos > sel.start && pos < sel.end - 50;
      await this.playback.play(path, resumable ? pos : sel.start, sel.end);
    } else {
      const pos = this.position();
      await this.playback.play(path, pos >= this.durationMs() - 50 ? 0 : pos);
    }
  }

  protected pause(): void {
    void this.playback.pause();
  }

  protected stop(): void {
    void this.playback.stop(this.rawPath());
  }

  // ---- Acciones destructivas ----
  protected openExtract(): void {
    if (!this.validSelection()) {
      this.toast.warning(this.i18n.t('slicer.invalidRange'));
      return;
    }
    this.extractTitle.set(this.i18n.t('slicer.defaultFragmentTitle', { n: this.fragmentCount() + 1 }));
    this.extractExplanation.set('');
    this.extractOpen.set(true);
  }

  protected async extract(): Promise<void> {
    const sel = this.selection();
    const title = this.extractTitle().trim();
    if (!sel || !this.validSelection()) return;
    if (!title) {
      this.toast.warning(this.i18n.t('slicer.titleRequired'));
      return;
    }
    this.working.set(true);
    try {
      await this.playback.stopIfActive(this.rawPath());
      const res = await this.api.extractMidiFragment({
        session_id: this.session().id,
        start_ms: Math.round(sel.start),
        end_ms: Math.round(sel.end),
        title,
        explanation: this.extractExplanation().trim(),
      });
      this.extractOpen.set(false);
      this.selection.set(null);
      this.store.applySession(res.session);
      await this.store.reloadDetail();
      void this.store.refreshList();
      this.toast.success(
        this.i18n.t('slicer.extracted', { title: res.fragment.title, duration: formatMs(res.fragment.duration_ms) }),
      );
    } catch (err) {
      this.toast.error(err, this.i18n.t('slicer.errors.extract'));
    } finally {
      this.working.set(false);
    }
  }

  protected async discard(): Promise<void> {
    const sel = this.selection();
    if (!sel || !this.validSelection()) {
      this.toast.warning(this.i18n.t('slicer.invalidRange'));
      return;
    }
    const ok = await this.confirm.ask({
      title: this.i18n.t('slicer.discardTitle'),
      message: this.i18n.t('slicer.discardMessage', {
        start: formatMs(sel.start, true),
        end: formatMs(sel.end, true),
        duration: formatMs(sel.end - sel.start, true),
      }),
      confirmLabel: this.i18n.t('slicer.discardConfirm'),
    });
    if (!ok) return;
    this.working.set(true);
    try {
      await this.playback.stopIfActive(this.rawPath());
      const s = await this.api.discardMidiRange(this.session().id, sel.start, sel.end);
      this.selection.set(null);
      this.store.applySession(s);
      await this.store.reloadDetail();
      void this.store.refreshList();
      this.toast.success(this.i18n.t('slicer.discarded'));
    } catch (err) {
      this.toast.error(err, this.i18n.t('slicer.errors.discard'));
    } finally {
      this.working.set(false);
    }
  }
}
