import en from '../../../locales/en.json';
import es from '../../../locales/es.json';

/** Forma de un fichero de idioma: la de `en.json`, que es la referencia. */
export type Messages = typeof en;

/**
 * Idiomas disponibles. Para añadir uno:
 *  1. copia `src/locales/en.json` a `src/locales/<código>.json` y tradúcelo;
 *  2. añade aquí su entrada (`satisfies Messages` avisa si faltan claves);
 *  3. añade la línea correspondiente en `LOCALES` de `src-tauri/src/i18n.rs`.
 * `name` va en el propio idioma; `locale` es la etiqueta BCP-47 para `Intl`.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-US', messages: en },
  { code: 'es', name: 'Español', locale: 'es-ES', messages: es satisfies Messages },
] as const;

export type LangCode = (typeof LANGUAGES)[number]['code'];

/** Idioma de reserva: el de una instalación nueva si el del sistema no está disponible. */
export const FALLBACK_LANG: LangCode = 'en';

/** Claves de traducción con puntos (`sidebar.newSession`), derivadas de `en.json`. */
export type MessageKey = Leaves<Messages>;

/** Claves con plural: la base de las que tienen variantes `_one` / `_other` (y opcionalmente `_zero`). */
export type PluralKey = PluralBase<MessageKey>;

export type MessageParams = Record<string, string | number>;

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

type PluralBase<K> = K extends `${infer B}_other` ? B : never;

/** Convierte una etiqueta (`es`, `es-ES`, `es_ES.UTF-8`) en un idioma disponible. */
export function normalizeLang(tag: string | null | undefined): LangCode | null {
  const code = (tag ?? '').split(/[-_.@]/)[0].trim().toLowerCase();
  return LANGUAGES.find((l) => l.code === code)?.code ?? null;
}
