import en from '../../../locales/en.json';
import es from '../../../locales/es.json';

/** Shape of a language file: that of `en.json`, which is the reference. */
export type Messages = typeof en;

/**
 * Available languages. To add one:
 *  1. copy `src/locales/en.json` to `src/locales/<code>.json` and translate it;
 *  2. add its entry here (`satisfies Messages` flags missing keys);
 *  3. add the matching line in `LOCALES` in `src-tauri/src/i18n.rs`.
 * `name` is written in the language itself; `locale` is the BCP-47 tag for `Intl`.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-US', messages: en },
  { code: 'es', name: 'Español', locale: 'es-ES', messages: es satisfies Messages },
] as const;

export type LangCode = (typeof LANGUAGES)[number]['code'];

/** Fallback language: used by a new install if the system language is not available. */
export const FALLBACK_LANG: LangCode = 'en';

/** Dotted translation keys (`sidebar.newSession`), derived from `en.json`. */
export type MessageKey = Leaves<Messages>;

/** Plural keys: the base of those with `_one` / `_other` variants (and optionally `_zero`). */
export type PluralKey = PluralBase<MessageKey>;

export type MessageParams = Record<string, string | number>;

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

type PluralBase<K> = K extends `${infer B}_other` ? B : never;

/** Turns a tag (`es`, `es-ES`, `es_ES.UTF-8`) into an available language. */
export function normalizeLang(tag: string | null | undefined): LangCode | null {
  const code = (tag ?? '').split(/[-_.@]/)[0].trim().toLowerCase();
  return LANGUAGES.find((l) => l.code === code)?.code ?? null;
}
