import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { TauriApiService } from '../../core/tauri-api.service';
import { VaultStore } from '../../core/vault.store';
import { IconComponent } from '../icon/icon.component';
import { LanguageSelectComponent } from '../language-select/language-select.component';

const DEFAULT_NAME = 'PianoTracker';

/**
 * Pantalla sin bóveda abierta: crear una nueva (nombre + ubicación), abrir una existente,
 * reabrir una reciente o importar los datos de la versión anterior. Es lo primero que ve una
 * instalación nueva, así que también deja elegir el idioma.
 */
@Component({
  selector: 'app-vault-welcome',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, LanguageSelectComponent, TranslatePipe],
  template: `
    <div class="flex min-h-full items-center justify-center px-4 py-10">
      <div class="flex w-full max-w-[640px] flex-col gap-6">
        <div class="-mb-2 flex items-center justify-end gap-2 text-muted">
          <app-icon name="globe" [size]="16" />
          <app-language-select selectId="welcome-language" fieldClass="h-9 w-auto text-[13px]" />
        </div>
        <header class="flex flex-col gap-2">
          <span class="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
            <app-icon name="piano" [size]="24" />
          </span>
          <h1 class="text-[26px] font-semibold text-fg-strong">{{ 'welcome.title' | t }}</h1>
          <p class="text-sm leading-relaxed text-muted">
            {{ 'welcome.intro' | t }}
          </p>
        </header>

        @if (vault.info()?.legacy_data_path; as legacy) {
          <section class="panel flex flex-col gap-3 border-accent/40 p-5" aria-labelledby="legacy-h">
            <h2 id="legacy-h" class="text-[15px] font-semibold">{{ 'welcome.legacy.title' | t }}</h2>
            <p class="text-[13px] leading-relaxed text-muted">
              {{ 'welcome.legacy.location' | t }} <span class="font-mono text-fg">{{ legacy }}</span>.
              {{ 'welcome.legacy.text' | t }}
            </p>
            <label class="flex items-center gap-2.5 text-sm">
              <input type="checkbox" class="h-4 w-4 accent-accent" [checked]="importLegacy()" (change)="importLegacy.set(!importLegacy())" />
              {{ 'welcome.legacy.import' | t }}
            </label>
          </section>
        }

        <section class="panel flex flex-col gap-4 p-5" aria-labelledby="create-h">
          <h2 id="create-h" class="text-[15px] font-semibold">{{ 'welcome.create.title' | t }}</h2>
          <div>
            <label class="label mb-1.5 block" for="vault-name">{{ 'welcome.create.name' | t }}</label>
            <input
              id="vault-name"
              class="field"
              type="text"
              spellcheck="false"
              [value]="name()"
              (input)="name.set($any($event.target).value)"
              (keydown.enter)="create()"
            />
          </div>
          <div>
            <span class="label mb-1.5 block">{{ 'welcome.create.location' | t }}</span>
            <div class="flex items-center gap-2.5">
              <span class="field flex min-w-0 flex-1 items-center truncate font-mono text-[13px]" [class.text-faint]="!parent()">
                {{ parent() ?? ('welcome.create.locationPlaceholder' | t) }}
              </span>
              <button type="button" class="btn" (click)="pickParent()" [disabled]="!api.available || vault.busy()">
                <app-icon name="folder" [size]="15" /> {{ 'welcome.create.choose' | t }}
              </button>
            </div>
          </div>
          @if (target(); as t) {
            <p class="text-[13px] text-muted">{{ 'welcome.create.willCreate' | t }} <span class="font-mono text-fg">{{ t }}</span></p>
          }
          <button type="button" class="btn btn-primary btn-lg self-start" (click)="create()" [disabled]="!target() || vault.busy()">
            {{ (vault.busy() ? 'welcome.create.preparing' : importLegacy() && vault.info()?.legacy_data_path ? 'welcome.create.createAndImport' : 'welcome.create.submit') | t }}
          </button>
        </section>

        <section class="panel flex flex-col gap-3 p-5" aria-labelledby="open-h">
          <div class="flex flex-wrap items-center gap-3">
            <h2 id="open-h" class="flex-1 text-[15px] font-semibold">{{ 'welcome.open.title' | t }}</h2>
            <button type="button" class="btn" (click)="vault.pickAndOpen()" [disabled]="!api.available || vault.busy()">
              <app-icon name="folder" [size]="15" /> {{ 'welcome.open.folder' | t }}
            </button>
          </div>
          @if (vault.info()?.recent?.length) {
            <ul class="overflow-hidden rounded-xl border border-line">
              @for (r of vault.info()!.recent; track r.path) {
                <li class="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0">
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate text-sm font-medium" [class.text-faint]="!r.available">{{ r.name }}</span>
                    <span class="truncate font-mono text-xs text-faint" [title]="r.path">{{ r.available ? r.path : ('settings.vault.unavailable' | t: { path: r.path }) }}</span>
                  </span>
                  <button type="button" class="btn btn-link" (click)="vault.open(r.path)" [disabled]="!r.available || vault.busy()">{{ 'settings.vault.open' | t }}</button>
                  <button type="button" class="btn btn-ghost btn-icon" (click)="vault.forget(r.path)" [attr.aria-label]="'settings.vault.forget' | t" [title]="'settings.vault.forget' | t">
                    <app-icon name="close" [size]="15" />
                  </button>
                </li>
              }
            </ul>
          }
        </section>
      </div>
    </div>
  `,
  host: { class: 'block h-full overflow-y-auto bg-ink-900' },
})
export class VaultWelcomeComponent {
  protected readonly vault = inject(VaultStore);
  protected readonly api = inject(TauriApiService);
  private readonly i18n = inject(I18nService);

  protected readonly name = signal(DEFAULT_NAME);
  protected readonly parent = signal<string | null>(null);
  protected readonly importLegacy = signal(true);

  /** Ruta completa de la bóveda nueva. */
  protected readonly target = computed(() => {
    const parent = this.parent();
    const name = this.name().trim();
    if (!parent || !name || /[/\\]/.test(name) || name === '.' || name === '..') return null;
    return VaultStore.join(parent, name);
  });

  protected async pickParent(): Promise<void> {
    const picked = await this.vault.pick(this.i18n.t('welcome.create.pickTitle'));
    if (picked) this.parent.set(picked);
  }

  protected async create(): Promise<void> {
    const parent = this.parent();
    if (!parent || !this.target()) return;
    if (this.importLegacy() && this.vault.info()?.legacy_data_path) {
      await this.vault.importLegacy(parent, this.name());
    } else {
      await this.vault.create(parent, this.name());
    }
  }
}
