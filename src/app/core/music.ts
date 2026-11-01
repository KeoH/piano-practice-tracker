/** Name of a MIDI key with its octave (60 = C4). `names` holds the 12 pitch classes from C. */
export function noteName(key: number, names: readonly string[]): string {
  const k = Math.round(key);
  const pc = ((k % 12) + 12) % 12;
  const octave = Math.floor(k / 12) - 1;
  return `${names[pc] ?? '?'}${octave}`;
}

/** `true` for the keys that are black on a piano. */
export function isBlackKey(key: number): boolean {
  return [1, 3, 6, 8, 10].includes(((Math.round(key) % 12) + 12) % 12);
}

/** Splits the translated list of pitch classes (`"C,C♯,D,…"`). */
export function parseNoteNames(list: string): string[] {
  return list.split(',').map((n) => n.trim());
}

export type NoteKind = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth' | 'thirtysecond';

export interface NoteValue {
  kind: NoteKind;
  dotted: boolean;
  /** Length in beats (a quarter note = 1 beat). */
  beats: number;
  /** Within ~12 % of the nominal value (otherwise the label is an approximation). */
  exact: boolean;
}

/** Nominal values in beats, longest first, with the shortest length (in beats) that still reads as each. */
const NOTE_VALUES: readonly { kind: NoteKind; dotted: boolean; beats: number; from: number }[] = [
  { kind: 'whole', dotted: false, beats: 4, from: 3.5 },
  { kind: 'half', dotted: true, beats: 3, from: 2.6 },
  { kind: 'half', dotted: false, beats: 2, from: 1.75 },
  { kind: 'quarter', dotted: true, beats: 1.5, from: 1.3 },
  { kind: 'quarter', dotted: false, beats: 1, from: 0.7 },
  { kind: 'eighth', dotted: false, beats: 0.5, from: 0.35 },
  { kind: 'sixteenth', dotted: false, beats: 0.25, from: 0.18 },
  { kind: 'thirtysecond', dotted: false, beats: 0.125, from: 0.09 },
];

/** Milliseconds in one beat at `bpm`. */
export function beatMs(bpm: number): number {
  return 60000 / bpm;
}

/**
 * Note value of a key held `durationMs` at `bpm`. Players lift the key a little early, so the
 * boundaries lean downwards (0.8 beats is a quarter, not a dotted eighth) and only the plain values
 * plus the dotted half and quarter are used. `null` when the tempo is unknown or the note is shorter
 * than a 32nd.
 */
export function noteValue(durationMs: number, bpm: number): NoteValue | null {
  if (!(bpm > 0) || !(durationMs > 0)) return null;
  const beats = durationMs / beatMs(bpm);
  const v = NOTE_VALUES.find((x) => beats >= x.from);
  if (!v) return null;
  return { kind: v.kind, dotted: v.dotted, beats, exact: Math.abs(beats - v.beats) <= v.beats * 0.12 };
}
