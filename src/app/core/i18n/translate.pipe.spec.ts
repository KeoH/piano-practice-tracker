import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { PluralPipe, TranslatePipe } from './translate.pipe';

describe('translate pipes', () => {
  it('translate keys and plurals in the current language', () => {
    TestBed.configureTestingModule({ providers: [TranslatePipe, PluralPipe] });
    const i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    const t = TestBed.inject(TranslatePipe);
    const tp = TestBed.inject(PluralPipe);
    expect(t.transform('sidebar.newSession')).toBe('New session');
    expect(t.transform('session.defaultTitle', { date: 'today' })).toBe('Practice today');
    expect(tp.transform('sidebar.fragmentCount', 1)).toBe(i18n.plural('sidebar.fragmentCount', 1));
    i18n.setLang('es');
    expect(t.transform('sidebar.newSession')).toBe('Nueva sesión');
  });
});
