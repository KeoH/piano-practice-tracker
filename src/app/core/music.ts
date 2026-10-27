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
