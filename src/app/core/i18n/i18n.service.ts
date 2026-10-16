import { Injectable, computed, signal } from '@angular/core';
import {
  FALLBACK_LANG,
  LANGUAGES,
  type LangCode,
  type MessageKey,
  type MessageParams,
  type PluralKey,
  normalizeLang,
} from './languages';

/**
 * Traducciones y formato dependiente del idioma. El idioma es un signal: todo `t()` leído en una
 * plantilla o un `computed` se recalcula al cambiarlo. Quién decide el idioma (preferencia guardada
 * o el del sistema) es `LanguageStore`.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly languages = LANGUAGES;

  private readonly catalogs = new Map<string, Map<string, string>>(
    LANGUAGES.map((l) => [l.code, flatten(l.messages)]),
  );

  private readonly _lang = signal<LangCode>(browserLanguage());
  readonly lang = this._lang.asReadonly();
  /** Etiqueta BCP-47 para `Intl` (`en-US`, `es-ES`). */
  readonly locale = computed(() => LANGUAGES.find((l) => l.code === this._lang())?.locale ?? 'en-US');
  private readonly pluralRules = computed(() => new Intl.PluralRules(this.locale()));

  constructor() {
    document.documentElement.lang = this._lang();
  }

  setLang(code: string): void {
    const lang = normalizeLang(code) ?? FALLBACK_LANG;
    this._lang.set(lang);
    document.documentElement.lang = lang;
  }

  /** Texto de `key` en el idioma actual, con los huecos `{nombre}` sustituidos por `params`. */
  t(key: MessageKey, params?: MessageParams): string {
    return this.lookup(this._lang(), key, params);
  }

  /** Plural de `key` según `n` (`key_zero` si existe y n = 0; si no `key_one`, `key_other`…). `{n}` es el número. */
  plural(key: PluralKey, n: number, params?: MessageParams): string {
    const lang = this._lang();
    const catalog = this.catalogs.get(lang);
    const zero = `${key}_zero`;
    const byRule = `${key}_${this.pluralRules().select(n)}`;
    const chosen = n === 0 && catalog?.has(zero) ? zero : catalog?.has(byRule) ? byRule : `${key}_other`;
    return this.lookup(lang, chosen, { n, ...params });
  }

  // ---- Fechas ----

  /** Fecha larga con día de la semana: «Thursday, October 15, 2026 · 7:05 PM». */
  longDate(iso: string | null | undefined): string {
    const d = parseDate(iso);
    if (!d) return iso ?? '';
    const day = d.toLocaleDateString(this.locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const time = d.toLocaleTimeString(this.locale(), { hour: '2-digit', minute: '2-digit' });
    return `${capitalize(day)} · ${time}`;
  }

  /** Fecha compacta para listas: «Thu Oct 15», «jue 15 oct». */
  shortDate(iso: string | null | undefined): string {
    const d = parseDate(iso);
    if (!d) return iso ?? '';
    return d.toLocaleDateString(this.locale(), { weekday: 'short', day: 'numeric', month: 'short' }).replace(/[,.]/g, '');
  }

  /** Fecha y hora numéricas: «10/15/2026 07:05 PM», «15/10/2026 19:05». */
  dateTime(d: Date): string {
    const date = d.toLocaleDateString(this.locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString(this.locale(), { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  }

  /** Grupo de la lista lateral: «This week», «Last week» o el mes («September», «March 2025»). */
  dateGroup(iso: string | null | undefined, now = new Date()): string {
    const d = parseDate(iso);
    if (!d) return this.t('dates.noDate');
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // lunes
    if (d >= weekStart) return this.t('dates.thisWeek');
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    if (d >= lastWeekStart) return this.t('dates.lastWeek');
    const month = capitalize(d.toLocaleDateString(this.locale(), { month: 'long' }));
    return d.getFullYear() === now.getFullYear() ? month : `${month} ${d.getFullYear()}`;
  }

  private lookup(lang: string, key: string, params?: MessageParams): string {
    const template = this.catalogs.get(lang)?.get(key) ?? this.catalogs.get(FALLBACK_LANG)?.get(key) ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
  }
}

/** Idioma del navegador (o el de reserva), para la primera pintura antes de preguntar al backend. */
export function browserLanguage(): LangCode {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const lang = normalizeLang(tag);
    if (lang) return lang;
  }
  return FALLBACK_LANG;
}

function flatten(obj: object, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (v && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
