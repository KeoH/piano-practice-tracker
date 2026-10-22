import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  MAX_TRACKS,
  type ClipRef,
  audible,
  clipCount,
  clipEnd,
  findClip,
  fitStart,
  maxRepeats,
  snapMs,
  snapTargets,
  trackRgb,
  trimClip,
} from '../../core/composition';
import { CompositionStore } from '../../core/composition.store';
import { ConfirmService } from '../../core/confirm.service';
import { clamp, formatMs } from '../../core/format';
import { programKey } from '../../core/gm';
import { I18nService } from '../../core/i18n/i18n.service';
import type { MessageKey } from '../../core/i18n/languages';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { CompositionClipDto, CompositionTrackDto } from '../../core/models';
import { PlaybackStore } from '../../core/playback.store';
import { ClipRollComponent } from '../clip-roll/clip-roll.component';
import { IconComponent } from '../icon/icon.component';

/** Width of the track headers (sticky on the left). */
export const HEADER_W = 220;
const RULER_H = 30;
const ROW_H = 96;
/** Ruler steps in seconds: the first one at least `MIN_TICK_PX` apart. */
const TICK_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300];
const MIN_TICK_PX = 64;
/** Snapping reach, in px. */
const SNAP_PX = 8;
const DRAG_THRESHOLD_PX = 4;
/** Room left after the last clip, to drop more. */
const TAIL_MS = 30_000;
const MIN_LOOP_MS = 500;

type ClipDragKind = 'move' | 'start' | 'end' | 'repeat';

interface ClipDrag {
  kind: ClipDragKind;
  pointerId: number;
  x0: number;
  y0: number;
  moved: boolean;
  origin: ClipRef;
}

/** Where the dragged clip would land. */
interface ClipPreview {
  clipId: string;
  track: number;
  clip: CompositionClipDto;
  copy: boolean;
}

interface ClipView {
  clip: CompositionClipDto;
  x: number;
  w: number;
  selected: boolean;
  dragging: boolean;
  /** Fragment being dropped from the library. */
  ghost: boolean;
  /** Seams between repeats, in % of the clip's width. */
  seams: number[];
  label: string;
}

interface RowView {
  track: CompositionTrackDto;
  index: number;
  rgb: string;
  audible: boolean;
  clips: ClipView[];
}

/**
 * Multitrack timeline of the composer: ruler (click to seek, drag to set the loop), one row per
 * track with its header (name, M/S, instrument, volume) and its clips, and a row to drop a
 * fragment on a new track. Clips are moved (Alt copies), trimmed by their edges and repeated with
 * the tab on their top-right corner; everything snaps to clip edges and the playhead.
 */
@Component({
  selector: 'app-composer-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, ClipRollComponent, TranslatePipe],
  host: {
    class: 'block',
    '(window:pointermove)': 'libraryMove($event)',
    '(window:pointerup)': 'libraryUp()',
    '(window:pointercancel)': 'libraryCancel()',
  },
  templateUrl: './composer-timeline.component.html',
})
export class ComposerTimelineComponent {
  protected readonly store = inject(CompositionStore);
  protected readonly playback = inject(PlaybackStore);
  protected readonly i18n = inject(I18nService);
  private readonly confirm = inject(ConfirmService);

  protected readonly HEADER_W = HEADER_W;
  protected readonly RULER_H = RULER_H;
  protected readonly ROW_H = ROW_H;
  protected readonly MAX_TRACKS = MAX_TRACKS;
  protected readonly programKey = programKey;
  protected readonly emptySteps: { title: MessageKey; body: MessageKey }[] = [
    { title: 'composer.empty.step1Title', body: 'composer.empty.step1Body' },
    { title: 'composer.empty.step2Title', body: 'composer.empty.step2Body' },
    { title: 'composer.empty.step3Title', body: 'composer.empty.step3Body' },
  ];
  protected readonly formatMs = formatMs;

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly tracksEl = viewChild<ElementRef<HTMLElement>>('tracks');
  private readonly viewW = signal(0);

  private drag: ClipDrag | null = null;
  protected readonly preview = signal<ClipPreview | null>(null);
  /** Library fragment drop: track (`tracks.length` = a new one) and start. */
  protected readonly drop = signal<{ track: number; start: number } | null>(null);
  private rulerDrag: { pointerId: number; x0: number; ms0: number; moved: boolean } | null = null;
  protected readonly loopDraft = signal<{ start: number; end: number } | null>(null);

  protected readonly pxPerMs = computed(() => this.store.zoom() / 1000);
  protected readonly empty = computed(() => {
    const d = this.store.doc();
    return !d || clipCount(d) === 0;
  });
  protected readonly laneW = computed(() => {
    const px = this.pxPerMs();
    const content = (Math.max(this.store.duration(), this.store.position()) + TAIL_MS) * px;
    return Math.max(this.viewW() - HEADER_W, content);
  });
  private readonly tickStepS = computed(() => TICK_STEPS_S.find((s) => s * this.store.zoom() >= MIN_TICK_PX) ?? TICK_STEPS_S.at(-1)!);
  protected readonly ticks = computed(() => {
    const step = this.tickStepS() * 1000;
    const px = this.pxPerMs();
    const out: { x: number; label: string }[] = [];
    for (let t = 0; t * px <= this.laneW(); t += step) out.push({ x: t * px, label: formatMs(t) });
    return out;
  });
  protected readonly gridPx = computed(() => this.tickStepS() * this.store.zoom());
  protected readonly playX = computed(() => this.store.position() * this.pxPerMs());
  protected readonly loopBar = computed(() => {
    const l = this.loopDraft() ?? this.playback.loopFor(this.store.key());
    const px = this.pxPerMs();
    return l ? { x: l.start * px, w: Math.max(2, (l.end - l.start) * px) } : null;
  });

  protected readonly rows = computed<RowView[]>(() => {
    const d = this.store.doc();
    if (!d) return [];
    const px = this.pxPerMs();
    const p = this.preview();
    const selected = this.store.selectedClipId();
    const drop = this.drop();
    const dragged = this.store.libraryDrag();
    const sounds = audible(d.tracks);
    const view = (clip: CompositionClipDto, track: CompositionTrackDto, extra: Partial<ClipView> = {}): ClipView => {
      const seams: number[] = [];
      for (let r = 1; r < clip.repeats; r++) seams.push((r / clip.repeats) * 100);
      return {
        clip,
        x: clip.start_ms * px,
        w: Math.max(6, (clipEnd(clip) - clip.start_ms) * px - 2),
        selected: clip.id === selected,
        dragging: false,
        ghost: false,
        seams,
        label: this.i18n.t('composer.clipLabel', {
          title: clip.fragment_title,
          track: track.name,
          start: formatMs(clip.start_ms, true),
        }),
        ...extra,
      };
    };
    return d.tracks.map((track, index) => {
      const clips = track.clips.filter((c) => !p || p.copy || c.id !== p.clipId).map((c) => view(c, track));
      if (p && p.track === index) clips.push(view(p.clip, track, { dragging: true, selected: true }));
      if (drop && dragged && drop.track === index) {
        const ghost: CompositionClipDto = {
          id: 'drop',
          fragment_id: dragged.id,
          start_ms: drop.start,
          trim_start_ms: 0,
          length_ms: dragged.duration_ms,
          repeats: 1,
          transpose: 0,
          fragment_title: dragged.title,
          fragment_file_path: dragged.file_path,
          fragment_duration_ms: dragged.duration_ms,
        };
        clips.push(view(ghost, track, { ghost: true }));
      }
      return { track, index, rgb: trackRgb(track), audible: sounds[index], clips };
    });
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() => {
      const ro = new ResizeObserver(() => this.viewW.set(this.scroller()?.nativeElement.clientWidth ?? 0));
      ro.observe(host.nativeElement);
      destroyRef.onDestroy(() => ro.disconnect());
    });
    // Notes for the clips' piano rolls
    effect(() => {
      const files = new Set<string>();
      for (const t of this.store.doc()?.tracks ?? []) for (const c of t.clips) files.add(c.fragment_file_path);
      untracked(() => files.forEach((f) => this.store.ensureNotes(f)));
    });
    // Keeps the playhead in view while it plays
    effect(() => {
      const x = this.playX();
      if (!this.store.playing()) return;
      const el = untracked(() => this.scroller()?.nativeElement);
      if (!el) return;
      const visible = el.clientWidth - HEADER_W;
      if (x < el.scrollLeft || x > el.scrollLeft + visible - 40) el.scrollLeft = Math.max(0, x - 80);
    });
  }

  // ---- Geometry ----

  private msAt(clientX: number): number {
    const el = this.scroller()?.nativeElement;
    if (!el) return 0;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - HEADER_W;
    return Math.max(0, x / this.pxPerMs());
  }

  /** Row under the pointer (may be `tracks.length`, the "new track" row, or beyond). */
  private rowAt(clientY: number): number {
    const el = this.tracksEl()?.nativeElement;
    if (!el) return 0;
    return Math.floor((clientY - el.getBoundingClientRect().top) / ROW_H);
  }

  private snap(ms: number, excludeId: string | null): number {
    const d = this.store.doc();
    if (!d) return Math.max(0, ms);
    return snapMs(ms, this.store.snap(), snapTargets(d, excludeId, [this.store.position()]), SNAP_PX / this.pxPerMs());
  }

  /** Snaps a clip of `length` by whichever edge is nearer a target; otherwise to the grid. */
  private snapSpan(start: number, length: number, excludeId: string | null): number {
    const d = this.store.doc();
    const mode = this.store.snap();
    const threshold = SNAP_PX / this.pxPerMs();
    if (!d || mode === 'off') return snapMs(start, 'off', [], threshold);
    let best: number | null = null;
    let bestDist = threshold;
    for (const t of snapTargets(d, excludeId, [this.store.position()])) {
      if (Math.abs(t - start) <= bestDist) {
        best = t;
        bestDist = Math.abs(t - start);
      }
      if (Math.abs(t - (start + length)) <= bestDist) {
        best = t - length;
        bestDist = Math.abs(t - (start + length));
      }
    }
    return best !== null ? Math.max(0, best) : snapMs(start, mode, [], threshold);
  }

  // ---- Clips ----

  protected clipDown(ev: PointerEvent, clipId: string, kind: ClipDragKind): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const origin = findClip(this.store.doc(), clipId);
    if (!origin) return;
    this.store.selectClip(clipId);
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.drag = { kind, pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, moved: kind !== 'move', origin };
  }

  protected clipMove(ev: PointerEvent): void {
    const drag = this.drag;
    const d = this.store.doc();
    if (!drag || !d || drag.pointerId !== ev.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const c = drag.origin.clip;
    const delta = (ev.clientX - drag.x0) / this.pxPerMs();
    const span = this.store.spanOf(c.id);
    let next: CompositionClipDto;
    let track = drag.origin.track;
    switch (drag.kind) {
      case 'move': {
        track = clamp(this.rowAt(ev.clientY), 0, d.tracks.length - 1);
        const length = clipEnd(c) - c.start_ms;
        const others = d.tracks[track].clips.filter((k) => ev.altKey || k.id !== c.id);
        const start = fitStart(others, this.snapSpan(c.start_ms + delta, length, c.id), length);
        next = { ...c, start_ms: start };
        break;
      }
      case 'start': {
        const edge = this.snap(c.start_ms + delta, c.id);
        next = trimClip(c, 'start', edge - c.start_ms, span);
        break;
      }
      case 'end': {
        const edge = this.snap(clipEnd(c) + delta, c.id);
        next = trimClip(c, 'end', (edge - clipEnd(c)) / c.repeats, span);
        break;
      }
      case 'repeat': {
        const total = clipEnd(c) + delta - c.start_ms;
        next = { ...c, repeats: clamp(Math.round(total / c.length_ms), 1, maxRepeats(c, span)) };
        break;
      }
    }
    this.preview.set({ clipId: c.id, track, clip: next, copy: drag.kind === 'move' && ev.altKey });
  }

  protected clipUp(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    this.drag = null;
    const p = this.preview();
    this.preview.set(null);
    if (!drag.moved || !p) return;
    if (drag.kind === 'move') this.store.moveClip(p.clipId, p.track, p.clip.start_ms, p.copy);
    else this.store.replaceClip(p.clipId, p.clip);
  }

  protected clipCancel(): void {
    this.drag = null;
    this.preview.set(null);
  }

  /** Click on an empty part of a lane: seek there and make the track the active one. */
  protected laneDown(ev: PointerEvent, track: number): void {
    if (ev.button !== 0 || ev.target !== ev.currentTarget) return;
    this.store.activeTrack.set(track);
    void this.store.seek(this.snap(this.msAt(ev.clientX), null));
  }

  // ---- Ruler: seek and loop ----

  protected rulerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.rulerDrag = { pointerId: ev.pointerId, x0: ev.clientX, ms0: this.snap(this.msAt(ev.clientX), null), moved: false };
  }

  protected rulerMove(ev: PointerEvent): void {
    const r = this.rulerDrag;
    if (!r || r.pointerId !== ev.pointerId) return;
    if (!r.moved && Math.abs(ev.clientX - r.x0) < DRAG_THRESHOLD_PX) return;
    r.moved = true;
    const ms = this.snap(this.msAt(ev.clientX), null);
    this.loopDraft.set({ start: Math.min(r.ms0, ms), end: Math.max(r.ms0, ms) });
  }

  protected rulerUp(ev: PointerEvent): void {
    const r = this.rulerDrag;
    if (!r || r.pointerId !== ev.pointerId) return;
    this.rulerDrag = null;
    const draft = this.loopDraft();
    this.loopDraft.set(null);
    const key = this.store.key();
    if (!key) return;
    if (!r.moved) {
      void this.store.seek(r.ms0);
      return;
    }
    if (draft && draft.end - draft.start >= MIN_LOOP_MS) void this.playback.setLoop(key, draft.start, draft.end);
  }

  // ---- Library drops (the library starts the drag, the timeline places it) ----

  protected libraryMove(ev: PointerEvent): void {
    const frag = this.store.libraryDrag();
    const d = this.store.doc();
    const el = this.scroller()?.nativeElement;
    if (!frag || !d || !el) return;
    const r = el.getBoundingClientRect();
    const tracks = this.tracksEl()?.nativeElement.getBoundingClientRect();
    if (!tracks || ev.clientX < r.left + HEADER_W || ev.clientX > r.right || ev.clientY < tracks.top || ev.clientY > r.bottom) {
      this.drop.set(null);
      return;
    }
    let track = this.rowAt(ev.clientY);
    // An empty composition takes it on its first track, wherever it is dropped.
    if (this.empty() && d.tracks.length) track = 0;
    track = clamp(track, 0, Math.min(d.tracks.length, MAX_TRACKS - 1));
    const length = frag.duration_ms;
    const target = d.tracks[track]?.clips ?? [];
    this.drop.set({ track, start: fitStart(target, this.snapSpan(this.msAt(ev.clientX), length, null), length) });
  }

  protected libraryUp(): void {
    const frag = this.store.libraryDrag();
    if (!frag) return;
    const drop = this.drop();
    this.drop.set(null);
    this.store.libraryDrag.set(null);
    if (drop) this.store.addFragment(frag, drop.track, drop.start);
  }

  protected libraryCancel(): void {
    this.drop.set(null);
    this.store.libraryDrag.set(null);
  }

  // ---- Tracks ----

  protected rename(index: number, input: HTMLInputElement): void {
    const t = this.store.doc()?.tracks[index];
    if (!t) return;
    if (!input.value.trim()) input.value = t.name;
    else this.store.renameTrack(index, input.value);
  }

  protected async removeTrack(row: RowView): Promise<void> {
    if (row.track.clips.length) {
      const ok = await this.confirm.ask({
        title: this.i18n.t('composer.removeTrack'),
        message: this.i18n.plural('composer.removeTrackMessage', row.track.clips.length, { name: row.track.name }),
        confirmLabel: this.i18n.t('composer.removeTrack'),
      });
      if (!ok) return;
    }
    this.store.removeTrack(row.index);
  }
}
