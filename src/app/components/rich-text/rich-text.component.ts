import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Pinta un texto traducido con énfasis: los tramos entre `**` salen destacados. Así una frase con
 * una palabra en negrita es una sola clave de traducción y cada idioma la coloca donde quiera.
 * Uso: `<app-rich-text [text]="'session.noRawTake' | t" />`.
 */
@Component({
  selector: 'app-rich-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // En una línea y sin espacios entre bloques: cualquier blanco de la plantilla saldría en el texto.
  template: `@for (seg of segments(); track $index) {@if (seg.strong) {<strong [class]="strongClass()">{{ seg.text }}</strong>} @else {<ng-container>{{ seg.text }}</ng-container>}}`,
})
export class RichTextComponent {
  readonly text = input.required<string>();
  readonly strongClass = input('font-semibold text-fg');

  protected readonly segments = computed(() =>
    this.text()
      .split('**')
      .map((text, i) => ({ text, strong: i % 2 === 1 }))
      .filter((s) => s.text),
  );
}
