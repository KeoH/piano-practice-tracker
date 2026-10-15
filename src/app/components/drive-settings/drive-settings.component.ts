import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { formatRelative } from '../../core/format';
import { SyncStore } from '../../core/sync.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent, type IconName } from '../icon/icon.component';
import { SoundfontSettingsComponent } from '../soundfont-settings/soundfont-settings.component';

/** Modal de ajustes en dos secciones: sonido (SoundFont) y copia en Google Drive (estado, credenciales y cuenta). */
@Component({
  selector: 'app-drive-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SoundfontSettingsComponent],
  templateUrl: './drive-settings.component.html',
})
export class DriveSettingsComponent {
  protected readonly sync = inject(SyncStore);
  protected readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);

  protected readonly clientId = signal('');
  protected readonly clientSecret = signal('');
  protected readonly saving = signal(false);
  protected readonly connecting = signal(false);
  protected readonly authUrl = signal<string | null>(null);
  protected readonly tab = signal<'sound' | 'drive'>('sound');
  /** Formulario de credenciales abierto (null = abierto solo si aún no hay credenciales). */
  protected readonly credsToggle = signal<boolean | null>(null);

  protected readonly hasCredentials = computed(() => !!this.sync.status()?.has_credentials);
  protected readonly credsOpen = computed(() => this.credsToggle() ?? !this.hasCredentials());

  /** Resumen grande del estado de la copia. */
  protected readonly hero = computed<{ title: string; detail: string; icon: IconName; box: string; iconBox: string }>(() => {
    const s = this.sync.status();
    const neutral = { box: 'border-line bg-ink-850', iconBox: 'bg-ink-700 text-fg-soft' };
    const warn = { box: 'border-accent/30 bg-accent/10', iconBox: 'bg-accent/15 text-accent' };
    const last = `Última sincronización: ${formatRelative(s?.last_sync_at)}`;
    if (!s) return { title: 'Comprobando el estado…', detail: '', icon: 'cloud', ...neutral };
    if (!s.has_credentials)
      return { title: 'Copia sin configurar', detail: 'Sigue los dos pasos de abajo para activarla.', icon: 'cloud', ...neutral };
    if (!s.connected)
      return { title: 'Cuenta sin conectar', detail: 'Conecta tu cuenta de Google para empezar a subir.', icon: 'cloud', ...neutral };
    if (s.is_syncing) return { title: 'Sincronizando…', detail: last, icon: 'refresh', ...warn };
    if (s.error_count > 0 || s.last_error)
      return {
        title: 'Hay errores al subir',
        detail: `${s.error_count} elemento(s) con error · ${last}`,
        icon: 'alert',
        box: 'border-rec/30 bg-rec/10',
        iconBox: 'bg-rec/15 text-rec-soft',
      };
    if (!s.online)
      return { title: 'Sin conexión', detail: `${s.pending_count} cambio(s) esperando red · ${last}`, icon: 'cloud-up', ...warn };
    if (s.pending_count > 0)
      return { title: `${s.pending_count} cambio(s) pendientes de subir`, detail: last, icon: 'cloud-up', ...warn };
    return {
      title: 'Tu copia está al día',
      detail: last,
      icon: 'cloud-check',
      box: 'border-ok/25 bg-ok/10',
      iconBox: 'bg-ok/15 text-ok',
    };
  });

  /** Punto de estado junto a «Google Drive» en la navegación. */
  protected readonly heroDot = computed(() => {
    switch (this.sync.summary().tone) {
      case 'ok':
        return 'bg-ok';
      case 'err':
        return 'bg-rec';
      case 'warn':
      case 'busy':
        return 'bg-accent';
      default:
        return 'bg-faint';
    }
  });
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  protected close(): void {
    this.sync.settingsOpen.set(false);
  }

  protected async saveCredentials(): Promise<void> {
    const id = this.clientId().trim();
    const secret = this.clientSecret().trim();
    if (!id || !secret) {
      this.toast.warning('Introduce el ID de cliente y el secreto');
      return;
    }
    this.saving.set(true);
    try {
      await this.api.saveGoogleCredentials(id, secret);
      this.clientSecret.set('');
      this.credsToggle.set(false);
      this.toast.success('Credenciales guardadas');
      await this.sync.refresh();
    } catch (err) {
      this.toast.error(err, 'No se pudieron guardar las credenciales');
    } finally {
      this.saving.set(false);
    }
  }

  protected async connect(): Promise<void> {
    this.connecting.set(true);
    try {
      const url = await this.api.startGoogleAuth();
      this.authUrl.set(url);
      this.toast.info('Completa la autorización en el navegador');
      // Re-consulta el estado durante unos segundos mientras el usuario autoriza
      let tries = 0;
      this.stopPolling();
      this.poll = setInterval(async () => {
        tries++;
        await this.sync.refresh(true);
        if (this.sync.connected() || tries > 60) this.stopPolling();
      }, 3000);
    } catch (err) {
      this.toast.error(err, 'No se pudo iniciar la autorización');
    } finally {
      this.connecting.set(false);
    }
  }

  protected async copyUrl(): Promise<void> {
    const url = this.authUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success('URL copiada');
    } catch {
      this.toast.warning('No se pudo copiar; selecciona el texto manualmente');
    }
  }

  protected async openUrl(): Promise<void> {
    const url = this.authUrl();
    if (!url) return;
    try {
      await this.api.openExternal(url);
    } catch (err) {
      this.toast.error(err, 'No se pudo abrir el navegador');
    }
  }
}
