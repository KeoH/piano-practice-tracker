import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import type { AppInfo, AppLink } from '../../core/models';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';

/** Settings section with the version, author and license (read from `Cargo.toml` by the backend). */
@Component({
  selector: 'app-about-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe],
  template: `
    <section class="flex flex-col gap-5.5" aria-labelledby="about-h">
      <div>
        <h3 id="about-h" class="mb-1.5 text-[17px] font-semibold">{{ 'settings.about.title' | t }}</h3>
        <p class="text-sm leading-relaxed text-muted">{{ 'settings.about.intro' | t }}</p>
      </div>

      @let i = info();
      <div class="flex items-center gap-4 rounded-[14px] border border-line bg-ink-850 p-4.5">
        <img src="app-icon.png" alt="" width="56" height="56" class="h-14 w-14 shrink-0" />
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-[17px] font-semibold text-fg-strong">{{ i?.name ?? 'Piano Practice Tracker' }}</span>
          <span class="tabular text-[13px] text-muted">{{ 'settings.about.version' | t: { version: i?.version ?? '—' } }}</span>
        </span>
      </div>

      <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
        <dt class="text-muted">{{ 'settings.about.author' | t }}</dt>
        <dd class="text-fg">{{ i ? i.authors.join(', ') : '—' }}</dd>
        <dt class="text-muted">{{ 'settings.about.license' | t }}</dt>
        <dd class="text-fg">{{ i?.license || '—' }}</dd>
        <dt class="text-muted">{{ 'settings.about.builtWith' | t }}</dt>
        <dd class="tabular text-fg">{{ i ? 'Tauri ' + i.tauri_version : '—' }}</dd>
      </dl>

      <div class="flex flex-wrap gap-2.5">
        <button type="button" class="btn" (click)="open('homepage')" [disabled]="!i">
          <app-icon name="external" [size]="15" /> {{ 'settings.about.website' | t }}
        </button>
        <button type="button" class="btn" (click)="open('repository')" [disabled]="!i">
          <app-icon name="external" [size]="15" /> {{ 'settings.about.source' | t }}
        </button>
        <button type="button" class="btn btn-ghost" (click)="open('license')" [disabled]="!i">
          <app-icon name="external" [size]="15" /> {{ 'settings.about.viewLicense' | t }}
        </button>
      </div>

      @if (i) {
        <p class="text-[13px] text-faint">© 2026 {{ i.authors.join(', ') }}</p>
      }
    </section>
  `,
})
export class AboutSettingsComponent {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  protected readonly info = signal<AppInfo | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!this.api.available) return;
    try {
      this.info.set(await this.api.getAppInfo());
    } catch (err) {
      this.toast.error(err, this.i18n.t('settings.about.errors.load'));
    }
  }

  protected async open(link: AppLink): Promise<void> {
    try {
      await this.api.openAppLink(link);
    } catch (err) {
      this.toast.error(err, this.i18n.t('settings.about.errors.open'));
    }
  }
}
