import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { normalizeLang } from './languages';

describe('I18nService', () => {
  let i18n: I18nService;

  beforeEach(() => {
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
  });

  describe('t', () => {
    it('returns the text in the current language', () => {
      expect(i18n.t('sidebar.newSession')).toBe('New session');
      i18n.setLang('es');
      expect(i18n.t('sidebar.newSession')).toBe('Nueva sesión');
    });

    it('replaces placeholders and keeps unknown ones', () => {
      expect(i18n.t('session.defaultTitle', { date: 'Oct 15' })).toBe('Practice Oct 15');
      expect(i18n.t('session.defaultTitle', { other: 1 })).toBe('Practice {date}');
    });

    it('returns the key itself when it does not exist', () => {
      expect(i18n.t('does.not.exist' as never)).toBe('does.not.exist');
    });
  });

  describe('plural', () => {
    it('chooses one / other', () => {
      expect(i18n.plural('session.fragmentCount', 1)).toBe('1 fragment');
      expect(i18n.plural('session.fragmentCount', 3)).toBe('3 fragments');
    });

    it('uses _zero when the language has it', () => {
      expect(i18n.plural('sidebar.fragmentCount', 0)).toBe('no fragments');
      i18n.setLang('es');
      expect(i18n.plural('sidebar.fragmentCount', 0)).toBe('sin fragmentos');
    });

    it('falls back to _other for zero when there is no _zero', () => {
      expect(i18n.plural('session.fragmentCount', 0)).toBe('0 fragments');
    });

    it('accepts extra params', () => {
      expect(i18n.plural('fragments.deleteMessage', 2, { title: 'Etude' })).toContain('“Etude” and its 2 comments');
    });
  });

  describe('setLang', () => {
    it('normalizes system tags and updates <html lang>', () => {
      i18n.setLang('es_ES.UTF-8');
      expect(i18n.lang()).toBe('es');
      expect(i18n.locale()).toBe('es-ES');
      expect(document.documentElement.lang).toBe('es');
    });

    it('falls back to English for unknown languages', () => {
      i18n.setLang('fr-FR');
      expect(i18n.lang()).toBe('en');
      expect(i18n.locale()).toBe('en-US');
    });
  });

  describe('dateGroup', () => {
    // Thursday, 15 October 2026: the week starts on Monday the 12th.
    const now = new Date(2026, 9, 15, 12, 0);

    it('groups the current and previous week', () => {
      expect(i18n.dateGroup(new Date(2026, 9, 12, 0, 1).toISOString(), now)).toBe('This week');
      expect(i18n.dateGroup(new Date(2026, 9, 11, 23, 0).toISOString(), now)).toBe('Last week');
      expect(i18n.dateGroup(new Date(2026, 9, 5, 9, 0).toISOString(), now)).toBe('Last week');
    });

    it('uses the month, with the year when it is not the current one', () => {
      expect(i18n.dateGroup(new Date(2026, 8, 20).toISOString(), now)).toBe('September');
      expect(i18n.dateGroup(new Date(2025, 2, 3).toISOString(), now)).toBe('March 2025');
      i18n.setLang('es');
      expect(i18n.dateGroup(new Date(2026, 8, 20).toISOString(), now)).toBe('Septiembre');
    });

    it('handles missing or invalid dates', () => {
      expect(i18n.dateGroup(null, now)).toBe('No date');
      expect(i18n.dateGroup('not a date', now)).toBe('No date');
    });
  });

  describe('dates', () => {
    it('returns the input when it cannot parse it', () => {
      expect(i18n.longDate('garbage')).toBe('garbage');
      expect(i18n.shortDate(undefined)).toBe('');
    });
  });
});

describe('normalizeLang', () => {
  it('maps tags to available languages', () => {
    expect(normalizeLang('es')).toBe('es');
    expect(normalizeLang('EN-us')).toBe('en');
    expect(normalizeLang('es_ES.UTF-8')).toBe('es');
    expect(normalizeLang('de')).toBeNull();
    expect(normalizeLang(null)).toBeNull();
  });
});
