import { Pipe, PipeTransform, inject } from '@angular/core';
import { I18nService } from './i18n.service';
import type { MessageKey, MessageParams, PluralKey } from './languages';

// Son impuros a propósito: así vuelven a leer el signal del idioma en cada pintura. Uno puro
// devolvería el texto en caché al cambiar de idioma (la clave no cambia). Su coste es una búsqueda
// en un Map.

/** `{{ 'sidebar.newSession' | t }}` o `{{ 'x.y' | t: { name } }}`. */
@Pipe({ name: 't', pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: MessageKey, params?: MessageParams): string {
    return this.i18n.t(key, params);
  }
}

/** `{{ 'sidebar.fragmentCount' | tp: n }}`: elige `_zero` / `_one` / `_other` según `n`. */
@Pipe({ name: 'tp', pure: false })
export class PluralPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: PluralKey, n: number, params?: MessageParams): string {
    return this.i18n.plural(key, n, params);
  }
}
