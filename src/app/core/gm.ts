import type { MessageKey } from './i18n/languages';

/** General MIDI: 128 programs in 16 families of 8. */
export const GM_FAMILY_COUNT = 16;
export const GM_FAMILY_SIZE = 8;

export function familyOf(program: number): number {
  return Math.floor(program / GM_FAMILY_SIZE);
}

/** Translation key of a program's name (`gm.program.<n>`). */
export function programKey(program: number): MessageKey {
  return `gm.program.${program}` as MessageKey;
}

export function familyKey(family: number): MessageKey {
  return `gm.family.${family}` as MessageKey;
}
