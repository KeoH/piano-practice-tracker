import { Injectable, computed, inject, signal } from '@angular/core';
import { newId } from './composition';
import { I18nService } from './i18n/i18n.service';
import type { Accidental, ScoreDto, ScoreSummaryDto } from './models';
import type { NoteKind } from './music';
import { ChallengeStore } from './challenge.store';
import { CompositionStore } from './composition.store';
import { ExportService, SCORES_PDF_KEY } from './export.service';
import { NavStore } from './nav.store';
import { PieceStore } from './piece.store';
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
  notatedValue,
  msToTicks,
  pageTick,
  performedTick,
  pitchAt,
  place,
  removeNote,
  resizeBars,
  scoreKey,
  scoreTicks,
  setBpm,
  setNoteDuration,
  setPickup,
  setRepeatBar,
  setTimeSignature,
  shiftStep,
  summarizeScore,
  toggleAccidental,
  toggleSlur,
  toggleSlurFrom,
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
  private readonly pieces = inject(PieceStore);
  private readonly exporter = inject(ExportService);

  readonly scores = signal<ScoreSummaryDto[]>([]);
  readonly listLoading = signal(false);
  readonly filter = signal('');
  readonly selectedId = signal<string | null>(null);
  readonly doc = signal<ScoreDto | null>(null);
  readonly loading = signal(false);
  readonly selectedNoteId = signal<string | null>(null);
  /**
   * Whether the selected note was chosen by clicking it. Then the palette edits it (choosing another value
   * changes it); a note that was just placed is selected too, but the palette is for the next ones.
   */
  private readonly editing = signal(false);

  /** The note value that is placed next. */
  readonly kind = signal<NoteKind>('quarter');
  readonly dotted = signal(false);
  /** Staff zoom in pixels per quarter note. */
  readonly zoom = signal<number>(DEFAULT_ZOOM);
  /** Value being dragged from the palette (the staff listens for the drop). */
  readonly paletteDrag = signal<PaletteDrag | null>(null);
  /**
   * The repeat sign works like a note value: it is dragged from the palette (or chosen, then a click on the
   * staff puts it) onto the bar line it goes on. `repeatDrag` is true while it is being dragged, from the
   * palette or from where it is, and `repeatTool` while it is chosen. `repeatSelected` is the sign on the staff.
   */
  readonly repeatDrag = signal(false);
  readonly repeatTool = signal(false);
  readonly repeatSelected = signal(false);
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
  /** Whether a slur starts at the selected note (the slur key then takes it away). */
  readonly selectedStartsSlur = computed(() => {
    const id = this.selectedNoteId();
    return !!id && !!this.doc()?.slurs.some((sl) => sl.from === id);
  });
  /** Length of the note that is placed next. */
  readonly toolTicks = computed(() => durationTicks(this.kind(), this.dotted() && canDot(this.kind())));
  readonly filteredScores = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.scores();
    return q ? list.filter((s) => s.title.toLowerCase().includes(q)) : list;
  });

  /** The list is in "pick scores for a PDF" mode: a click on a row marks it instead of opening it. */
  readonly picking = signal(false);
  /** Ids of the scores picked for the PDF, in the order they were picked (that is the order of the PDF). */
  private readonly pickedIds = signal<readonly string[]>([]);
  /** The picked scores that still exist, in order, whether the search filter hides them or not. */
  readonly picked = computed(() => {
    const byId = new Map(this.scores().map((s) => [s.id, s]));
    return this.pickedIds().flatMap((id) => byId.get(id) ?? []);
  });
  readonly exportingPicked = computed(() => this.exporter.isBusy(SCORES_PDF_KEY));

  constructor() {
    this.playback.registerScoreSource((id) => {
      const d = this.doc();
      return d && d.id === id ? d : null;
    });
  }

  // ---- List and document ----

  reset(): void {
    this.picking.set(false);
    this.pickedIds.set([]);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
    this.loadRequest++;
    this.scores.set([]);
    this.selectedId.set(null);
    this.doc.set(null);
    this.selectedNoteId.set(null);
    this.clearRepeat();
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
    this.clearRepeat();
    this.clearHistory();
    if (id) await this.reload();
  }

  /** Turns the "pick scores for a PDF" mode on or off. Leaving it forgets the picks. */
  setPicking(on: boolean): void {
    this.picking.set(on);
    if (!on) this.pickedIds.set([]);
  }

  /** Position (1-based) of a score among the picked ones, or 0. */
  pickedPosition(id: string): number {
    return this.pickedIds().indexOf(id) + 1;
  }

  /** Picks a score (it goes last) or drops it. Scores without notes have nothing to print and are ignored. */
  togglePicked(id: string): void {
    const s = this.scores().find((x) => x.id === id);
    if (!s) return;
    if (this.pickedIds().includes(id)) this.pickedIds.update((ids) => ids.filter((x) => x !== id));
    else if (s.note_count > 0) this.pickedIds.update((ids) => [...ids, id]);
  }

  /** Writes the picked scores into one PDF. Pending edits are saved first, because the scores are read from the vault. */
  async exportPicked(): Promise<void> {
    const items = this.picked().map(({ id, title }) => ({ id, title }));
    if (!items.length) return;
    await this.flush();
    await this.exporter.exportScores(items);
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
      // The repertoire shows the scores of its pieces.
      void this.pieces.refreshList();
      if (this.pieces.selectedId()) void this.pieces.reloadDetail();
      this.toast.success(this.i18n.t('score.deleted'));
    } catch (err) {
      this.toast.error(err, this.i18n.t('score.errors.delete'));
    }
  }

  /** Files the score under a piece of the repertoire (`null` takes it out). */
  async assignPiece(scoreId: string, pieceId: string | null): Promise<void> {
    const updated = await this.pieces.assignScore(scoreId, pieceId);
    if (updated) this.scores.update((l) => l.map((s) => (s.id === scoreId ? { ...s, piece_id: updated.piece_id } : s)));
  }

  /** "Add to repertoire": a new piece named after the score, with the score in it. */
  async addToRepertoire(scoreId: string): Promise<void> {
    const title = this.scores().find((s) => s.id === scoreId)?.title || this.doc()?.title || '';
    const piece = await this.pieces.createFromScore(scoreId, title);
    if (piece) this.scores.update((l) => l.map((s) => (s.id === scoreId ? { ...s, piece_id: piece.id } : s)));
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
    if (d.repeat_bar === null) this.repeatSelected.set(false);
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
      // The piece is set from the repertoire, not by the editor: the entry keeps the one it had.
      this.scores.update((list) => [
        summarizeScore(saved, list.find((s) => s.id === saved.id)?.piece_id ?? null),
        ...list.filter((s) => s.id !== saved.id),
      ]);
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

  /** Sets the value and the dot of the tool without touching the selected note (a note dropped from the palette). */
  setTool(kind: NoteKind, dotted: boolean): void {
    this.kind.set(kind);
    this.dotted.set(canDot(kind) && dotted);
  }

  /**
   * Chooses a note value: the tool for the next notes and, if a note was selected by clicking it, that
   * note's value at once, plain (the dot is a separate choice, so a dotted half note becomes a half note).
   */
  chooseKind(kind: NoteKind): void {
    this.setKind(kind);
    if (this.editedNote()) this.dotted.set(false);
    this.applyToolToSelected();
  }

  /** Dots or undots: the tool for the next notes and, if a note was selected by clicking it, that note at once. */
  toggleDotted(): void {
    if (!canDot(this.kind())) return;
    this.dotted.update((v) => !v);
    this.applyToolToSelected();
  }

  /** Sharp or flat: for the notes placed next and for the selected note. */
  toggleAccidental(accidental: Accidental): void {
    this.accidental.update((a) => (a === accidental ? null : accidental));
    const id = this.selectedNoteId();
    if (id) this.update((d) => toggleAccidental(d, id, accidental));
  }

  // ---- Notes ----

  /** Selects a note (or none) the way a click does: the palette shows its value and edits it. */
  selectNote(id: string | null): void {
    if (id !== null) this.repeatSelected.set(false);
    this.selectedNoteId.set(id);
    this.editing.set(id !== null);
    this.syncTool();
  }

  /** The selected note if the palette edits it (it was clicked, not just placed). */
  private editedNote(): ReturnType<ScoreStore['selectedNote']> {
    return this.editing() ? this.selectedNote() : null;
  }

  /** The value and the dot of the tool become those of the selected note. */
  private syncTool(): void {
    const ref = this.selectedNote();
    const value = ref ? notatedValue(ref.note.duration_ticks) : null;
    if (!value) return;
    this.kind.set(value.kind);
    this.dotted.set(value.dotted);
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
    // The new note is selected for the arrow keys, but the palette stays the tool for the next one.
    this.selectedNoteId.set(id);
    this.editing.set(false);
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
    if (this.repeatSelected()) {
      this.removeRepeat();
      return;
    }
    const id = this.selectedNoteId();
    if (id && this.update((d) => removeNote(d, id))) this.selectedNoteId.set(null);
  }

  /**
   * The note being edited takes the value of the tool (if it fits; otherwise the tool goes back to the
   * note's value and it says so). Nothing happens if no note was selected by clicking it.
   */
  applyToolToSelected(): void {
    const ref = this.editedNote();
    if (!ref) return;
    if (ref.note.duration_ticks !== this.toolTicks()) {
      const id = ref.note.id;
      if (!this.update((d) => setNoteDuration(d, id, this.toolTicks()))) this.toast.warning(this.i18n.t('score.noRoom'));
    }
    this.syncTool();
  }

  /** Ties the selected note to the next one of the same pitch (adding it if it is not there), or unties it. */
  toggleTieSelected(): void {
    const id = this.selectedNoteId();
    if (!id) return;
    if (!this.update((d) => toggleTie(d, id, newId()))) this.toast.warning(this.i18n.t('score.noRoomTie'));
  }

  /**
   * Puts the repeat sign at the end of a bar (0 is the first one), so after it the score goes back to the
   * start, or takes it away with `null`. A sign put on the staff is selected, like a note that was just placed.
   */
  setRepeatBar(bar: number | null): void {
    this.update((d) => setRepeatBar(d, bar));
    this.repeatTool.set(false);
    this.repeatSelected.set(bar !== null && this.doc()?.repeat_bar === bar);
    if (this.repeatSelected()) this.selectedNoteId.set(null);
  }

  /** Chooses the repeat sign as the thing the next click on the staff puts (or lets it go). */
  toggleRepeatTool(): void {
    this.repeatTool.update((v) => !v);
    if (this.repeatTool()) {
      this.selectedNoteId.set(null);
      this.repeatSelected.set(false);
    }
  }

  /** Selects the sign that is on the staff. */
  selectRepeat(): void {
    if (this.doc()?.repeat_bar == null) return;
    this.selectedNoteId.set(null);
    this.repeatTool.set(false);
    this.repeatSelected.set(true);
  }

  /** Takes the repeat sign away. */
  removeRepeat(): void {
    this.setRepeatBar(null);
  }

  /** Lets go of the repeat sign: the tool, the drag and the selection (Esc). */
  clearRepeat(): void {
    this.repeatTool.set(false);
    this.repeatDrag.set(false);
    this.repeatSelected.set(false);
  }

  /** The slur key: slurs the selected note to the next one, or takes away the slur that starts at it. */
  toggleSlurSelected(): void {
    const id = this.selectedNoteId();
    if (!id) return;
    if (!this.update((d) => toggleSlurFrom(d, id, newId()))) this.toast.warning(this.i18n.t('score.cantSlur'));
  }

  /** Shift+click: slurs the selected note to `id` (a note of the same hand), or takes that slur away. */
  slurSelectedTo(id: string): void {
    const from = this.selectedNoteId();
    if (!from || from === id) return;
    if (!this.update((d) => toggleSlur(d, from, id, newId()))) this.toast.warning(this.i18n.t('score.cantSlurHand'));
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
    const ms = Math.round((performedTick(d, Math.max(0, Math.min(tick, scoreTicks(d)))) * 60_000) / (480 * d.bpm));
    await this.playback.seek(key, ms);
  }

  async stop(): Promise<void> {
    const key = this.key();
    if (key) await this.playback.stop(key);
  }
}
