import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Renders a translated text with emphasis: the parts between `**` are highlighted. That way a
 * sentence with a bold word is a single translation key and each language places it where it wants.
 * Usage: `<app-rich-text [text]="'session.noRawTake' | t" />`.
 */
@Component({
  selector: 'app-rich-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // On one line with no spaces between blocks: any template whitespace would end up in the text.
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
