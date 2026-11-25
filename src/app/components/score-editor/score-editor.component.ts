import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { ConfirmService } from '../../core/confirm.service';
import { ExportService, scorePdfKey } from '../../core/export.service';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { NoteKind } from '../../core/music';
import { parseNoteNames, spelledNoteName } from '../../core/music';
import {
  MAX_BARS,
  MAX_BPM,
  MIN_BPM,
  PALETTE_KINDS,
  TIME_SIGNATURES,
  canDot,
  barLabel,
  barTicks,
  minBars,
  noteCount,
  notatedValue,
  scoreDurationMs,
} from '../../core/score';
import { SCORE_ZOOM_STEPS, ScoreStore } from '../../core/score.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { IconComponent } from '../icon/icon.component';
import { RateSelectComponent } from '../rate-select/rate-select.component';
import { ScoreStaffComponent } from '../score-staff/score-staff.component';

/** Noto Music symbols for the palette. */
const NOTE_GLYPHS: Record<NoteKind, string> = {
  whole: '\u{1D15D}',
  half: '\u{1D15E}',
  quarter: '\u{1D15F}',
  eighth: '\u{1D160}',
  sixteenth: '\u{1D161}',
  thirtysecond: '\u{1D162}',
};

/** Pixels each palette glyph is lifted by so its notehead sits in the middle of its button (the font puts them low). */
const GLYPH_LIFT: Record<NoteKind, number> = { whole: -9, half: -2, quarter: -2, eighth: -2, sixteenth: -2, thirtysecond: -2 };

/**
 * The score editor: a score's header and transport, the palette of note values to drag onto the
 * staff, and the grand staff itself (`ScoreStaffComponent`, which turns the pointer into edits).
 * Shortcuts are in `App.scoreKey`.
 */
@Component({
  selector: 'app-score-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RateSelectComponent, ScoreStaffComponent, TranslatePipe, PluralPipe],
  host: { class: 'block min-h-full' },
  templateUrl: './score-editor.component.html',
})
export class ScoreEditorComponent {
  protected readonly store = inject(ScoreStore);
  protected readonly api = inject(TauriApiService);
  private readonly i18n = inject(I18nService);
  private readonly confirm = inject(ConfirmService);
  protected readonly exporter = inject(ExportService);

  protected readonly formatMs = formatMs;
  protected readonly glyphs = NOTE_GLYPHS;
  protected readonly glyphLift = GLYPH_LIFT;
  protected readonly palette = PALETTE_KINDS;
  protected readonly timeSignatures = TIME_SIGNATURES;
  protected readonly MIN_BPM = MIN_BPM;
  protected readonly MAX_BPM = MAX_BPM;
  protected readonly canDot = canDot;
  protected readonly minBars = minBars;

  protected readonly duration = computed(() => {
    const d = this.store.doc();
    return d ? scoreDurationMs(d) : 0;
  });
  protected readonly notes = computed(() => {
    const d = this.store.doc();
    return d ? noteCount(d) : 0;
  });
  /** The PDF is being made or written. */
  protected readonly exportingPdf = computed(() => {
    const d = this.store.doc();
    return !!d && this.exporter.isBusy(scorePdfKey(d.id));
  });
  protected readonly canZoomIn = computed(() => this.store.zoom() < SCORE_ZOOM_STEPS.at(-1)!);
  protected readonly canZoomOut = computed(() => this.store.zoom() > SCORE_ZOOM_STEPS[0]);
  /** Pickup lengths the time signature allows, in half beats (0 = none). */
  protected readonly pickupOptions = computed(() => {
    const d = this.store.doc();
    if (!d) return [];
    const bar = barTicks(d);
    const out = [{ ticks: 0, label: this.i18n.t('score.pickupNone') }];
    for (let t = 240; t < bar; t += 240) out.push({ ticks: t, label: this.i18n.plural('score.pickupBeats', t / 480) });
    return out;
  });
  /** Where the repeat sign is, for the panel that shows the selected one. */
  protected readonly repeatLabel = computed(() => {
    const d = this.store.doc();
    if (!d || d.repeat_bar === null) return '';
    const n = barLabel(d, d.repeat_bar);
    return n === null ? this.i18n.t('score.repeatAfterPickup') : this.i18n.t('score.repeatAfterBar', { n });
  });
  protected readonly canAddBar = computed(() => (this.store.doc()?.bars ?? MAX_BARS) < MAX_BARS);
  protected readonly selectedLabel = computed(() => {
    const ref = this.store.selectedNote();
    if (!ref) return '';
    const names = parseNoteNames(this.i18n.t('music.noteNames'));
    const kind = notatedValue(ref.note.duration_ticks)?.kind ?? 'quarter';
    return this.i18n.t('score.selected', {
      note: spelledNoteName(ref.note.key, ref.note.accidental, names),
      value: this.i18n.t(`score.values.${kind === 'thirtysecond' ? 'sixteenth' : kind}`),
    });
  });

  constructor() {
    void this.open();
    inject(DestroyRef).onDestroy(() => void this.store.flush());
  }

  /** Refreshes the list and opens the last score. */
  private async open(): Promise<void> {
    await this.store.refreshList();
    if (this.store.selectedId()) await this.store.reload();
    else {
      const first = this.store.scores()[0];
      if (first) await this.store.select(first.id);
    }
  }

  protected valueLabel(kind: NoteKind): string {
    return this.i18n.t(`score.values.${kind === 'thirtysecond' ? 'sixteenth' : kind}` as 'score.values.quarter');
  }

  protected saveTitle(input: HTMLInputElement): void {
    const d = this.store.doc();
    if (!d) return;
    if (!input.value.trim()) input.value = d.title;
    else this.store.rename(input.value);
  }

  protected setBpm(input: HTMLInputElement): void {
    const d = this.store.doc();
    if (!d) return;
    this.store.setBpm(+input.value);
    input.value = String(this.store.doc()?.bpm ?? d.bpm);
  }

  protected setMeter(value: string): void {
    const [beats, unit] = value.split('/').map(Number);
    this.store.setTimeSignature(beats, unit);
  }

  protected async deleteScore(): Promise<void> {
    const d = this.store.doc();
    if (!d) return;
    const warning = await this.store.usageWarning();
    const ok = await this.confirm.ask({
      title: this.i18n.t('score.delete'),
      message: [this.i18n.t('score.deleteMessage', { title: d.title }), warning].filter(Boolean).join(' '),
      confirmLabel: this.i18n.t('score.delete'),
    });
    if (ok) await this.store.remove(d.id);
  }

  protected zoom(direction: 1 | -1): void {
    const steps: readonly number[] = SCORE_ZOOM_STEPS;
    const i = steps.indexOf(this.store.zoom());
    this.store.zoom.set(steps[Math.min(steps.length - 1, Math.max(0, (i < 0 ? 2 : i) + direction))]);
  }

  /** Starts dragging the repeat sign from the palette; the staff takes the drop (or a click just chooses it). */
  protected startRepeatDrag(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    this.store.repeatDrag.set(true);
  }

  /** Starts dragging a note value from the palette; the staff takes the drop (or a click just chooses it). */
  protected startDrag(ev: PointerEvent, kind: NoteKind): void {
    if (ev.button !== 0) return;
    this.store.paletteDrag.set({ kind, dotted: this.store.dotted() && canDot(kind) });
  }
}
