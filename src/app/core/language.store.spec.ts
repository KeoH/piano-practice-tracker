import { TestBed } from '@angular/core/testing';
import { type MockApi, mockApi } from '../testing/mock-api';
import { I18nService } from './i18n/i18n.service';
import { LanguageStore } from './language.store';
import { ToastService } from './toast.service';

describe('LanguageStore', () => {
  let mock: MockApi;
  let i18n: I18nService;

  function setup(overrides: Parameters<typeof mockApi>[0] = {}) {
    mock = mockApi(overrides);
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    return TestBed.inject(LanguageStore);
  }

  afterEach(() => localStorage.clear());

  it('applies what the backend says and refreshes the vault messages', async () => {
    const store = setup({
      getLanguage: () => Promise.resolve({ preference: null, effective: 'es', system: 'es' }),
      setLanguage: (lang: string | null) => Promise.resolve({ preference: lang, effective: lang ?? 'es', system: 'es' }),
      getVaultInfo: () => Promise.resolve({ current: null, name: null, recent: [], legacy_data_path: null, warnings: [] }),
    });
    await store.init();
    expect(store.preference()).toBeNull();
    expect(store.system()).toBe('es');
    expect(i18n.lang()).toBe('es');

    await store.set('en');
    expect(store.preference()).toBe('en');
    expect(i18n.lang()).toBe('en');
    expect(mock.names()).toContain('getVaultInfo');
  });

  it('reports a failure to change it', async () => {
    const store = setup({ setLanguage: () => Promise.reject('read-only config') });
    await store.set('es');
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message).toContain('read-only config');
  });

  it('only warns when it cannot read it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = setup({ getLanguage: () => Promise.reject('x') });
    await store.init();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('uses localStorage without the backend', async () => {
    localStorage.setItem('piano-tracker.language', 'es');
    const store = setup({ available: false });
    await store.init();
    expect(store.preference()).toBe('es');
    expect(i18n.lang()).toBe('es');

    await store.set(null);
    expect(localStorage.getItem('piano-tracker.language')).toBeNull();
    expect(i18n.lang()).toBe(store.system());
    await store.set('en');
    expect(localStorage.getItem('piano-tracker.language')).toBe('en');
    expect(mock.calls).toEqual([]);
  });
});
