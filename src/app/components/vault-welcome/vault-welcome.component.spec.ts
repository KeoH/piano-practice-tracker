import { TestBed } from '@angular/core/testing';
import { vaultInfo } from '../../testing/fixtures';
import { type MockApi, mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { VaultStore } from '../../core/vault.store';
import { VaultWelcomeComponent } from './vault-welcome.component';

describe('VaultWelcomeComponent', () => {
  let mock: MockApi;
  let i18n: I18nService;

  async function setup(legacy: string | null = null) {
    mock = mockApi({
      getVaultInfo: () =>
        Promise.resolve(
          vaultInfo({
            current: null,
            name: null,
            legacy_data_path: legacy,
            recent: [
              { path: '/home/me/Piano', name: 'Piano', available: true },
              { path: '/media/usb/Old', name: 'Old', available: false },
            ],
          }),
        ),
      pickFolder: () => Promise.resolve('/home/me/Dropbox'),
      createVault: (path: string) => Promise.resolve(vaultInfo({ current: path })),
      importLegacyData: (path: string) => Promise.resolve(vaultInfo({ current: path })),
      openVault: (path: string) => Promise.resolve({ info: vaultInfo({ current: path }), opened: true, lock_warning: null }),
      forgetRecentVault: () =>
        Promise.resolve(vaultInfo({ current: null, name: null, recent: [{ path: '/home/me/Piano', name: 'Piano', available: true }] })),
      getSessions: () => Promise.resolve([]),
      getPieces: () => Promise.resolve([]),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    await TestBed.inject(VaultStore).init();
    const fixture = TestBed.createComponent(VaultWelcomeComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const button = (key: Parameters<I18nService['t']>[0]) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === i18n.t(key)) as HTMLButtonElement;
    return { fixture, el, button };
  }

  it('creates a vault in the chosen folder', async () => {
    const { fixture, el, button } = await setup();
    expect(button('welcome.create.submit').disabled).toBe(true);
    button('welcome.create.choose').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('/home/me/Dropbox/PianoTracker');

    const name = el.querySelector('#vault-name') as HTMLInputElement;
    name.value = 'bad/name';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button('welcome.create.submit').disabled).toBe(true);
    name.value = 'Piano';
    name.dispatchEvent(new Event('input'));
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    expect(mock.argsOf('createVault')).toEqual(['/home/me/Dropbox/Piano']);
  });

  it('imports the previous version unless unchecked', async () => {
    const { fixture, el, button } = await setup('/home/me/.local/share/piano-tracker');
    expect(el.textContent).toContain('/home/me/.local/share/piano-tracker');
    button('welcome.create.choose').click();
    await fixture.whenStable();
    fixture.detectChanges();
    button('welcome.create.createAndImport').click();
    await fixture.whenStable();
    expect(mock.argsOf('importLegacyData')).toEqual(['/home/me/Dropbox/PianoTracker']);
    expect(mock.count('createVault')).toBe(0);
  });

  it('creates an empty vault when the import is unchecked', async () => {
    const { fixture, el, button } = await setup('/old');
    (el.querySelector('input[type=checkbox]') as HTMLInputElement).dispatchEvent(new Event('change'));
    button('welcome.create.choose').click();
    await fixture.whenStable();
    fixture.detectChanges();
    button('welcome.create.submit').click();
    await fixture.whenStable();
    expect(mock.count('importLegacyData')).toBe(0);
    expect(mock.count('createVault')).toBe(1);
  });

  it('reopens and forgets recent vaults', async () => {
    const { fixture, el } = await setup();
    const opens = [...el.querySelectorAll<HTMLButtonElement>('li .btn-link')];
    expect(opens.map((b) => b.disabled)).toEqual([false, true]);
    expect(el.textContent).toContain(i18n.t('settings.vault.unavailable', { path: '/media/usb/Old' }));
    el.querySelectorAll<HTMLButtonElement>(`[aria-label="${i18n.t('settings.vault.forget')}"]`)[1].click();
    await fixture.whenStable();
    expect(mock.argsOf('forgetRecentVault')).toEqual(['/media/usb/Old']);

    fixture.detectChanges();
    expect(el.querySelectorAll('li')).toHaveLength(1);
    el.querySelector<HTMLButtonElement>('li .btn-link')!.click();
    await fixture.whenStable();
    expect(mock.argsOf('openVault')).toEqual(['/home/me/Piano', false]);
  });
});
