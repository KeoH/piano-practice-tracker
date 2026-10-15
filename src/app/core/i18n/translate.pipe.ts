import { Pipe, PipeTransform, inject } from '@angular/core';
import { I18nService } from './i18n.service';
import type { MessageKey, MessageParams, PluralKey } from './languages';

// They are impure on purpose: that way they read the language signal again on every render. A pure
// pipe would return the cached text after a language change (the key does not change). Their cost
// is one Map lookup.

/** `{{ 'sidebar.newSession' | t }}` or `{{ 'x.y' | t: { name } }}`. */
@Pipe({ name: 't', pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: MessageKey, params?: MessageParams): string {
    return this.i18n.t(key, params);
  }
}

/** `{{ 'sidebar.fragmentCount' | tp: n }}`: picks `_zero` / `_one` / `_other` based on `n`. */
@Pipe({ name: 'tp', pure: false })
export class PluralPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: PluralKey, n: number, params?: MessageParams): string {
    return this.i18n.plural(key, n, params);
  }
}
