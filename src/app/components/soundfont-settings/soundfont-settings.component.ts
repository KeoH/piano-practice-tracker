import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { SoundfontCandidate, SoundfontInfo } from '../../core/models';
import { isMacOS } from '../../core/platform';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';
import { RichTextComponent } from '../rich-text/rich-text.component';

/** Settings section to choose the SoundFont (.sf2) the synthesizer plays with. */
@Component({
  selector: 'app-soundfont-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RichTextComponent, TranslatePipe],
  template: `
    <section class="flex flex-col gap-5" aria-labelledby="sf-h">
      <div>
        <h3 id="sf-h" class="mb-1.5 text-[17px] font-semibold">{{ 'settings.sound.title' | t }}</h3>
        <p class="text-sm leading-relaxed text-muted">{{ 'settings.sound.intro' | t }}</p>
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
                <span class="truncate text-[15px] font-semibold" [title]="c.path">{{ c.is_builtin ? ('settings.sound.builtinName' | t) : c.name }}</span>
                <span class="text-[13px] text-muted">{{ describe(c) }}</span>
              </span>
              <span class="tabular text-xs whitespace-nowrap text-faint">{{ c.is_builtin ? ('settings.sound.fallback' | t) : size(c.size_bytes) }}</span>
            </label>
          }
          @if (customCurrent(); as path) {
            <label class="flex items-center gap-3.5 rounded-xl border border-accent bg-accent/8 p-4">
              <input type="radio" name="soundfont" class="h-[18px] w-[18px] shrink-0 accent-accent" checked />
              <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span class="truncate text-[15px] font-semibold" [title]="path">{{ fileName(path) }}</span>
                <span class="text-[13px] text-muted">{{ 'settings.sound.custom' | t }}</span>
              </span>
            </label>
          }
        </fieldset>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class="btn btn-lg" [disabled]="busy()" (click)="pickFile()">
            <app-icon name="music" [size]="16" /> {{ 'settings.sound.pick' | t }}
          </button>
          @if (busy()) {
            <span class="text-[13px] text-accent" role="status">{{ 'settings.sound.loading' | t }}</span>
          } @else {
            <span class="text-[13px] text-faint">{{ 'settings.sound.noSf3' | t }}</span>
          }
        </div>
        @if (onlyBuiltin()) {
          <div class="rounded-xl border border-line bg-ink-850 p-4 text-[13px] leading-relaxed text-muted">
            <strong class="mb-1 block font-semibold text-fg">{{ 'settings.sound.onlyBuiltinTitle' | t }}</strong>
            @if (isMac) {
              <app-rich-text [text]="'settings.sound.onlyBuiltinTextMac' | t" />
              <button type="button" class="btn mt-3" (click)="downloadGm()">
                <app-icon name="external" [size]="15" /> {{ 'settings.sound.downloadGm' | t }}
              </button>
            } @else {
              {{ 'settings.sound.onlyBuiltinText' | t }}
              <code class="mt-2 block rounded-lg bg-ink-925 px-3 py-2 font-mono text-[12.5px] text-fg select-all">sudo apt install fluid-soundfont-gm</code>
            }
          </div>
        }
        <p class="text-[13px] leading-normal text-faint">
          {{ 'settings.sound.bluetooth' | t }}
        </p>
      } @else {
        <p class="text-[13px] text-faint">{{ 'common.loading' | t }}</p>
      }
    </section>
  `,
})
export class SoundfontSettingsComponent {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  protected readonly info = signal<SoundfontInfo | null>(null);
  /** macOS has no package with a GM SoundFont: the hint points to a download instead of apt. */
  protected readonly isMac = isMacOS();
  private readonly choosing = signal(false);
  protected readonly busy = computed(() => this.choosing() || !!this.info()?.loading);
  protected readonly onlyBuiltin = computed(() => {
    const i = this.info();
    return !!i && i.candidates.every((c) => c.is_builtin);
  });
  /** Active SoundFont chosen by the user outside the known folders. */
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
      // On app startup the preferred SoundFont loads in the background.
      if (info.loading && !this.poll) this.poll = setInterval(() => void this.refresh(), 700);
      if (!info.loading) this.stopPolling();
    } catch (err) {
      this.toast.error(err, this.i18n.t('settings.sound.errors.read'));
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
      this.toast.success(this.i18n.t('settings.sound.changed', { name: this.fileName(path) }));
    } catch (err) {
      this.toast.error(err, this.i18n.t('settings.sound.errors.load'));
    } finally {
      this.choosing.set(false);
    }
  }

  protected async pickFile(): Promise<void> {
    try {
      const path = await this.api.pickSoundfontFile();
      if (path) await this.choose(path);
    } catch (err) {
      this.toast.error(err, this.i18n.t('settings.sound.errors.picker'));
    }
  }

  protected async downloadGm(): Promise<void> {
    try {
      await this.api.openAppLink('gm_soundfont');
    } catch (err) {
      this.toast.error(err, this.i18n.t('settings.sound.errors.openLink'));
    }
  }

  protected describe(c: SoundfontCandidate): string {
    if (c.is_builtin) return this.i18n.t('settings.sound.builtinDescription');
    const system = c.path.startsWith('/usr/') || c.path.startsWith('/Library/');
    return this.i18n.t(system ? 'settings.sound.systemSamples' : 'settings.sound.samples');
  }

  protected fileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  protected size(bytes: number): string {
    const fmt = (n: number, digits: number) =>
      n.toLocaleString(this.i18n.locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return bytes >= 1024 * 1024 ? `${fmt(bytes / (1024 * 1024), 1)} MB` : `${fmt(bytes / 1024, 0)} KB`;
  }
}
