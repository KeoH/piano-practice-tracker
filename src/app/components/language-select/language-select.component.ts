import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { normalizeLang } from '../../core/i18n/languages';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { LanguageStore } from '../../core/language.store';

const AUTO = 'auto';

/**
 * Selector de idioma: «Automático (el del sistema)» o uno concreto. Cada idioma se muestra con su
 * nombre en ese idioma, para que se reconozca aunque la interfaz esté en otro.
 */
@Component({
  selector: 'app-language-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    <label [for]="selectId()" class="sr-only">{{ 'settings.general.language' | t }}</label>
    <select [id]="selectId()" class="field" [class]="fieldClass()" (change)="choose($any($event.target).value)">
      <option [value]="AUTO" [selected]="lang.preference() === null">{{ 'settings.general.auto' | t: { lang: systemName() } }}</option>
      @for (l of i18n.languages; track l.code) {
        <option [value]="l.code" [attr.lang]="l.code" [selected]="lang.preference() === l.code">{{ l.name }}</option>
      }
    </select>
  `,
})
export class LanguageSelectComponent {
  protected readonly i18n = inject(I18nService);
  protected readonly lang = inject(LanguageStore);

  readonly selectId = input('language-select');
  readonly fieldClass = input('');

  protected readonly AUTO = AUTO;
  protected readonly systemName = computed(
    () => this.i18n.languages.find((l) => l.code === this.lang.system())?.name ?? this.lang.system(),
  );

  protected choose(value: string): void {
    void this.lang.set(value === AUTO ? null : normalizeLang(value));
  }
}
