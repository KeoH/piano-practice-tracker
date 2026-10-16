import { Injectable, inject, signal } from '@angular/core';
import { I18nService, browserLanguage } from './i18n/i18n.service';
import { type LangCode, normalizeLang } from './i18n/languages';
import type { LanguageInfo } from './models';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';
import { VaultStore } from './vault.store';

/** Clave de `localStorage` para la preferencia cuando no hay backend (navegador normal). */
const STORAGE_KEY = 'piano-tracker.language';

/**
 * Idioma de la interfaz: la preferencia del usuario (o automático) y el idioma del sistema. En la
 * app de escritorio la preferencia se guarda en la configuración del equipo y el backend traduce
 * también sus mensajes; sin Tauri se guarda en `localStorage`.
 */
@Injectable({ providedIn: 'root' })
export class LanguageStore {
  private readonly api = inject(TauriApiService);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly vault = inject(VaultStore);

  /** `null` = automático (el del sistema). */
  readonly preference = signal<LangCode | null>(null);
  readonly system = signal<LangCode>(browserLanguage());

  async init(): Promise<void> {
    if (!this.api.available) {
      this.preference.set(normalizeLang(readStored()));
      this.i18n.setLang(this.preference() ?? this.system());
      return;
    }
    try {
      this.apply(await this.api.getLanguage());
    } catch (err) {
      console.warn('No se pudo leer el idioma:', err);
    }
  }

  async set(preference: LangCode | null): Promise<void> {
    if (!this.api.available) {
      writeStored(preference);
      this.preference.set(preference);
      this.i18n.setLang(preference ?? this.system());
      return;
    }
    try {
      this.apply(await this.api.setLanguage(preference));
      await this.vault.refreshInfo();
    } catch (err) {
      this.toast.error(err, this.i18n.t('settings.general.languageError'));
    }
  }

  private apply(info: LanguageInfo): void {
    this.preference.set(normalizeLang(info.preference));
    this.system.set(normalizeLang(info.system) ?? this.system());
    this.i18n.setLang(info.effective);
  }
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(value: string | null): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Sin almacenamiento la preferencia dura hasta cerrar la pestaña.
  }
}
