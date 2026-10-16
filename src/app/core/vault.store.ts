import { Injectable, computed, inject, signal } from '@angular/core';
import { ConfirmService } from './confirm.service';
import { I18nService } from './i18n/i18n.service';
import type { VaultInfo } from './models';
import { PlaybackStore } from './playback.store';
import { RecordingStore } from './recording.store';
import { SessionStore } from './session.store';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/**
 * Bóveda de datos: carpeta elegida por el usuario donde viven la base de datos, los MIDI y las
 * imágenes. Sin bóveda abierta la app muestra la pantalla de bienvenida.
 */
@Injectable({ providedIn: 'root' })
export class VaultStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly confirm = inject(ConfirmService);
  private readonly sessions = inject(SessionStore);
  private readonly playback = inject(PlaybackStore);
  private readonly recording = inject(RecordingStore);

  readonly info = signal<VaultInfo | null>(null);
  /** Ya se consultó el backend (evita parpadeos de la bienvenida al arrancar). */
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly settingsOpen = signal(false);

  /** Raíz absoluta de la bóveda abierta. */
  readonly root = computed(() => this.info()?.current ?? null);
  readonly isOpen = computed(() => !!this.root());
  readonly name = computed(() => this.info()?.name ?? null);

  async init(): Promise<void> {
    if (!this.api.available) {
      this.loaded.set(true);
      return;
    }
    try {
      this.apply(await this.api.getVaultInfo(), true);
      if (this.isOpen()) await this.sessions.refreshList();
    } catch (err) {
      this.toast.error(err, this.i18n.t('vault.errors.read'));
    } finally {
      this.loaded.set(true);
    }
  }

  /** Vuelve a pedir el estado (p. ej. tras cambiar de idioma, porque los avisos vienen traducidos). */
  async refreshInfo(): Promise<void> {
    if (!this.api.available) return;
    try {
      this.apply(await this.api.getVaultInfo());
    } catch (err) {
      console.warn('No se pudo actualizar la bóveda:', err);
    }
  }

  /** Une carpeta y nombre de la bóveda nueva. */
  static join(parent: string, name: string): string {
    return `${parent.replace(/\/+$/, '')}/${name.trim()}`;
  }

  /** Abre una bóveda existente; si parece abierta en otro equipo pide confirmación. */
  async open(path: string): Promise<boolean> {
    return this.run(this.i18n.t('vault.errors.open'), async () => {
      let res = await this.api.openVault(path, false);
      if (!res.opened && res.lock_warning) {
        const ok = await this.confirm.ask({
          title: this.i18n.t('vault.lockTitle'),
          message: res.lock_warning,
          confirmLabel: this.i18n.t('vault.openAnyway'),
          danger: true,
        });
        if (!ok) return false;
        res = await this.api.openVault(path, true);
      }
      if (!res.opened) return false;
      await this.switched(res.info);
      return true;
    });
  }

  /** Diálogo de carpeta y abrir. */
  async pickAndOpen(): Promise<boolean> {
    const path = await this.pick(this.i18n.t('vault.pickOpenTitle'));
    return path ? this.open(path) : false;
  }

  async create(parent: string, name: string): Promise<boolean> {
    return this.run(this.i18n.t('vault.errors.create'), async () => {
      await this.switched(await this.api.createVault(VaultStore.join(parent, name)));
      this.toast.success(this.i18n.t('vault.created'));
      return true;
    });
  }

  async importLegacy(parent: string, name: string): Promise<boolean> {
    return this.run(this.i18n.t('vault.errors.import'), async () => {
      await this.switched(await this.api.importLegacyData(VaultStore.join(parent, name)));
      this.toast.success(this.i18n.t('vault.imported'));
      return true;
    });
  }

  /** Cierra la bóveda actual y vuelve a la pantalla de bienvenida. */
  async close(): Promise<boolean> {
    if (this.recording.isRecording()) {
      this.toast.warning(this.i18n.t('vault.stopRecordingFirst'));
      return false;
    }
    return this.run(this.i18n.t('vault.errors.close'), async () => {
      await this.playback.stop();
      this.apply(await this.api.closeVault());
      this.sessions.reset();
      this.settingsOpen.set(false);
      return true;
    });
  }

  async forget(path: string): Promise<void> {
    try {
      this.apply(await this.api.forgetRecentVault(path));
    } catch (err) {
      this.toast.error(err, this.i18n.t('vault.errors.forget'));
    }
  }

  async reveal(): Promise<void> {
    try {
      await this.api.revealVault();
    } catch (err) {
      this.toast.error(err, this.i18n.t('vault.errors.reveal'));
    }
  }

  async pick(title: string): Promise<string | null> {
    try {
      return await this.api.pickFolder(title);
    } catch (err) {
      this.toast.error(err, this.i18n.t('vault.errors.picker'));
      return null;
    }
  }

  /** Ruta servible por el webview para una imagen del Markdown (relativa a la bóveda o absoluta). */
  resolveAsset(path: string): string {
    const root = this.root();
    const abs = path.startsWith('/') || !root ? path : `${root.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`;
    return this.api.fileSrc(abs);
  }

  private async switched(info: VaultInfo): Promise<void> {
    await this.playback.stop();
    this.apply(info, true);
    this.sessions.reset();
    this.settingsOpen.set(false);
    await this.sessions.refreshList();
  }

  private apply(info: VaultInfo, announce = false): void {
    this.info.set(info);
    if (announce) for (const w of info.warnings) this.toast.warning(w);
  }

  private async run(errorPrefix: string, fn: () => Promise<boolean>): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    try {
      return await fn();
    } catch (err) {
      this.toast.error(err, errorPrefix);
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
