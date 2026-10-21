import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { type SnapMode, clipCount, clipEnd } from '../../core/composition';
import { CompositionStore, ZOOM_STEPS } from '../../core/composition.store';
import { ConfirmService } from '../../core/confirm.service';
import { type CompositionExport, ExportService } from '../../core/export.service';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import type { MessageKey } from '../../core/i18n/languages';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import { PlaybackStore } from '../../core/playback.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ClipInspectorComponent } from '../clip-inspector/clip-inspector.component';
import { ComposerTimelineComponent } from '../composer-timeline/composer-timeline.component';
import { FragmentLibraryComponent } from '../fragment-library/fragment-library.component';
import { IconComponent } from '../icon/icon.component';
import { InstrumentPickerComponent } from '../instrument-picker/instrument-picker.component';
import { RateSelectComponent } from '../rate-select/rate-select.component';

const SNAP_OPTIONS: { value: SnapMode; label: MessageKey }[] = [
  { value: 'edges', label: 'composer.snap.edges' },
  { value: 'seconds', label: 'composer.snap.seconds' },
  { value: 'off', label: 'composer.snap.off' },
];

/**
 * The composer: a composition's header and transport, its multitrack timeline, the fragment
 * library to drop from and the inspector of the selected clip.
 */
@Component({
  selector: 'app-composer-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IconComponent,
    RateSelectComponent,
    ComposerTimelineComponent,
    FragmentLibraryComponent,
    ClipInspectorComponent,
    InstrumentPickerComponent,
    TranslatePipe,
    PluralPipe,
  ],
  host: {
    class: 'block min-h-full',
    '(window:pointermove)': 'trackPointer($event)',
  },
  templateUrl: './composer-view.component.html',
})
export class ComposerViewComponent {
  protected readonly store = inject(CompositionStore);
  protected readonly playback = inject(PlaybackStore);
  protected readonly api = inject(TauriApiService);
  private readonly i18n = inject(I18nService);
  private readonly confirm = inject(ConfirmService);
  private readonly exporter = inject(ExportService);

  protected readonly formatMs = formatMs;
  protected readonly snapOptions = SNAP_OPTIONS;
  /** Pointer position while a library fragment is dragged (for the floating label). */
  protected readonly pointer = signal<{ x: number; y: number } | null>(null);

  protected readonly clips = computed(() => {
    const d = this.store.doc();
    return d ? clipCount(d) : 0;
  });
  protected readonly loop = computed(() => this.playback.loopFor(this.store.key()));
  protected readonly canZoomIn = computed(() => this.store.zoom() < ZOOM_STEPS.at(-1)!);
  protected readonly canZoomOut = computed(() => this.store.zoom() > ZOOM_STEPS[0]);

  constructor() {
    void this.open();
    inject(DestroyRef).onDestroy(() => void this.store.flush());
  }

  /** Refreshes what may have changed in other views and opens the last composition. */
  private async open(): Promise<void> {
    void this.store.refreshLibrary();
    await this.store.refreshList();
    if (this.store.selectedId()) await this.store.reload();
    else {
      const first = this.store.compositions()[0];
      if (first) await this.store.select(first.id);
    }
  }

  protected trackPointer(ev: PointerEvent): void {
    this.pointer.set(this.store.libraryDrag() ? { x: ev.clientX, y: ev.clientY } : null);
  }

  protected saveTitle(input: HTMLInputElement): void {
    const d = this.store.doc();
    if (!d) return;
    if (!input.value.trim()) input.value = d.title;
    else this.store.rename(input.value);
  }

  protected async deleteComposition(): Promise<void> {
    const d = this.store.doc();
    if (!d) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('composer.delete'),
      message: this.i18n.t('composer.deleteMessage', { title: d.title }),
      confirmLabel: this.i18n.t('composer.delete'),
    });
    if (ok) await this.store.remove(d.id);
  }

  protected exporting(kind: CompositionExport): boolean {
    const key = this.store.key();
    return !!key && this.exporter.isBusy(`${key}.${kind}`);
  }

  /** Saves pending edits first: the backend exports what is stored. */
  protected async export(kind: CompositionExport): Promise<void> {
    const d = this.store.doc();
    if (!d) return;
    await this.store.flush();
    await this.exporter.exportComposition(d.id, d.title, kind);
  }

  protected zoom(direction: 1 | -1): void {
    const steps: readonly number[] = ZOOM_STEPS;
    const i = steps.indexOf(this.store.zoom());
    const next = steps[Math.min(steps.length - 1, Math.max(0, (i < 0 ? 3 : i) + direction))];
    this.store.zoom.set(next);
  }

  /** Loop on: around the selected clip, or the whole composition. Off: removes it. */
  protected async toggleLoop(): Promise<void> {
    const key = this.store.key();
    if (!key) return;
    if (this.loop()) {
      await this.playback.clearLoop(key);
      return;
    }
    const sel = this.store.selectedClip()?.clip;
    const [start, end] = sel ? [sel.start_ms, clipEnd(sel)] : [0, this.store.duration()];
    if (end - start >= 500) await this.playback.setLoop(key, start, end);
  }
}
