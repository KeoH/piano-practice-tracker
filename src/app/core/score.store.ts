import { Injectable, computed, inject, signal } from '@angular/core';
import { newId } from './composition';
import { I18nService } from './i18n/i18n.service';
import type { Accidental, ScoreDto, ScoreSummaryDto } from './models';
import type { NoteKind } from './music';
import { ChallengeStore } from './challenge.store';
import { CompositionStore } from './composition.store';
import { NavStore } from './nav.store';
import { PlaybackStore } from './playback.store';
import {
  type NoteMove,
  type StaffName,
  canDot,
  canPlace,
  chordDuration,
  durationTicks,
  findNote,
  moveNote,
  msToTicks,
  pageTick,
  pitchAt,
  place,
  removeNote,
  resizeBars,
  scoreKey,
  scoreTicks,
  setBpm,
  setNoteDuration,
  setPickup,
  setTimeSignature,
  shiftStep,
  summarizeScore,
  toggleAccidental,
  toggleRepeat,
  toggleTie,
  validateScore,
} from './score';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/** Zoom levels of the staff, in pixels per quarter note. */
export const SCORE_ZOOM_STEPS = [48, 64, 80, 96, 128] as const;
const DEFAULT_ZOOM = 80;

/** A note value being dragged from the palette onto the staff. */
export interface PaletteDrag {
  kind: NoteKind;
  dotted: boolean;
}

/** Edits that can be undone. */
const HISTORY_LIMIT = 50;
/** Edits are saved this long after the last one. */
const SAVE_DELAY_MS = 400;

/**
 * The score editor: list of scores, the open one (`doc`) with its undo history, the selected note
 * and the tool (note value, dot, accidental). The document is edited locally and saved whole, a
 * moment after the last edit; saving regenerates the library fragment on the backend. Playback
 * uses the notes as they are in the editor, saved or not.
 */
@Injectable({ providedIn: 'root' })
export class ScoreStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly playback = inject(PlaybackStore);
  private readonly compositions = inject(CompositionStore);
  private readonly challenges = inject(ChallengeStore);
  private readonly nav = inject(NavStore);

  readonly scores = signal<ScoreSummaryDto[]>([]);
  readonly listLoading = signal(false);
  readonly filter = signal('');
  readonly selectedId = signal<string | null>(null);
  readonly doc = signal<ScoreDto | null>(null);
  readonly loading = signal(false);
  readonly selectedNoteId = signal<string | null>(null);

  /** The note value that is placed next. */
  readonly kind = signal<NoteKind>('quarter');
  readonly dotted = signal(false);
  /** Staff zoom in pixels per quarter note. */
  readonly zoom = signal<number>(DEFAULT_ZOOM);
  /** Value being dragged from the palette (the staff listens for the drop). */
  readonly paletteDrag = signal<PaletteDrag | null>(null);
  /** Spelling of the black keys that are placed next (and of the selected note when it changes). */
  readonly accidental = signal<Accidental | null>(null);

  private readonly past = signal<ScoreDto[]>([]);
  private readonly future = signal<ScoreDto[]>([]);
  readonly canUndo = computed(() => this.past().length > 0);
  readonly canRedo = computed(() => this.future().length > 0);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();
  private loadRequest = 0;

  readonly key = computed(() => {
    const id = this.doc()?.id;
    return id ? scoreKey(id) : null;
  });
  readonly playing = computed(() => this.playback.isPlaying(this.key()));
  /** Playhead in milliseconds and in ticks. */
  readonly position = computed(() => this.playback.positionFor(this.key()));
  readonly positionTicks = computed(() => {
    const d = this.doc();
    return d ? pageTick(d, msToTicks(this.position(), d.bpm)) : 0;
  });
  readonly selectedNote = computed(() => findNote(this.doc(), this.selectedNoteId()));
  /** Length of the note that is placed next. */
  readonly toolTicks = computed(() => durationTicks(this.kind(), this.dotted() && canDot(this.kind())));
  readonly filteredScores = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.scores();
    return q ? list.filter((s) => s.title.toLowerCase().includes(q)) : list;
  });

  constructor() {
    this.playback.registerScoreSource((id) => {
      const d = this.doc();
      return d && d.id === id ? d : null;
    });
  }

  // ---- List and document ----

  reset(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
    this.loadRequest++;
    this.scores.set([]);
    this.selectedId.set(null);
    this.doc.set(null);
    this.selectedNoteId.set(null);
    this.clearHistory();
  }

  async refreshList(): Promise<void> {
    if (!this.api.available) return;
    this.listLoading.set(true);
    try {
      this.scores.set(await this.api.getScores());
    } catch (err) {
      this.toast.error(err, this.i18n.t('score.errors.loadList'));
    } finally {
      this.listLoading.set(false);
    }
  }

  async select(id: string | null): Promise<void> {
    if (id === this.selectedId() && this.doc()?.id === id) return;
    await this.flush();
    this.selectedId.set(id);
    this.doc.set(null);
    this.selectedNoteId.set(null);
    this.clearHistory();
    if (id) await this.reload();
  }

  /** Reloads the open score from the vault and forgets the undo history. */
  async reload(): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    await this.flush();
    const req = ++this.loadRequest;
    this.loading.set(true);
    try {
      const d = await this.api.getScore(id);
      if (req !== this.loadRequest || this.selectedId() !== id) return;
      this.doc.set(d);
      this.clearHistory();
      if (!findNote(d, this.selectedNoteId())) this.selectedNoteId.set(null);
    } catch (err) {
      this.toast.error(err, this.i18n.t('score.errors.load'));
    } finally {
      if (req === this.loadRequest) this.loading.set(false);
    }
  }

  async create(): Promise<void> {
    await this.flush();
    try {
      const s = await this.api.createScore('');
      this.loadRequest++;
      this.selectedId.set(s.id);
      this.doc.set(s);
      this.selectedNoteId.set(null);
      this.clearHistory();
      await this.refreshList();
    } catch (err) {
      this.toast.error(err, this.i18n.t('score.errors.create'));
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.playback.stopIfActive(scoreKey(id));
      if (this.selectedId() === id) {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.dirty = false;
      }
      await this.api.deleteScore(id);
      if (this.selectedId() === id) await this.select(null);
      await this.refreshList();
      this.toast.success(this.i18n.t('score.deleted'));
    } catch (err) {
      this.toast.error(err, this.i18n.t('score.errors.delete'));
    }
  }

  /** Sentence for the delete confirmation when compositions use the score: they lose those clips. */
  async usageWarning(): Promise<string> {
    const fragment = this.doc()?.fragment_id;
    return fragment ? this.compositions.usageWarning([fragment]) : '';
  }

  /** Copies the score's fragment as a challenge melody and opens it in the Challenges view. */
  async useAsChallenge(): Promise<void> {
    await this.flush();
    const fragmentId = this.doc()?.fragment_id;
    if (!fragmentId) return;
    const melody = await this.challenges.createFromFragment({ id: fragmentId });
    if (!melody) return;
    this.nav.view.set('challenges');
    await this.challenges.select(melody.id);
  }

  // ---- Editing, history and saving ----

  /** Applies an edit (undoable) and schedules the save; the playing score hears it at once. */
  private update(fn: (d: ScoreDto) => ScoreDto | null): boolean {
    const d = this.doc();
    if (!d) return false;
    const next = fn(d);
    if (!next || next === d) return false;
    this.past.update((p) => [...p.slice(-(HISTORY_LIMIT - 1)), d]);
    this.future.set([]);
    this.commit(next);
    return true;
  }

  private commit(next: ScoreDto): void {
    this.doc.set(next);
    this.dirty = true;
    this.scheduleSave();
    if (this.api.available && this.playback.activeFile() === this.key()) void this.api.updateScorePlayback(next).catch(() => undefined);
  }

  private clearHistory(): void {
    this.past.set([]);
    this.future.set([]);
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

  private restore(d: ScoreDto): void {
    if (!findNote(d, this.selectedNoteId())) this.selectedNoteId.set(null);
    this.commit(d);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.queueSave();
    }, SAVE_DELAY_MS);
  }

  /** Saves pending edits now (before switching scores or leaving the view). */
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
      const saved = await this.api.saveScore(sent);
      // Edits made meanwhile win; they will be saved next. The stored copy only adds the fragment id.
      if (this.doc() === sent) this.doc.set(saved);
      else if (this.doc()?.id === saved.id) this.doc.update((d) => (d ? { ...d, fragment_id: saved.fragment_id } : d));
      this.scores.update((list) => [summarizeScore(saved), ...list.filter((s) => s.id !== saved.id)]);
    } catch (err) {
      this.toast.error(err, this.i18n.t('score.errors.save'));
      if (this.selectedId() === sent.id) {
        const req = ++this.loadRequest;
        try {
          const fresh = await this.api.getScore(sent.id);
          if (req === this.loadRequest) {
            this.doc.set(fresh);
            this.clearHistory();
          }
        } catch {
          // The error above is already shown.
        }
      }
    }
  }

  rename(title: string): void {
    const t = title.trim();
    if (t) this.update((d) => (d.title === t ? null : { ...d, title: t }));
  }

  setBpm(bpm: number): void {
    this.update((d) => setBpm(d, bpm));
  }

  setBars(bars: number): void {
    const d = this.doc();
    if (!d) return;
    if (!this.update((doc) => resizeBars(doc, bars))) {
      if (Math.round(bars) !== d.bars) this.toast.warning(this.i18n.t('score.cantResize'));
    }
  }

  setTimeSignature(beats: number, beatUnit: number): void {
    const d = this.doc();
    if (!d || (d.beats === beats && d.beat_unit === beatUnit)) return;
    if (!this.update((doc) => setTimeSignature(doc, beats, beatUnit))) this.toast.warning(this.i18n.t('score.cantChangeMeter'));
  }

  // ---- Tool ----

  setKind(kind: NoteKind): void {
    this.kind.set(kind);
    if (!canDot(kind)) this.dotted.set(false);
  }

  toggleDotted(): void {
    if (canDot(this.kind())) this.dotted.update((v) => !v);
  }

  /** Sharp or flat: for the notes placed next and for the selected note. */
  toggleAccidental(accidental: Accidental): void {
    this.accidental.update((a) => (a === accidental ? null : accidental));
    const id = this.selectedNoteId();
    if (id) this.update((d) => toggleAccidental(d, id, accidental));
  }

  // ---- Notes ----

  selectNote(id: string | null): void {
    this.selectedNoteId.set(id);
  }

  /** Whether a note of the current value fits at `tick` on `staff` (where notes start it joins them as a chord). */
  fits(staff: StaffName, tick: number): boolean {
    const d = this.doc();
    return !!d && canPlace(d, staff, tick, chordDuration(d, staff, tick) ?? this.toolTicks());
  }

  /** Puts a note of the current value at `tick`, on the line or space `step` of `staff`. */
  placeNote(staff: StaffName, tick: number, step: number): boolean {
    const d = this.doc();
    const pitch = pitchAt(staff, step, this.accidental());
    if (!d || !pitch) return false;
    const id = newId();
    // Where notes already start, the new one joins them as a chord and takes their value.
    const duration = chordDuration(d, staff, tick) ?? this.toolTicks();
    const placed = this.update((doc) =>
      place(doc, staff, { id, tick, duration_ticks: duration, key: pitch.key, accidental: pitch.accidental, tie: false }),
    );
    if (!placed) {
      this.toast.warning(this.i18n.t('score.noRoom'));
      return false;
    }
    this.selectedNoteId.set(id);
    this.audition(pitch.key);
    return true;
  }

  /** Moves a note to `tick` and `step` of `staff` (either hand). */
  moveTo(id: string, staff: StaffName, tick: number, step: number): boolean {
    const ref = findNote(this.doc(), id);
    if (!ref) return false;
    const pitch = pitchAt(staff, step, ref.note.accidental);
    if (!pitch) return false;
    const change: NoteMove = { tick, pitch, staff };
    const unchanged = ref.staff === staff && ref.note.tick === tick && ref.note.key === pitch.key;
    if (unchanged) return true;
    const moved = this.update((d) => moveNote(d, id, change));
    if (moved && pitch.key !== ref.note.key) this.audition(pitch.key);
    return moved;
  }

  removeSelected(): void {
    const id = this.selectedNoteId();
    if (id && this.update((d) => removeNote(d, id))) this.selectedNoteId.set(null);
  }

  /** The selected note takes the current value (if it fits). */
  applyToolToSelected(): void {
    const id = this.selectedNoteId();
    if (!id) return;
    if (!this.update((d) => setNoteDuration(d, id, this.toolTicks()))) this.toast.warning(this.i18n.t('score.noRoom'));
  }

  /** Ties the selected note to the next one of the same pitch (adding it if it is not there), or unties it. */
  toggleTieSelected(): void {
    const id = this.selectedNoteId();
    if (!id) return;
    if (!this.update((d) => toggleTie(d, id, newId()))) this.toast.warning(this.i18n.t('score.noRoomTie'));
  }

  /** Closes the score with a repeat sign, so it is played twice from the start, or takes it away. */
  toggleRepeat(): void {
    this.update((d) => toggleRepeat(d));
  }

  /** Makes the first bar shorter (an anacrusis) or whole again (0 ticks). */
  setPickup(ticks: number): void {
    const d = this.doc();
    if (!d || d.pickup_ticks === ticks) return;
    if (!this.update((doc) => setPickup(doc, ticks))) this.toast.warning(this.i18n.t('score.cantChangePickup'));
  }

  /** Arrow keys: a line or space up or down. */
  shiftSelected(delta: number): void {
    const id = this.selectedNoteId();
    if (!id) return;
    const before = findNote(this.doc(), id);
    if (!this.update((d) => shiftStep(d, id, delta))) return;
    const after = findNote(this.doc(), id);
    if (after && after.note.key !== before?.note.key) this.audition(after.note.key);
  }

  /** Arrow keys: a grid step earlier or later. */
  nudgeSelected(deltaTicks: number): void {
    const ref = this.selectedNote();
    if (!ref) return;
    this.update((d) => moveNote(d, ref.note.id, { tick: ref.note.tick + deltaTicks }));
  }

  /** Plays the key while nothing else plays, so placing notes while listening is not interrupted. */
  private audition(key: number): void {
    if (!this.api.available || this.playback.isPlaying(this.key())) return;
    void this.api.previewNote(key).catch(() => undefined);
  }

  // ---- Playback ----

  async togglePlay(): Promise<void> {
    const key = this.key();
    if (!key) return;
    const d = this.doc();
    const invalid = d ? validateScore(d).length > 0 : true;
    if (invalid) return;
    await this.playback.toggle(key);
  }

  async seekToTick(tick: number): Promise<void> {
    const key = this.key();
    const d = this.doc();
    if (!key || !d) return;
    const ms = Math.round((Math.max(0, Math.min(tick, scoreTicks(d))) * 60_000) / (480 * d.bpm));
    await this.playback.seek(key, ms);
  }

  async stop(): Promise<void> {
    const key = this.key();
    if (key) await this.playback.stop(key);
  }
}
