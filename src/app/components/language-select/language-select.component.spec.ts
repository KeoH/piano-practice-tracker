import { TestBed } from '@angular/core/testing';
import { mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { LanguageStore } from '../../core/language.store';
import { LanguageSelectComponent } from './language-select.component';

describe('LanguageSelectComponent', () => {
  afterEach(() => localStorage.clear());

  it('offers automatic plus every language and applies the choice', async () => {
    TestBed.configureTestingModule({ providers: [mockApi({ available: false }).provider] });
    const i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    const lang = TestBed.inject(LanguageStore);
    lang.system.set('es');
    const fixture = TestBed.createComponent(LanguageSelectComponent);
    fixture.componentRef.setInput('selectId', 'lang');
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('#lang');
    expect(select.options).toHaveLength(i18n.languages.length + 1);
    expect(select.options[0].textContent).toContain('Español');

    select.value = 'es';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(lang.preference()).toBe('es');
    expect(i18n.lang()).toBe('es');

    select.value = 'auto';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(lang.preference()).toBeNull();
  });
});
