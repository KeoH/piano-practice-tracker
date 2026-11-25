import type { Accidental, ScoreDto, ScoreNoteDto, ScoreSlurDto, ScoreSummaryDto } from './models';
import type { NoteKind } from './music';

/*
 * Pure model of the score editor (grand staff). Nothing here touches the DOM or Tauri.
 *
 * - Time is in ticks at 480 per quarter note (the resolution `midi_slicer` writes).
 * - Only notes are stored. Rests are the gaps between them (`withRests`).
 * - A staff has one rhythm: notes never overlap, except a **chord**, which is notes that start at the
 *   same tick, last the same and have different keys.
 * - A note never crosses a bar line; to hold a note over one, **tie** it to a note of the same key that
 *   starts where it ends (they sound as a single note).
 * - The first bar can be shorter (a **pickup**, or anacrusis): it lasts `pickup_ticks` and is the end of
 *   a bar, so the beats still fall where they would in a whole one (`missingTicks`). The score then ends
 *   with a **closing bar** of what the pickup lacks, so the two together make one whole bar.
 * - A bar can end with a **repeat sign** (`repeat_bar`, a bar index): the score goes back to the start and is
 *   played through again, so the bars up to the sign sound twice.
 * - A **slur** (`slurs`) is a curve from one note to a later one of the same staff. It is notation only: it
 *   never changes what is played.
 * - A note is its sounding MIDI `key`; `accidental` only spells a black key (C♯ or D♭). The staff draws
 *   it, and a natural sign when a plain note follows an altered one on its line or space in the bar.
 * - Every function returns a new score, or `null` when the change is not allowed.
 */

export const TICKS_PER_QUARTER = 480;
export const TICKS_PER_WHOLE = TICKS_PER_QUARTER * 4;
/** Lowest and highest key of a piano (A0 and C8). */
export const MIN_KEY = 21;
export const MAX_KEY = 108;
export const MAX_BARS = 64;
export const MIN_BPM = 30;
export const MAX_BPM = 240;
export const DEFAULT_BPM = 90;
export const DEFAULT_BARS = 4;

export type StaffName = 'treble' | 'bass';
export const STAFF_NAMES: readonly StaffName[] = ['treble', 'bass'];

export interface TimeSignature {
  beats: number;
  beat_unit: number;
}

/** The time signatures the editor offers. */
export const TIME_SIGNATURES: readonly TimeSignature[] = [
  { beats: 4, beat_unit: 4 },
  { beats: 3, beat_unit: 4 },
  { beats: 2, beat_unit: 4 },
];

export interface Pitch {
  key: number;
  accidental: Accidental | null;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

// ----------------------------------------------------------------------------------------------
// Durations
// ----------------------------------------------------------------------------------------------

export const NOTE_TICKS: Readonly<Record<NoteKind, number>> = {
  whole: TICKS_PER_WHOLE,
  half: TICKS_PER_WHOLE / 2,
  quarter: TICKS_PER_WHOLE / 4,
  eighth: TICKS_PER_WHOLE / 8,
  sixteenth: TICKS_PER_WHOLE / 16,
  thirtysecond: TICKS_PER_WHOLE / 32,
};

/** Values the palette offers, longest first. */
export const PALETTE_KINDS: readonly NoteKind[] = ['whole', 'half', 'quarter', 'eighth', 'sixteenth'];

export interface NotatedValue {
  kind: NoteKind;
  dotted: boolean;
  ticks: number;
}

/** Every duration a note can have, longest first (a dotted whole note never fits the supported bars). */
export const NOTATED_VALUES: readonly NotatedValue[] = PALETTE_KINDS.flatMap((kind) => {
  const ticks = NOTE_TICKS[kind];
  const plain: NotatedValue = { kind, dotted: false, ticks };
  return kind === 'whole' ? [plain] : [{ kind, dotted: true, ticks: (ticks * 3) / 2 }, plain];
});

export function durationTicks(kind: NoteKind, dotted = false): number {
  const t = NOTE_TICKS[kind];
  return dotted ? (t * 3) / 2 : t;
}

/** The note value that lasts exactly `ticks`, or `null` (a tuplet, a tie…). */
export function notatedValue(ticks: number): NotatedValue | null {
  return NOTATED_VALUES.find((v) => v.ticks === ticks) ?? null;
}

/** Grid a note of this length snaps to when it is dropped: its undotted value (a quarter snaps to the beat). */
export function gridTicks(kind: NoteKind): number {
  return NOTE_TICKS[kind];
}

// ----------------------------------------------------------------------------------------------
// Time
// ----------------------------------------------------------------------------------------------

export type TimeShape = Pick<ScoreDto, 'beats' | 'beat_unit' | 'bars' | 'pickup_ticks'>;

export function barTicks(s: Pick<ScoreDto, 'beats' | 'beat_unit'>): number {
  return (s.beats * TICKS_PER_WHOLE) / s.beat_unit;
}

/** Ticks the first bar is short by: a pickup of `L` ticks is the last `L` of a bar, so it lacks `bar - L` at its start. */
export function missingTicks(s: Pick<ScoreDto, 'beats' | 'beat_unit' | 'pickup_ticks'>): number {
  const pickup = s.pickup_ticks ?? 0;
  return pickup > 0 ? Math.max(0, barTicks(s) - pickup) : 0;
}

/**
 * Length of the whole score, trailing rests included. With a pickup the first bar is short and so is the
 * last one (it holds what the pickup lacks), so they add up to one whole bar.
 */
export function scoreTicks(s: TimeShape): number {
  const bar = barTicks(s);
  const pickup = s.pickup_ticks ?? 0;
  if (pickup > 0) return s.bars >= 2 ? (s.bars - 1) * bar : pickup;
  return s.bars * bar;
}

/** Whether a bar is the closing bar of a score with a pickup (it lasts what the pickup lacks). */
export function isClosingBar(s: TimeShape, index: number): boolean {
  return (s.pickup_ticks ?? 0) > 0 && s.bars >= 2 && index === s.bars - 1;
}

/** The fewest bars a score can have: a pickup needs its closing bar. */
export function minBars(s: Pick<ScoreDto, 'pickup_ticks'>): number {
  return (s.pickup_ticks ?? 0) > 0 ? 2 : 1;
}

/** One bar on the timeline. */
export interface BarSpan {
  index: number;
  start: number;
  end: number;
  /** Where a whole bar would start: before `start` in the pickup bar. The beats are counted from here. */
  virtualStart: number;
}

export function barSpan(s: TimeShape, index: number): BarSpan {
  const virtualStart = index * barTicks(s) - missingTicks(s);
  return { index, start: Math.max(0, virtualStart), end: Math.min(virtualStart + barTicks(s), scoreTicks(s)), virtualStart };
}

export function barSpans(s: TimeShape): BarSpan[] {
  return Array.from({ length: s.bars }, (_, i) => barSpan(s, i));
}

/** Index of the bar a tick is in (it may be outside the score). */
export function barOf(s: TimeShape, tick: number): number {
  return Math.floor((tick + missingTicks(s)) / barTicks(s));
}

/** The bar that holds `tick`, or `null` outside the score. */
export function barSpanAt(s: TimeShape, tick: number): BarSpan | null {
  if (!Number.isFinite(tick) || tick < 0 || tick >= scoreTicks(s)) return null;
  return barSpan(s, barOf(s, tick));
}

/** The number a bar is shown with: the pickup bar has none and the first whole bar is 1. */
export function barLabel(s: TimeShape, index: number): number | null {
  if ((s.pickup_ticks ?? 0) > 0) return index === 0 ? null : index;
  return index + 1;
}

/**
 * A tick snapped to `grid` counting from the start of its bar, so that dotted values and bars that are
 * not a multiple of the grid (3/4) still reach every bar, and kept inside the bar so that a note of
 * `duration` starts in it (as far as it fits).
 */
export function snapTickInBar(s: TimeShape, raw: number, grid: number, duration: number): number {
  const total = scoreTicks(s);
  const at = Math.min(Math.max(0, raw), Math.max(0, total - 1));
  const span = barSpan(s, barOf(s, at));
  const snapped = span.virtualStart + Math.round((raw - span.virtualStart) / grid) * grid;
  return Math.min(Math.max(snapped, span.start), Math.max(span.start, span.end - duration));
}

export function ticksToMs(ticks: number, bpm: number): number {
  return (ticks * 60_000) / (TICKS_PER_QUARTER * bpm);
}

export function msToTicks(ms: number, bpm: number): number {
  return Math.round((ms * TICKS_PER_QUARTER * bpm) / 60_000);
}

/** Tick where the repeat sign is (the end of its bar), or `null` if the score has none. */
export function repeatTick(s: TimeShape & { repeat_bar?: number | null }): number | null {
  const bar = s.repeat_bar;
  if (bar === null || bar === undefined || !Number.isInteger(bar) || bar < 0 || bar >= s.bars) return null;
  return barSpan(s, bar).end;
}

/** Length of what is played: the score once, plus the part up to the repeat sign when there is one. */
export function playTicks(s: TimeShape & { repeat_bar?: number | null }): number {
  return scoreTicks(s) + (repeatTick(s) ?? 0);
}

export function scoreDurationMs(s: ScoreDto): number {
  return Math.round(ticksToMs(playTicks(s), s.bpm));
}

/** Where the playhead is on the page when the player is at `ticks`: after the repeat sign the score starts over. */
export function pageTick(s: ScoreDto, ticks: number): number {
  const at = repeatTick(s);
  return at !== null && ticks >= at ? ticks - at : ticks;
}

/** The inverse of `pageTick` for a place on the page: the bars after the repeat sign are only played in the second pass. */
export function performedTick(s: ScoreDto, tick: number): number {
  const at = repeatTick(s);
  return at !== null && tick >= at ? tick + at : tick;
}

// ----------------------------------------------------------------------------------------------
// Pitch ↔ position on the staff
// ----------------------------------------------------------------------------------------------

/** Pitch class of each natural note, indexed by letter (C D E F G A B). */
const NATURAL_PC = [0, 2, 4, 5, 7, 9, 11] as const;
/** Letters that have a black key a semitone above / below them. */
const CAN_SHARP = [true, true, false, true, true, true, false] as const;
const CAN_FLAT = [false, true, true, false, true, true, true] as const;

/** Diatonic number (octave × 7 + letter) of the bottom line of each staff: E4 and G2. */
const BOTTOM_LINE: Readonly<Record<StaffName, number>> = { treble: 4 * 7 + 2, bass: 2 * 7 + 4 };

export function isBlackKey(key: number): boolean {
  return !NATURAL_PC.includes(mod(key, 12) as (typeof NATURAL_PC)[number]);
}

/** The accidental a note of `key` carries: none on a white key, sharp unless it says otherwise on a black one. */
export function normalizeAccidental(key: number, accidental: Accidental | null | undefined): Accidental | null {
  return isBlackKey(key) ? (accidental ?? 'sharp') : null;
}

/** Diatonic number of the letter a key is written with (C♯4 is written as C4, D♭4 as D4). */
export function diatonicNumber(key: number, accidental: Accidental | null | undefined): number {
  const pc = mod(key, 12);
  const octave = Math.floor(key / 12) - 1;
  const acc = normalizeAccidental(key, accidental);
  const letterPc = acc === 'sharp' ? pc - 1 : acc === 'flat' ? pc + 1 : pc;
  return octave * 7 + NATURAL_PC.indexOf(letterPc as (typeof NATURAL_PC)[number]);
}

/**
 * Position of a note on a staff, in half line spacings: 0 is the bottom line, 1 the first space,
 * 8 the top line; below 0 and above 8 are ledger lines.
 */
export function staffStep(staff: StaffName, key: number, accidental: Accidental | null | undefined): number {
  return diatonicNumber(key, accidental) - BOTTOM_LINE[staff];
}

/**
 * The pitch written at `step` on a staff with the requested accidental. An accidental the letter
 * cannot take (E♯, C♭…) is ignored, so `staffStep` of the result is always `step`. `null` outside
 * the piano.
 */
export function pitchAt(staff: StaffName, step: number, accidental: Accidental | null | undefined): Pitch | null {
  const dia = BOTTOM_LINE[staff] + Math.round(step);
  const letter = mod(dia, 7);
  const octave = Math.floor(dia / 7);
  let alter = 0;
  let spelled: Accidental | null = null;
  if (accidental === 'sharp' && CAN_SHARP[letter]) {
    alter = 1;
    spelled = 'sharp';
  } else if (accidental === 'flat' && CAN_FLAT[letter]) {
    alter = -1;
    spelled = 'flat';
  }
  const key = (octave + 1) * 12 + NATURAL_PC[letter] + alter;
  return key >= MIN_KEY && key <= MAX_KEY ? { key, accidental: spelled } : null;
}

/** Ledger lines a note at `step` needs, as the steps they sit on (always even). */
export function ledgerSteps(step: number): number[] {
  const out: number[] = [];
  if (step <= -2) {
    const lowest = step % 2 === 0 ? step : step + 1;
    for (let e = -2; e >= lowest; e -= 2) out.push(e);
  } else if (step >= 10) {
    const highest = step % 2 === 0 ? step : step - 1;
    for (let e = 10; e <= highest; e += 2) out.push(e);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// Access
// ----------------------------------------------------------------------------------------------

export function staffNotes(s: ScoreDto, staff: StaffName): ScoreNoteDto[] {
  return staff === 'treble' ? s.treble : s.bass;
}

export function noteEnd(n: Pick<ScoreNoteDto, 'tick' | 'duration_ticks'>): number {
  return n.tick + n.duration_ticks;
}

function sortNotes(notes: readonly ScoreNoteDto[]): ScoreNoteDto[] {
  return [...notes].sort((a, b) => a.tick - b.tick || a.key - b.key);
}

/** The note a tied note is tied to: same key, starting where it ends. */
export function tieTarget(notes: readonly ScoreNoteDto[], n: ScoreNoteDto): ScoreNoteDto | null {
  return notes.find((m) => m !== n && m.key === n.key && m.tick === noteEnd(n)) ?? null;
}

/** Every tie of a staff as a pair of notes. */
export function tieLinks(notes: readonly ScoreNoteDto[]): { from: ScoreNoteDto; to: ScoreNoteDto }[] {
  const out: { from: ScoreNoteDto; to: ScoreNoteDto }[] = [];
  for (const n of notes) {
    const to = n.tie ? tieTarget(notes, n) : null;
    if (to) out.push({ from: n, to });
  }
  return out;
}

/** The notes with the ties that no longer join two notes (the other one moved, changed or went) cleared. */
function normalizeTies(notes: ScoreNoteDto[]): ScoreNoteDto[] {
  return notes.map((n) => (n.tie && !tieTarget(notes, n) ? { ...n, tie: false } : n));
}

/** A copy of the score with `staff`'s notes replaced (sorted by tick), keeping only the ties that still hold. */
export function withStaff(s: ScoreDto, staff: StaffName, notes: readonly ScoreNoteDto[]): ScoreDto {
  return { ...s, [staff]: normalizeTies(sortNotes(notes)) };
}

export interface NoteRef {
  staff: StaffName;
  note: ScoreNoteDto;
}

export function findNote(s: ScoreDto | null, id: string | null): NoteRef | null {
  if (!s || !id) return null;
  for (const staff of STAFF_NAMES) {
    const note = staffNotes(s, staff).find((n) => n.id === id);
    if (note) return { staff, note };
  }
  return null;
}

export function noteCount(s: ScoreDto): number {
  return s.treble.length + s.bass.length;
}

export function newScore(id: string, title: string, now: string): ScoreDto {
  return {
    id,
    title,
    bpm: DEFAULT_BPM,
    beats: 4,
    beat_unit: 4,
    bars: DEFAULT_BARS,
    pickup_ticks: 0,
    repeat_bar: null,
    treble: [],
    bass: [],
    slurs: [],
    fragment_id: null,
    created_at: now,
    updated_at: now,
  };
}

// ----------------------------------------------------------------------------------------------
// Editing
// ----------------------------------------------------------------------------------------------

/**
 * Whether a note of `key` at `[tick, tick + duration)` would collide with `notes`: it may only share
 * time with a chord mate, a note that starts at the same tick, lasts the same and has another key
 * (any key counts as another when `key` is `null`). `ignore` leaves notes out (the ones being moved).
 */
function inTheWay(notes: readonly ScoreNoteDto[], tick: number, duration: number, key: number | null, ignore: ReadonlySet<string>): boolean {
  const end = tick + duration;
  return notes.some((n) => {
    if (ignore.has(n.id) || n.tick >= end || tick >= noteEnd(n)) return false;
    const mate = n.tick === tick && n.duration_ticks === duration && (key === null || n.key !== key);
    return !mate;
  });
}

/** Whether a note of that value fits at `tick` on a staff: inside one bar and not in the way of another rhythm. */
export function canPlace(
  s: ScoreDto,
  staff: StaffName,
  tick: number,
  duration: number,
  ignoreId: string | null = null,
  key: number | null = null,
): boolean {
  if (notatedValue(duration) === null || !Number.isInteger(tick)) return false;
  const span = barSpanAt(s, tick);
  if (!span || tick + duration > span.end) return false;
  return !inTheWay(staffNotes(s, staff), tick, duration, key, new Set(ignoreId ? [ignoreId] : []));
}

/** The length of the notes that start exactly at `tick` on a staff (a new note there joins them as a chord). */
export function chordDuration(s: ScoreDto, staff: StaffName, tick: number): number | null {
  return staffNotes(s, staff).find((n) => n.tick === tick)?.duration_ticks ?? null;
}

function validKey(key: number): boolean {
  return Number.isInteger(key) && key >= MIN_KEY && key <= MAX_KEY;
}

/** Adds a note. `null` if the key or the duration is not valid, or the note does not fit. */
export function place(s: ScoreDto, staff: StaffName, note: ScoreNoteDto): ScoreDto | null {
  if (!validKey(note.key) || !canPlace(s, staff, note.tick, note.duration_ticks, null, note.key)) return null;
  const placed = { ...note, accidental: normalizeAccidental(note.key, note.accidental), tie: false };
  return withStaff(s, staff, [...staffNotes(s, staff), placed]);
}

export function removeNote(s: ScoreDto, id: string): ScoreDto | null {
  const ref = findNote(s, id);
  if (!ref) return null;
  return pruneSlurs(
    withStaff(
      s,
      ref.staff,
      staffNotes(s, ref.staff).filter((n) => n.id !== id),
    ),
  );
}

export interface NoteMove {
  tick?: number;
  pitch?: Pitch;
  /** Moves the note to the other hand. */
  staff?: StaffName;
}

/** Moves a note in time, pitch or hand, keeping its duration. `null` if it does not fit there. */
export function moveNote(s: ScoreDto, id: string, change: NoteMove): ScoreDto | null {
  const ref = findNote(s, id);
  if (!ref) return null;
  const target = change.staff ?? ref.staff;
  const tick = change.tick ?? ref.note.tick;
  const key = change.pitch?.key ?? ref.note.key;
  if (!validKey(key) || !canPlace(s, target, tick, ref.note.duration_ticks, id, key)) return null;
  const accidental = normalizeAccidental(key, change.pitch ? change.pitch.accidental : ref.note.accidental);
  const moved: ScoreNoteDto = { ...ref.note, tick, key, accidental };
  const without = withStaff(s, ref.staff, staffNotes(s, ref.staff).filter((n) => n.id !== id));
  return pruneSlurs(withStaff(without, target, [...staffNotes(without, target), moved]));
}

/** The notes of the chord `n` belongs to (itself if it is alone). */
function chordOf(notes: readonly ScoreNoteDto[], n: ScoreNoteDto): ScoreNoteDto[] {
  return notes.filter((m) => m.tick === n.tick && m.duration_ticks === n.duration_ticks);
}

/** Changes the value of a note, and of the whole chord it is in (a chord has one value). */
export function setNoteDuration(s: ScoreDto, id: string, ticks: number): ScoreDto | null {
  const ref = findNote(s, id);
  if (!ref) return null;
  const notes = staffNotes(s, ref.staff);
  const group = chordOf(notes, ref.note);
  const ids = new Set(group.map((n) => n.id));
  const fits = notatedValue(ticks) !== null && group.every((n) => {
    const span = barSpanAt(s, n.tick);
    return !!span && n.tick + ticks <= span.end && !inTheWay(notes, n.tick, ticks, null, ids);
  });
  if (!fits) return null;
  return withStaff(
    s,
    ref.staff,
    notes.map((n) => (ids.has(n.id) ? { ...n, duration_ticks: ticks } : n)),
  );
}

/** Moves a note up or down by `delta` lines and spaces on its staff (the arrow keys). */
export function shiftStep(s: ScoreDto, id: string, delta: number): ScoreDto | null {
  const ref = findNote(s, id);
  if (!ref) return null;
  const step = staffStep(ref.staff, ref.note.key, ref.note.accidental) + delta;
  const pitch = pitchAt(ref.staff, step, ref.note.accidental);
  return pitch ? moveNote(s, id, { pitch }) : null;
}

/**
 * Sharpens or flattens a note without moving it on the staff; asking for the accidental it already
 * has makes it natural. `null` if its letter has no such black key (E♯, C♭…).
 */
export function toggleAccidental(s: ScoreDto, id: string, accidental: Accidental): ScoreDto | null {
  const ref = findNote(s, id);
  if (!ref) return null;
  const step = staffStep(ref.staff, ref.note.key, ref.note.accidental);
  const wanted = ref.note.accidental === accidental ? null : accidental;
  const pitch = pitchAt(ref.staff, step, wanted);
  if (!pitch || (wanted !== null && pitch.accidental !== wanted)) return null;
  return moveNote(s, id, { pitch });
}

/**
 * Ties a note to the one that follows it, or unties it. If the next note of the same key is not there
 * yet, one of the same value is added where this one ends (in the next bar if it ends at a bar line),
 * with `newId`. `null` if there is no room for it.
 */
export function toggleTie(s: ScoreDto, id: string, newId: string): ScoreDto | null {
  const ref = findNote(s, id);
  if (!ref) return null;
  const notes = staffNotes(s, ref.staff);
  if (ref.note.tie) return withStaff(s, ref.staff, notes.map((n) => (n.id === id ? { ...n, tie: false } : n)));
  const marked = notes.map((n) => (n.id === id ? { ...n, tie: true } : n));
  if (tieTarget(notes, ref.note)) return withStaff(s, ref.staff, marked);
  const next: ScoreNoteDto = { ...ref.note, id: newId, tick: noteEnd(ref.note), tie: false };
  if (!canPlace(s, ref.staff, next.tick, next.duration_ticks, null, next.key)) return null;
  return withStaff(s, ref.staff, [...marked, next]);
}

// ----------------------------------------------------------------------------------------------
// Slurs
// ----------------------------------------------------------------------------------------------

/** Whether a slur joins two notes of the same staff, the first one before the second. */
function slurHolds(s: ScoreDto, slur: ScoreSlurDto): boolean {
  const a = findNote(s, slur.from);
  const b = findNote(s, slur.to);
  return !!a && !!b && a.staff === b.staff && a.note.tick < b.note.tick;
}

/** The score without the slurs that no longer hold (a note went, changed hand or moved before the other). */
function pruneSlurs(s: ScoreDto): ScoreDto {
  const slurs = s.slurs.filter((sl) => slurHolds(s, sl));
  return slurs.length === s.slurs.length ? s : { ...s, slurs };
}

/** Every slur of a staff as a pair of notes, in order of start. */
export function slurLinks(s: ScoreDto, staff: StaffName): { slur: ScoreSlurDto; from: ScoreNoteDto; to: ScoreNoteDto }[] {
  const notes = staffNotes(s, staff);
  const out: { slur: ScoreSlurDto; from: ScoreNoteDto; to: ScoreNoteDto }[] = [];
  for (const slur of s.slurs) {
    const from = notes.find((n) => n.id === slur.from);
    const to = notes.find((n) => n.id === slur.to);
    if (from && to && from.tick < to.tick) out.push({ slur, from, to });
  }
  return out.sort((a, b) => a.from.tick - b.from.tick || b.to.tick - a.to.tick);
}

/**
 * Slurs the note `a` to the note `b` (in either order), or takes that slur away if it is there. `null`
 * if they are not two different notes of the same staff that start at different ticks.
 */
export function toggleSlur(s: ScoreDto, a: string, b: string, newId: string): ScoreDto | null {
  const ra = findNote(s, a);
  const rb = findNote(s, b);
  if (!ra || !rb || ra.staff !== rb.staff || ra.note.tick === rb.note.tick) return null;
  const [from, to] = ra.note.tick < rb.note.tick ? [ra.note, rb.note] : [rb.note, ra.note];
  const same = s.slurs.filter((sl) => sl.from === from.id && sl.to === to.id);
  if (same.length) return { ...s, slurs: s.slurs.filter((sl) => !same.includes(sl)) };
  return { ...s, slurs: [...s.slurs, { id: newId, from: from.id, to: to.id }] };
}

/**
 * The note a slur from `id` goes to by default: one of the next onset on the same staff, the one
 * closest in pitch. `null` if nothing follows.
 */
export function nextSlurTarget(s: ScoreDto, id: string): ScoreNoteDto | null {
  const ref = findNote(s, id);
  if (!ref) return null;
  const later = staffNotes(s, ref.staff).filter((n) => n.tick > ref.note.tick);
  if (!later.length) return null;
  const tick = Math.min(...later.map((n) => n.tick));
  return later.filter((n) => n.tick === tick).sort((a, b) => Math.abs(a.key - ref.note.key) - Math.abs(b.key - ref.note.key))[0];
}

/**
 * The slur key: removes the shortest slur that starts at the note, or, if there is none, slurs the note to
 * the next one (see `nextSlurTarget`). `null` if there is nothing to do.
 */
export function toggleSlurFrom(s: ScoreDto, id: string, newId: string): ScoreDto | null {
  const ref = findNote(s, id);
  if (!ref) return null;
  const starts = slurLinks(s, ref.staff).filter((l) => l.from.id === id);
  if (starts.length) {
    const shortest = starts[starts.length - 1].slur; // sorted longest first among equal starts
    return { ...s, slurs: s.slurs.filter((sl) => sl !== shortest) };
  }
  const to = nextSlurTarget(s, id);
  return to ? toggleSlur(s, id, to.id, newId) : null;
}

// ----------------------------------------------------------------------------------------------
// Structure
// ----------------------------------------------------------------------------------------------

/** Puts the repeat sign at the end of bar `bar` (0 is the first one), or takes it away with `null`. */
export function setRepeatBar(s: ScoreDto, bar: number | null): ScoreDto | null {
  if (bar !== null && (!Number.isInteger(bar) || bar < 0 || bar >= s.bars)) return null;
  return bar === s.repeat_bar ? s : { ...s, repeat_bar: bar };
}

/** Keeps the repeat sign on a bar of the score after the bars changed. */
function clampRepeat(s: ScoreDto): ScoreDto {
  return s.repeat_bar !== null && s.repeat_bar >= s.bars ? { ...s, repeat_bar: s.bars - 1 } : s;
}

/** Whether every note is inside the score and inside one bar (checked when the bars change shape). */
function fitsStructure(s: ScoreDto): boolean {
  const total = scoreTicks(s);
  return STAFF_NAMES.every((st) =>
    staffNotes(s, st).every((n) => noteEnd(n) <= total && barOf(s, n.tick) === barOf(s, noteEnd(n) - 1)),
  );
}

/** Changes the number of bars; it cannot cut a note off, nor take the closing bar from a pickup. */
export function resizeBars(s: ScoreDto, bars: number): ScoreDto | null {
  const n = Math.round(bars);
  if (n < minBars(s) || n > MAX_BARS) return null;
  const next = clampRepeat({ ...s, bars: n });
  return fitsStructure(next) ? next : null;
}

/** Changes the time signature, keeping the number of bars; `null` if a note would cross a bar line. A pickup that no longer fits in a bar is dropped. */
export function setTimeSignature(s: ScoreDto, beats: number, beatUnit: number): ScoreDto | null {
  if (!isTimeSignature(beats, beatUnit)) return null;
  let next = { ...s, beats, beat_unit: beatUnit };
  if (next.pickup_ticks >= barTicks(next)) {
    // The pickup no longer fits in a bar: it goes, and so does the closing bar that completed it.
    next.pickup_ticks = 0;
    next.bars = Math.max(1, next.bars - 1);
  }
  next = clampRepeat(next);
  return fitsStructure(next) ? next : null;
}

export function isTimeSignature(beats: number, beatUnit: number): boolean {
  return Number.isInteger(beats) && beats >= 1 && beats <= 12 && [2, 4, 8].includes(beatUnit);
}

/** Whether `ticks` is a valid pickup for a bar of this signature: none, or a shorter bar in sixteenths. */
export function isPickup(s: Pick<ScoreDto, 'beats' | 'beat_unit'>, ticks: number): boolean {
  return ticks === 0 || (Number.isInteger(ticks) && ticks > 0 && ticks < barTicks(s) && ticks % 120 === 0);
}

/**
 * Makes the first bar `ticks` long (0 = a whole bar), and the score ends with the bar that completes it.
 * The score keeps its length: a pickup adds that closing bar to the bars and taking it away removes it.
 * The notes stay where they are, so `null` if a bar line would cut one.
 */
export function setPickup(s: ScoreDto, ticks: number): ScoreDto | null {
  if (!isPickup(s, ticks)) return null;
  const had = (s.pickup_ticks ?? 0) > 0;
  const bars = ticks > 0 && !had ? s.bars + 1 : ticks === 0 && had ? Math.max(1, s.bars - 1) : s.bars;
  if (bars > MAX_BARS) return null;
  // A sign on the last bar stays at the end of the score when the closing bar comes or goes.
  const repeat_bar = s.repeat_bar === s.bars - 1 ? bars - 1 : s.repeat_bar;
  const next = clampRepeat({ ...s, pickup_ticks: ticks, bars, repeat_bar });
  return fitsStructure(next) ? next : null;
}

// ----------------------------------------------------------------------------------------------
// Rests
// ----------------------------------------------------------------------------------------------

export type StaffItem = { kind: 'note'; note: ScoreNoteDto } | { kind: 'rest'; tick: number; duration_ticks: number };

/** Rest values, longest first. */
const REST_TICKS = [TICKS_PER_WHOLE, TICKS_PER_WHOLE / 2, TICKS_PER_WHOLE / 4, TICKS_PER_WHOLE / 8, TICKS_PER_WHOLE / 16, TICKS_PER_WHOLE / 32];

/** Rests that fill `[start, start + length)` inside a bar: the longest value that fits and starts on its own multiple. */
function fillRests(start: number, length: number, barStart: number): StaffItem[] {
  const out: StaffItem[] = [];
  let at = start;
  let left = length;
  while (left > 0) {
    const d = REST_TICKS.find((t) => t <= left && (at - barStart) % t === 0) ?? left;
    out.push({ kind: 'rest', tick: at, duration_ticks: d });
    at += d;
    left -= d;
  }
  return out;
}

/**
 * The notes of a staff in order with the rests that fill every gap, bar by bar (the beats of a pickup bar
 * are counted as in a whole one). An empty whole bar is a single bar rest; a short bar (the pickup, or the
 * bar that closes it) is filled with the rests of its beats, as a quarter and a half rest for three beats.
 */
export function withRests(s: ScoreDto, staff: StaffName): StaffItem[] {
  const notes = sortNotes(staffNotes(s, staff));
  const out: StaffItem[] = [];
  let i = 0;
  for (const span of barSpans(s)) {
    let cursor = span.start;
    let any = false;
    while (i < notes.length && notes[i].tick < span.end) {
      const n = notes[i++];
      out.push(...fillRests(cursor, Math.max(0, n.tick - cursor), span.virtualStart));
      out.push({ kind: 'note', note: n });
      cursor = Math.max(cursor, noteEnd(n));
      any = true;
    }
    if (!any && span.end - span.start === barTicks(s)) out.push({ kind: 'rest', tick: span.start, duration_ticks: span.end - span.start });
    else out.push(...fillRests(cursor, Math.max(0, span.end - cursor), span.virtualStart));
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------------------------

export type ScoreIssueCode =
  | 'bpm'
  | 'timeSignature'
  | 'bars'
  | 'pickup'
  | 'duplicateId'
  | 'key'
  | 'accidental'
  | 'duration'
  | 'tick'
  | 'crossesBar'
  | 'overlap'
  | 'tie'
  | 'repeat'
  | 'slur';

export interface ScoreIssue {
  code: ScoreIssueCode;
  staff?: StaffName;
  noteId?: string;
}

/** Everything wrong with a score (empty when it can be saved). The backend runs the same checks. */
export function validateScore(s: ScoreDto): ScoreIssue[] {
  const issues: ScoreIssue[] = [];
  if (!Number.isInteger(s.bpm) || s.bpm < MIN_BPM || s.bpm > MAX_BPM) issues.push({ code: 'bpm' });
  if (!isTimeSignature(s.beats, s.beat_unit)) {
    issues.push({ code: 'timeSignature' });
    return issues;
  }
  if (!Number.isInteger(s.bars) || s.bars < minBars(s) || s.bars > MAX_BARS) issues.push({ code: 'bars' });
  if (!isPickup(s, s.pickup_ticks ?? 0)) {
    issues.push({ code: 'pickup' });
    return issues;
  }
  const total = scoreTicks(s);
  const ids = new Set<string>();
  for (const staff of STAFF_NAMES) {
    const notes = sortNotes(staffNotes(s, staff));
    let prevEnd = 0;
    let group = { tick: -1, end: -1, keys: new Set<number>() };
    for (const n of notes) {
      const at = { staff, noteId: n.id };
      if (ids.has(n.id)) issues.push({ code: 'duplicateId', ...at });
      ids.add(n.id);
      if (!validKey(n.key)) issues.push({ code: 'key', ...at });
      if (n.accidental !== normalizeAccidental(n.key, n.accidental)) issues.push({ code: 'accidental', ...at });
      if (notatedValue(n.duration_ticks) === null) issues.push({ code: 'duration', ...at });
      if (n.tie && !tieTarget(notes, n)) issues.push({ code: 'tie', ...at });
      if (!Number.isInteger(n.tick) || n.tick < 0 || noteEnd(n) > total) {
        issues.push({ code: 'tick', ...at });
        continue;
      }
      if (barOf(s, n.tick) !== barOf(s, noteEnd(n) - 1)) issues.push({ code: 'crossesBar', ...at });
      if (n.tick >= prevEnd) {
        group = { tick: n.tick, end: noteEnd(n), keys: new Set([n.key]) };
      } else if (n.tick === group.tick && noteEnd(n) === group.end && !group.keys.has(n.key)) {
        group.keys.add(n.key); // a chord mate
      } else {
        issues.push({ code: 'overlap', ...at });
      }
      prevEnd = Math.max(prevEnd, noteEnd(n));
    }
  }
  if (s.repeat_bar !== null && (!Number.isInteger(s.repeat_bar) || s.repeat_bar < 0 || s.repeat_bar >= s.bars)) issues.push({ code: 'repeat' });
  const slurIds = new Set<string>();
  for (const slur of s.slurs) {
    if (!slurHolds(s, slur) || slurIds.has(slur.id)) issues.push({ code: 'slur' });
    slurIds.add(slur.id);
  }
  return issues;
}

// ----------------------------------------------------------------------------------------------
// Player key and list entry
// ----------------------------------------------------------------------------------------------

/** Prefix of a score's key in the player (`PlaybackProgress.file_path`). */
export const SCORE_KEY_PREFIX = 'score:';

export function scoreKey(id: string): string {
  return SCORE_KEY_PREFIX + id;
}

/** The score id of a player key, or null if the key is something else. */
export function parseScoreKey(key: string | null | undefined): string | null {
  return key?.startsWith(SCORE_KEY_PREFIX) ? key.slice(SCORE_KEY_PREFIX.length) : null;
}

/**
 * The entry of the list of scores for `s` (what the backend sends for each stored score). The piece
 * is not part of the score, so whoever replaces an entry passes the one it had.
 */
export function summarizeScore(s: ScoreDto, pieceId: string | null = null): ScoreSummaryDto {
  return {
    id: s.id,
    title: s.title,
    bpm: s.bpm,
    beats: s.beats,
    beat_unit: s.beat_unit,
    bars: s.bars,
    note_count: noteCount(s),
    duration_ms: scoreDurationMs(s),
    fragment_id: s.fragment_id,
    piece_id: pieceId,
    updated_at: s.updated_at,
  };
}

/** `true` if a note value can be dotted in this score (a dotted whole note never fits a bar). */
export function canDot(kind: NoteKind): boolean {
  return NOTATED_VALUES.some((v) => v.kind === kind && v.dotted);
}

/** `setBpm` for a score: bounded to the allowed range. */
export function setBpm(s: ScoreDto, bpm: number): ScoreDto | null {
  const b = Math.round(bpm);
  if (!Number.isFinite(b) || b < MIN_BPM || b > MAX_BPM) return null;
  return b === s.bpm ? s : { ...s, bpm: b };
}
