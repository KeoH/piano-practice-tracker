import { TestBed } from '@angular/core/testing';
import { RichTextComponent } from './rich-text.component';

describe('RichTextComponent', () => {
  function render(text: string, strongClass?: string): HTMLElement {
    const fixture = TestBed.createComponent(RichTextComponent);
    fixture.componentRef.setInput('text', text);
    if (strongClass) fixture.componentRef.setInput('strongClass', strongClass);
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  it('highlights the parts between double asterisks', () => {
    const el = render('Press **Record** to **start**.');
    expect(el.textContent).toBe('Press Record to start.');
    expect([...el.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(['Record', 'start']);
  });

  it('renders plain text and custom emphasis', () => {
    expect(render('No emphasis').querySelector('strong')).toBeNull();
    const el = render('**Only**', 'text-accent');
    expect(el.querySelector('strong')?.className).toBe('text-accent');
  });
});
