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
import { ExportService } from '../../core/export.service';
import { clamp, formatMs, parseTime } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { MidiActivityDto, MidiNotesDto, SessionDto, TimeRangeDto } from '../../core/models';
import { PlaybackStore } from '../../core/playback.store';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { UiPrefsStore } from '../../core/ui-prefs.store';
import { IconComponent } from '../icon/icon.component';
import { RangeHandlesComponent } from '../range-handles/range-handles.component';
import { RateSelectComponent } from '../rate-select/rate-select.component';
import { RichTextComponent } from '../rich-text/rich-text.component';
import { MIN_SELECTION_MS, TimelineDrag } from '../../core/timeline-drag';
import { TimelineCanvasComponent } from '../timeline-canvas/timeline-canvas.component';
import { TimelineModeToggleComponent } from '../timeline-mode-toggle/timeline-mode-toggle.component';

/** Visual slicer for the session's raw take (selection, preview, extract and discard). */
@Component({
  selector: 'app-midi-slicer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TimelineCanvasComponent, TimelineModeToggleComponent, RangeHandlesComponent, RateSelectComponent, RichTextComponent, TranslatePipe, PluralPipe],
  templateUrl: './midi-slicer.component.html',
})
export class MidiSlicerComponent {
  readonly session = input.required<SessionDto>();
  readonly fragmentCount = input(0);

  private readonly api = inject(TauriApiService);
  protected readonly store = inject(SessionStore);
  protected readonly playback = inject(PlaybackStore);
  private readonly rec = inject(RecordingStore);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly i18n = inject(I18nService);

  protected readonly formatMs = formatMs;

  protected readonly prefs = inject(UiPrefsStore);
  protected readonly exporter = inject(ExportService);
  protected readonly activity = signal<MidiActivityDto | null>(null);
  protected readonly notes = signal<MidiNotesDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly working = signal(false);

  // Cut suggestions (only valid for the raw take they were computed on)
  protected readonly suggestGapS = signal(3);
  protected readonly suggesting = signal(false);
  private readonly suggestionsState = signal<{ key: string; segments: TimeRangeDto[] } | null>(null);

  // Extraction modal
  protected readonly extractOpen = signal(false);
  protected readonly extractTitle = signal('');
  protected readonly extractExplanation = signal('');

  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
  protected readonly drag = new TimelineDrag({
    track: () => this.track().nativeElement,
    durationMs: () => this.durationMs(),
    locked: () => this.locked(),
    onSeek: (ms) => void this.playback.seek(this.rawPath(), ms),
  });
  protected readonly selection = this.drag.selection;

  protected readonly rawPath = computed(() => this.session().raw_midi_path ?? '');
  protected readonly durationMs = computed(
    () => this.activity()?.duration_ms || this.session().raw_duration_ms || 0,
  );
  protected readonly recordingHere = computed(() => this.rec.recordingSessionId() === this.session().id);
  protected readonly locked = computed(() => this.recordingHere() || this.working() || this.store.undoing());
  protected readonly position = computed(() => this.playback.positionFor(this.rawPath()));
  protected readonly isPlaying = computed(() => this.playback.isPlaying(this.rawPath()));
  protected readonly showPlayhead = computed(
    () => this.playback.progress()?.file_path === this.rawPath() || this.position() > 0,
  );
  private readonly rawKey = computed(() => `${this.session().raw_midi_path ?? ''}|${this.session().raw_duration_ms}`);
  protected readonly suggestions = computed(() => {
    const s = this.suggestionsState();
    return s && s.key === this.rawKey() ? s.segments : null;
  });
  /** Silences between the suggested passages (and before the first / after the last). */
  protected readonly silences = computed<TimeRangeDto[]>(() => {
    const segs = this.suggestions();
    const dur = this.durationMs();
    if (!segs || !segs.length) return [];
    const bounds = [0, ...segs.flatMap((s) => [s.start_ms, s.end_ms]), dur];
    const out: TimeRangeDto[] = [];
    for (let i = 0; i < bounds.length; i += 2) {
      if (bounds[i + 1] - bounds[i] >= MIN_SELECTION_MS) out.push({ start_ms: bounds[i], end_ms: bounds[i + 1] });
    }
    return out;
  });
  protected readonly silenceMs = computed(() => this.silences().reduce((t, s) => t + s.end_ms - s.start_ms, 0));

  protected readonly validSelection = computed(() => {
    const s = this.selection();
    return !!s && s.end - s.start >= MIN_SELECTION_MS && s.start >= 0 && s.end <= this.durationMs() + 1;
  });

  constructor() {
    // Reloads the activity when the raw take's path or duration changes
    effect(() => {
      this.rawKey();
      untracked(() => void this.loadActivity(this.session().raw_midi_path, this.session().raw_duration_ms));
    });
  }

  private async loadActivity(path: string | null, _dur: number): Promise<void> {
    if (!path) {
      this.activity.set(null);
      this.notes.set(null);
      return;
    }
    this.loading.set(true);
    try {
      const [a, n] = await Promise.all([this.api.getMidiActivity(path), this.api.getMidiNotes(path)]);
      if (this.session().raw_midi_path === path) {
        this.activity.set(a);
        this.notes.set(n);
      }
      // Fits the selection to the new duration
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

  // ---- Inputs mm:ss ----
  protected onTimeInput(el: HTMLInputElement, which: 'start' | 'end'): void {
    const ms = parseTime(el.value);
    if (ms === null) {
      this.toast.warning(this.i18n.t('slicer.invalidTime'));
    } else if (which === 'start') {
      this.drag.setStart(ms);
    } else {
      this.drag.setEnd(ms);
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

  // ---- Preview ----
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

  // ---- Destructive actions ----
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

  // ---- Cut suggestions ----
  protected async suggest(): Promise<void> {
    const path = this.rawPath();
    if (!path || this.suggesting()) return;
    const key = this.rawKey();
    this.suggesting.set(true);
    try {
      const segments = await this.api.suggestMidiSegments(path, this.suggestGapS() * 1000);
      if (this.rawKey() === key) this.suggestionsState.set({ key, segments });
    } catch (err) {
      this.toast.error(err, this.i18n.t('slicer.errors.suggest'));
    } finally {
      this.suggesting.set(false);
    }
  }

  protected setSuggestGap(seconds: number): void {
    this.suggestGapS.set(seconds);
    void this.suggest();
  }

  protected closeSuggestions(): void {
    this.suggestionsState.set(null);
  }

  protected pickSegment(s: TimeRangeDto): void {
    if (this.locked()) return;
    this.selection.set({ start: s.start_ms, end: s.end_ms });
  }

  protected async discardSilences(): Promise<void> {
    const silences = this.silences();
    if (!silences.length) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('slicer.suggest.discardTitle'),
      message: this.i18n.plural('slicer.suggest.discardMessage', silences.length, {
        duration: formatMs(this.silenceMs(), true),
      }),
      confirmLabel: this.i18n.t('slicer.discardConfirm'),
    });
    if (!ok) return;
    this.working.set(true);
    try {
      await this.playback.stopIfActive(this.rawPath());
      const s = await this.api.discardMidiRanges(this.session().id, silences);
      this.selection.set(null);
      this.store.applySession(s);
      await this.store.reloadDetail();
      void this.store.refreshList();
      this.toast.success(this.i18n.plural('slicer.suggest.discarded', silences.length));
    } catch (err) {
      this.toast.error(err, this.i18n.t('slicer.errors.discard'));
    } finally {
      this.working.set(false);
    }
    // The passages are now back to back: suggest them again on the new take.
    await this.suggest();
  }

  protected async undo(): Promise<void> {
    if (await this.store.undoTrim()) this.selection.set(null);
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
