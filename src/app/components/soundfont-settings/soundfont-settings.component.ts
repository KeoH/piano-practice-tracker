import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import type { SoundfontCandidate, SoundfontInfo } from '../../core/models';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';

/** Sección de Ajustes para elegir el SoundFont (.sf2) con el que suena el sintetizador. */
@Component({
  selector: 'app-soundfont-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <section class="flex flex-col gap-5" aria-labelledby="sf-h">
      <div>
        <h3 id="sf-h" class="mb-1.5 text-[17px] font-semibold">Sonido del piano</h3>
        <p class="text-sm leading-relaxed text-muted">El SoundFont que suena al reproducir y al oírte mientras tocas.</p>
      </div>
      @if (info(); as i) {
        <fieldset class="flex flex-col gap-2.5" [disabled]="busy()">
          <legend class="sr-only">SoundFont</legend>
          @for (c of i.candidates; track c.path) {
            @let checked = c.path === i.current_path;
            <label
              class="flex cursor-pointer items-center gap-3.5 rounded-xl border p-4 transition-colors"
              [class]="checked ? 'border-accent bg-accent/8' : 'border-line-strong bg-ink-850 hover:border-line-hover'"
            >
              <input type="radio" name="soundfont" class="h-[18px] w-[18px] shrink-0 accent-accent" [checked]="checked" (change)="choose(c.path)" />
              <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span class="truncate text-[15px] font-semibold" [title]="c.path">{{ c.name }}</span>
                <span class="text-[13px] text-muted">{{ describe(c) }}</span>
              </span>
              <span class="tabular text-xs whitespace-nowrap text-faint">{{ c.is_builtin ? 'Respaldo' : size(c.size_bytes) }}</span>
            </label>
          }
          @if (customCurrent(); as path) {
            <label class="flex items-center gap-3.5 rounded-xl border border-accent bg-accent/8 p-4">
              <input type="radio" name="soundfont" class="h-[18px] w-[18px] shrink-0 accent-accent" checked />
              <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span class="truncate text-[15px] font-semibold" [title]="path">{{ fileName(path) }}</span>
                <span class="text-[13px] text-muted">Archivo elegido por ti</span>
              </span>
            </label>
          }
        </fieldset>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="btn btn-lg" [disabled]="busy()" (click)="pickFile()">
            <app-icon name="music" [size]="16" /> Elegir otro archivo .sf2…
          </button>
          @if (busy()) {
            <span class="text-[13px] text-accent" role="status">Cargando SoundFont…</span>
          } @else {
            <span class="text-[13px] text-faint">Los archivos .sf3 no son compatibles.</span>
          }
        </div>
        @if (onlyBuiltin()) {
          <div class="rounded-xl border border-line bg-ink-850 p-4 text-[13px] leading-relaxed text-muted">
            <strong class="mb-1 block font-semibold text-fg">¿Solo tienes el piano sintético?</strong>
            Instala un SoundFont con muestras reales y reinicia la app:
            <code class="mt-2 block rounded-lg bg-ink-925 px-3 py-2 font-mono text-[12.5px] text-fg select-all">sudo apt install fluid-soundfont-gm</code>
          </div>
        }
        <p class="text-[13px] leading-normal text-faint">
          Con auriculares o altavoces Bluetooth el sonido llega unos 200 ms tarde. Para tocar oyendo la app, mejor por cable.
        </p>
      } @else {
        <p class="text-[13px] text-faint">Cargando…</p>
      }
    </section>
  `,
})
export class SoundfontSettingsComponent {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);

  protected readonly info = signal<SoundfontInfo | null>(null);
  private readonly choosing = signal(false);
  protected readonly busy = computed(() => this.choosing() || !!this.info()?.loading);
  protected readonly onlyBuiltin = computed(() => {
    const i = this.info();
    return !!i && i.candidates.every((c) => c.is_builtin);
  });
  /** SoundFont activo elegido por el usuario fuera de las carpetas conocidas. */
  protected readonly customCurrent = computed(() => {
    const i = this.info();
    return i && !i.candidates.some((c) => c.path === i.current_path) ? i.current_path : null;
  });
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    void this.refresh();
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  private async refresh(): Promise<void> {
    if (!this.api.available) return;
    try {
      const info = await this.api.getSoundfontInfo();
      this.info.set(info);
      // Al arrancar la app el SoundFont preferido se carga en segundo plano.
      if (info.loading && !this.poll) this.poll = setInterval(() => void this.refresh(), 700);
      if (!info.loading) this.stopPolling();
    } catch (err) {
      this.toast.error(err, 'No se pudo leer la configuración de sonido');
    }
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  protected async choose(path: string): Promise<void> {
    if (path === this.info()?.current_path || this.busy()) return;
    this.choosing.set(true);
    try {
      this.info.set(await this.api.setSoundfont(path));
      this.toast.success(`Sonido cambiado a ${this.fileName(path)}`);
    } catch (err) {
      this.toast.error(err, 'No se pudo cargar el SoundFont');
    } finally {
      this.choosing.set(false);
    }
  }

  protected async pickFile(): Promise<void> {
    try {
      const path = await this.api.pickSoundfontFile();
      if (path) await this.choose(path);
    } catch (err) {
      this.toast.error(err, 'No se pudo abrir el selector de archivos');
    }
  }

  protected describe(c: SoundfontCandidate): string {
    if (c.is_builtin) return 'Integrado en la app. Siempre disponible, menos realista';
    return c.path.startsWith('/usr/') ? 'Muestras reales · instalado en el sistema' : 'Muestras reales';
  }

  protected fileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  protected size(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  }
}
