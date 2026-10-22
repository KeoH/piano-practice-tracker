import { TestBed } from '@angular/core/testing';
import { GM_FAMILY_COUNT, familyKey, familyOf, programKey } from './gm';
import { I18nService } from './i18n/i18n.service';

describe('gm', () => {
  it('groups the 128 programs in 16 families', () => {
    expect(familyOf(0)).toBe(0);
    expect(familyOf(7)).toBe(0);
    expect(familyOf(8)).toBe(1);
    expect(familyOf(127)).toBe(GM_FAMILY_COUNT - 1);
  });

  it('builds the translation keys', () => {
    expect(programKey(40)).toBe('gm.program.40');
    expect(familyKey(5)).toBe('gm.family.5');
    const i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    expect(i18n.t(programKey(0))).not.toBe('gm.program.0');
    expect(i18n.t(familyKey(15))).not.toBe('gm.family.15');
  });
});
