import { Injectable, computed, inject, signal } from '@angular/core';
import {
  MAX_REPEATS,
  MAX_TRACKS,
  MAX_TRANSPOSE,
  type SnapMode,
  clipEnd,
  clipFromFragment,
  compositionDuration,
  compositionKey,
  findClip,
  fitStart,
  freeSpan,
  maxRepeats,
  newId,
  newTrack,
  splitClip,
  trackMix,
  withTrackClips,
} from './composition';
import { clamp } from './format';
import { I18nService } from './i18n/i18n.service';
import type { CompositionClipDto, CompositionDto, CompositionSummaryDto, CompositionTrackDto, LibraryFragmentDto, MidiNotesDto } from './models';
import { PlaybackStore } from './playback.store';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/** Edits that can be undone. */
const HISTORY_LIMIT = 50;
/** Edits are saved this long after the last one. */
const SAVE_DELAY_MS = 400;
/** Timeline zoom levels, in px per second. */
export const ZOOM_STEPS = [4, 6, 8, 12, 16, 24, 32, 48] as const;
const DEFAULT_ZOOM = 12;

/**
 * The composer: list of compositions, the open one (`doc`) with its undo history, the selected
 * clip and the fragment library. The document is edited locally and saved whole, a moment after
 * the last edit; the mixer (volume, mute, solo) also reaches the player at once.
 */
@Injectable({ providedIn: 'root' })
export class CompositionStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly playback = inject(PlaybackStore);

  readonly compositions = signal<CompositionSummaryDto[]>([]);
  readonly listLoading = signal(false);
  readonly filter = signal('');
  readonly selectedId = signal<string | null>(null);
  readonly doc = signal<CompositionDto | null>(null);
  readonly loading = signal(false);
  readonly selectedClipId = signal<string | null>(null);
  /** Track that receives the fragments added from the keyboard. */
  readonly activeTrack = signal(0);
  readonly library = signal<LibraryFragmentDto[]>([]);
  readonly libraryLoading = signal(false);
  /** Notes per fragment file, for the clips' piano rolls. */
  readonly notes = signal<Record<string, MidiNotesDto>>({});
  /** Timeline zoom in px per second. */
  readonly zoom = signal<number>(DEFAULT_ZOOM);
  readonly snap = signal<SnapMode>('edges');
  /** Fragment being dragged from the library onto the timeline. */
  readonly libraryDrag = signal<LibraryFragmentDto | null>(null);

  private readonly past = signal<CompositionDto[]>([]);
  private readonly future = signal<CompositionDto[]>([]);
  readonly canUndo = computed(() => this.past().length > 0);
  readonly canRedo = computed(() => this.future().length > 0);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();
  private loadRequest = 0;
  private readonly notesRequested = new Set<string>();
  /** Document before a volume drag, so the whole drag is one undo step. */
  private beforeVolumeDrag: CompositionDto | null = null;

  /** Key of the open composition in the player. */
  readonly key = computed(() => {
    const id = this.doc()?.id;
    return id ? compositionKey(id) : null;
  });
  readonly duration = computed(() => {
    const d = this.doc();
    return d ? compositionDuration(d) : 0;
  });
  readonly selectedClip = computed(() => findClip(this.doc(), this.selectedClipId()));
  readonly position = computed(() => this.playback.positionFor(this.key()));
  readonly playing = computed(() => this.playback.isPlaying(this.key()));
  readonly filteredCompositions = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.compositions();
    return q ? list.filter((c) => c.title.toLowerCase().includes(q)) : list;
  });
  /** Clips per fragment in the open composition. */
  readonly uses = computed(() => {
    const out = new Map<string, number>();
    for (const t of this.doc()?.tracks ?? []) for (const c of t.clips) out.set(c.fragment_id, (out.get(c.fragment_id) ?? 0) + 1);
    return out;
  });

  // ---- List, document and library ----

  reset(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
    this.loadRequest++;
    this.compositions.set([]);
    this.selectedId.set(null);
    this.doc.set(null);
    this.selectedClipId.set(null);
    this.library.set([]);
    this.notes.set({});
    this.notesRequested.clear();
    this.clearHistory();
  }

  async refreshList(): Promise<void> {
    if (!this.api.available) return;
    this.listLoading.set(true);
    try {
      this.compositions.set(await this.api.getCompositions());
    } catch (err) {
      this.toast.error(err, this.i18n.t('composer.errors.loadList'));
    } finally {
      this.listLoading.set(false);
    }
  }

  async refreshLibrary(): Promise<void> {
    if (!this.api.available) return;
    this.libraryLoading.set(true);
    try {
      this.library.set(await this.api.getLibraryFragments());
    } catch (err) {
      this.toast.error(err, this.i18n.t('composer.errors.library'));
    } finally {
      this.libraryLoading.set(false);
    }
  }

  async select(id: string | null): Promise<void> {
    if (id === this.selectedId() && this.doc()?.id === id) return;
    await this.flush();
    this.selectedId.set(id);
    this.doc.set(null);
    this.selectedClipId.set(null);
    this.activeTrack.set(0);
    this.clearHistory();
    if (id) await this.reload();
  }

  /** Reloads the open composition from the vault (its fragments may have changed) and forgets
   *  the undo history, which could point to deleted fragments. */
  async reload(): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    await this.flush();
    const req = ++this.loadRequest;
    this.loading.set(true);
    try {
      const d = await this.api.getComposition(id);
      if (req !== this.loadRequest || this.selectedId() !== id) return;
      this.doc.set(d);
      this.clearHistory();
      if (!findClip(d, this.selectedClipId())) this.selectedClipId.set(null);
      this.activeTrack.update((t) => clamp(t, 0, Math.max(0, d.tracks.length - 1)));
    } catch (err) {
      this.toast.error(err, this.i18n.t('composer.errors.load'));
    } finally {
      if (req === this.loadRequest) this.loading.set(false);
    }
  }

  async create(): Promise<void> {
    await this.flush();
    try {
      const c = await this.api.createComposition('');
      this.loadRequest++;
      this.selectedId.set(c.id);
      this.doc.set(c);
      this.selectedClipId.set(null);
      this.activeTrack.set(0);
      this.clearHistory();
      await this.refreshList();
    } catch (err) {
      this.toast.error(err, this.i18n.t('composer.errors.create'));
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.playback.stopIfActive(compositionKey(id));
      if (this.selectedId() === id) {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.dirty = false;
      }
      await this.api.deleteComposition(id);
      if (this.selectedId() === id) await this.select(null);
      await this.refreshList();
      this.toast.success(this.i18n.t('composer.deleted'));
    } catch (err) {
      this.toast.error(err, this.i18n.t('composer.errors.delete'));
    }
  }

  /**
   * Sentence for a delete confirmation when the fragments (or the session's) are used in
   * compositions: deleting them removes those clips. Empty if they are not used.
   */
  async usageWarning(fragmentIds: string[], sessionId: string | null = null): Promise<string> {
    if (!this.api.available) return '';
    const n = await this.api.countCompositionUses(fragmentIds, sessionId).catch(() => 0);
    return n ? this.i18n.plural('composer.usedIn', n) : '';
  }

  /** Loads (once) the notes of a fragment file. */
  ensureNotes(file: string): void {
    if (!this.api.available || this.notesRequested.has(file)) return;
    this.notesRequested.add(file);
    this.api
      .getMidiNotes(file)
      .then((n) => this.notes.update((m) => ({ ...m, [file]: n })))
      .catch(() => this.notesRequested.delete(file));
  }

  // ---- Editing, history and saving ----

  /** Applies an edit to the document (undoable unless `history` is false) and schedules the save. */
  private update(fn: (d: CompositionDto) => CompositionDto | null, history = true): boolean {
    const d = this.doc();
    if (!d) return false;
    const next = fn(d);
    if (!next || next === d) return false;
    if (history) this.pushHistory(d);
    this.doc.set(next);
    this.dirty = true;
    this.scheduleSave();
    return true;
  }

  private pushHistory(d: CompositionDto): void {
    this.past.update((p) => [...p.slice(-(HISTORY_LIMIT - 1)), d]);
    this.future.set([]);
  }

  private clearHistory(): void {
    this.past.set([]);
    this.future.set([]);
    this.beforeVolumeDrag = null;
  }

  undo(): void {
    const d = this.doc();
    const prev = this.past().at(-1);
    if (!d || !prev) return;
    this.past.update((p) => p.slice(0, -1));
    this.future.update((f) => [...f, d]);
    this.restore(prev);
  }

  redo(): void {
    const d = this.doc();
    const next = this.future().at(-1);
    if (!d || !next) return;
    this.future.update((f) => f.slice(0, -1));
    this.past.update((p) => [...p, d]);
    this.restore(next);
  }

  private restore(d: CompositionDto): void {
    this.doc.set(d);
    if (!findClip(d, this.selectedClipId())) this.selectedClipId.set(null);
    this.activeTrack.update((t) => clamp(t, 0, Math.max(0, d.tracks.length - 1)));
    this.dirty = true;
    this.scheduleSave();
    this.applyMix();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.queueSave();
    }, SAVE_DELAY_MS);
  }

  /** Saves pending edits now (before switching compositions or leaving the view). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.queueSave();
    } else {
      await this.saveChain;
    }
  }

  /** Saves one at a time, so an older version never lands after a newer one. */
  private queueSave(): Promise<void> {
    this.saveChain = this.saveChain.then(() => this.save());
    return this.saveChain;
  }

  private async save(): Promise<void> {
    const sent = this.doc();
    if (!this.dirty || !sent) return;
    this.dirty = false;
    try {
      const saved = await this.api.saveComposition(sent);
      // Edits made meanwhile win; they will be saved next.
      if (this.doc() === sent) this.doc.set(saved);
      this.compositions.update((list) => {
        const summary: CompositionSummaryDto = {
          id: saved.id,
          title: saved.title,
          track_count: saved.tracks.length,
          clip_count: saved.tracks.reduce((n, t) => n + t.clips.length, 0),
          duration_ms: compositionDuration(saved),
          updated_at: saved.updated_at,
        };
        return [summary, ...list.filter((c) => c.id !== saved.id)];
      });
    } catch (err) {
      this.toast.error(err, this.i18n.t('composer.errors.save'));
      if (this.selectedId() === sent.id) {
        this.loadRequest++;
        const req = this.loadRequest;
        try {
          const fresh = await this.api.getComposition(sent.id);
          if (req === this.loadRequest) {
            this.doc.set(fresh);
            this.clearHistory();
            this.applyMix();
          }
        } catch {
          // The error above is already shown.
        }
      }
    }
  }

  /** Sends the mixer to the player (it applies it only if this composition is loaded there). */
  private applyMix(): void {
    const d = this.doc();
    if (!d || !this.api.available) return;
    void this.api.setCompositionMix(d.id, trackMix(d)).catch(() => undefined);
  }

  rename(title: string): void {
    const t = title.trim();
    if (!t) return;
    this.update((d) => (d.title === t ? null : { ...d, title: t }));
  }

  // ---- Tracks ----

  private updateTrack(index: number, fn: (t: CompositionTrackDto) => CompositionTrackDto | null, history = true): boolean {
    return this.update((d) => {
      const t = d.tracks[index];
      const next = t ? fn(t) : null;
      return next ? { ...d, tracks: d.tracks.map((x, i) => (i === index ? next : x)) } : null;
    }, history);
  }

  addTrack(): number | null {
    const d = this.doc();
    if (!d) return null;
    if (d.tracks.length >= MAX_TRACKS) {
      this.toast.warning(this.i18n.t('composer.tooManyTracks', { max: MAX_TRACKS }));
      return null;
    }
    const name = this.i18n.t('composer.trackName', { n: d.tracks.length + 1 });
    this.update((doc) => ({ ...doc, tracks: [...doc.tracks, newTrack(doc.tracks, name)] }));
    this.activeTrack.set(d.tracks.length);
    this.applyMix();
    return d.tracks.length;
  }

  removeTrack(index: number): void {
    const removedSelection = this.selectedClip()?.track === index;
    if (!this.update((d) => (d.tracks[index] ? { ...d, tracks: d.tracks.filter((_, i) => i !== index) } : null))) return;
    if (removedSelection) this.selectedClipId.set(null);
    this.activeTrack.update((t) => clamp(t > index ? t - 1 : t, 0, Math.max(0, (this.doc()?.tracks.length ?? 1) - 1)));
    this.applyMix();
  }

  renameTrack(index: number, name: string): void {
    const n = name.trim();
    if (n) this.updateTrack(index, (t) => (t.name === n ? null : { ...t, name: n }));
  }

  setProgram(index: number, program: number): void {
    const p = clamp(Math.round(program), 0, 127);
    this.updateTrack(index, (t) => (t.program === p ? null : { ...t, program: p }));
  }

  setSustain(index: number, sustain: boolean): void {
    this.updateTrack(index, (t) => (t.sustain === sustain ? null : { ...t, sustain }));
  }

  toggleMute(index: number): void {
    if (this.updateTrack(index, (t) => ({ ...t, muted: !t.muted }))) this.applyMix();
  }

  toggleSolo(index: number): void {
    if (this.updateTrack(index, (t) => ({ ...t, solo: !t.solo }))) this.applyMix();
  }

  /** Volume while the slider moves (`final` = released): the whole drag is one undo step. */
  setVolume(index: number, volume: number, final: boolean): void {
    const v = clamp(Math.round(volume), 0, 127);
    const before = this.doc();
    if (!this.beforeVolumeDrag && before) this.beforeVolumeDrag = before;
    this.updateTrack(index, (t) => (t.volume === v ? null : { ...t, volume: v }), false);
    this.applyMix();
    if (final) {
      const start = this.beforeVolumeDrag;
      this.beforeVolumeDrag = null;
      if (start && start !== this.doc()) this.pushHistory(start);
    }
  }

  // ---- Clips ----

  selectClip(id: string | null): void {
    this.selectedClipId.set(id);
    const ref = findClip(this.doc(), id);
    if (ref) this.activeTrack.set(ref.track);
  }

  /** Puts the fragment at `start` on `track` (after any clip it would overlap). A `track` past
   *  the last one creates a new track. */
  addFragment(fragment: LibraryFragmentDto, track: number, start: number): void {
    const d = this.doc();
    if (!d || fragment.duration_ms <= 0) return;
    const creating = track >= d.tracks.length;
    if (creating && d.tracks.length >= MAX_TRACKS) {
      this.toast.warning(this.i18n.t('composer.tooManyTracks', { max: MAX_TRACKS }));
      return;
    }
    const name = this.i18n.t('composer.trackName', { n: d.tracks.length + 1 });
    const index = creating ? d.tracks.length : Math.max(0, track);
    let clip: CompositionClipDto | null = null;
    const added = this.update((doc) => {
      const next = creating ? { ...doc, tracks: [...doc.tracks, newTrack(doc.tracks, name)] } : doc;
      clip = clipFromFragment(fragment, fitStart(next.tracks[index].clips, start, fragment.duration_ms));
      return withTrackClips(next, index, [...next.tracks[index].clips, clip]);
    });
    if (added && clip) this.selectClip((clip as CompositionClipDto).id);
    if (added && creating) this.applyMix();
  }

  /** Adds the fragment at the playhead on the active track. */
  addAtPlayhead(fragment: LibraryFragmentDto): void {
    const tracks = this.doc()?.tracks.length ?? 0;
    this.addFragment(fragment, tracks ? clamp(this.activeTrack(), 0, tracks - 1) : 0, this.position());
  }

  /** Moves (or copies) a clip to `track` at `start`, after any clip it would overlap there. */
  moveClip(clipId: string, track: number, start: number, copy = false): void {
    const ref = findClip(this.doc(), clipId);
    const d = this.doc();
    if (!ref || !d || !d.tracks[track]) return;
    const others = d.tracks[track].clips.filter((c) => copy || c.id !== clipId);
    const length = clipEnd(ref.clip) - ref.clip.start_ms;
    const placed: CompositionClipDto = { ...ref.clip, id: copy ? newId() : ref.clip.id, start_ms: fitStart(others, start, length) };
    if (!copy && track === ref.track && placed.start_ms === ref.clip.start_ms) return;
    const moved = this.update((doc) => {
      let next = doc;
      if (!copy) next = withTrackClips(next, ref.track, next.tracks[ref.track].clips.filter((c) => c.id !== clipId));
      return withTrackClips(next, track, [...next.tracks[track].clips.filter((c) => copy || c.id !== clipId), placed]);
    });
    if (moved) this.selectClip(placed.id);
  }

  /** Replaces a clip (same track) with `next`. */
  replaceClip(clipId: string, next: CompositionClipDto, history = true): void {
    const ref = findClip(this.doc(), clipId);
    if (!ref) return;
    const c = ref.clip;
    if (
      c.start_ms === next.start_ms &&
      c.trim_start_ms === next.trim_start_ms &&
      c.length_ms === next.length_ms &&
      c.repeats === next.repeats &&
      c.transpose === next.transpose
    ) {
      return;
    }
    this.update((d) => withTrackClips(d, ref.track, d.tracks[ref.track].clips.map((k) => (k.id === clipId ? next : k))), history);
  }

  /** Room around a clip on its track. */
  spanOf(clipId: string): { min: number; max: number } {
    const ref = findClip(this.doc(), clipId);
    const d = this.doc();
    return ref && d ? freeSpan(d.tracks[ref.track].clips, ref.clip) : { min: 0, max: Number.POSITIVE_INFINITY };
  }

  setRepeats(repeats: number): void {
    const ref = this.selectedClip();
    if (!ref) return;
    const max = maxRepeats(ref.clip, this.spanOf(ref.clip.id));
    const n = clamp(Math.round(repeats), 1, MAX_REPEATS);
    if (n > max) {
      this.toast.warning(this.i18n.t('composer.noRoom'));
      return;
    }
    this.replaceClip(ref.clip.id, { ...ref.clip, repeats: n });
  }

  transposeBy(delta: number): void {
    const ref = this.selectedClip();
    if (!ref) return;
    const t = clamp(ref.clip.transpose + delta, -MAX_TRANSPOSE, MAX_TRANSPOSE);
    this.replaceClip(ref.clip.id, { ...ref.clip, transpose: t });
  }

  splitSelected(): void {
    const ref = this.selectedClip();
    if (!ref) return;
    const result = splitClip(ref.clip, this.position());
    if (!result) {
      this.toast.warning(this.i18n.t('composer.cantSplit'));
      return;
    }
    const others = this.doc()!.tracks[ref.track].clips.filter((c) => c.id !== ref.clip.id);
    if (this.update((d) => withTrackClips(d, ref.track, [...others, ...result.clips]))) this.selectClip(result.clips[result.right].id);
  }

  duplicateSelected(): void {
    const ref = this.selectedClip();
    if (!ref) return;
    const length = clipEnd(ref.clip) - ref.clip.start_ms;
    const copy: CompositionClipDto = {
      ...ref.clip,
      id: newId(),
      start_ms: fitStart(this.doc()!.tracks[ref.track].clips, clipEnd(ref.clip), length),
    };
    if (this.update((d) => withTrackClips(d, ref.track, [...d.tracks[ref.track].clips, copy]))) this.selectClip(copy.id);
  }

  removeSelected(): void {
    const ref = this.selectedClip();
    if (!ref) return;
    if (this.update((d) => withTrackClips(d, ref.track, d.tracks[ref.track].clips.filter((c) => c.id !== ref.clip.id)))) {
      this.selectedClipId.set(null);
    }
  }

  /** Moves the selected clip `deltaMs` along its track, without crossing its neighbours. */
  nudgeSelected(deltaMs: number): void {
    const ref = this.selectedClip();
    if (!ref) return;
    const span = this.spanOf(ref.clip.id);
    const length = clipEnd(ref.clip) - ref.clip.start_ms;
    const start = clamp(ref.clip.start_ms + deltaMs, span.min, span.max - length);
    this.replaceClip(ref.clip.id, { ...ref.clip, start_ms: Math.round(start) });
  }

  // ---- Playback ----

  async togglePlay(): Promise<void> {
    const key = this.key();
    if (!key) return;
    await this.flush();
    await this.playback.toggle(key);
  }

  async seek(ms: number): Promise<void> {
    const key = this.key();
    if (key) await this.playback.seek(key, Math.max(0, ms));
  }

  async stop(): Promise<void> {
    const key = this.key();
    if (key) await this.playback.stop(key);
  }
}
