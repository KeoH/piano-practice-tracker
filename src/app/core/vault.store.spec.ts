import { TestBed } from '@angular/core/testing';
import { vaultInfo } from '../testing/fixtures';
import { type MockApi, flush, mockApi } from '../testing/mock-api';
import { ConfirmService } from './confirm.service';
import { I18nService } from './i18n/i18n.service';
import { NavStore } from './nav.store';
import { RecordingStore } from './recording.store';
import { SessionStore } from './session.store';
import { ToastService } from './toast.service';
import { VaultStore } from './vault.store';

const closed = vaultInfo({ current: null, name: null });

describe('VaultStore', () => {
  let store: VaultStore;
  let mock: MockApi;
  let toast: ToastService;

  function setup(overrides: Parameters<typeof mockApi>[0] = {}) {
    mock = mockApi({
      getVaultInfo: () => Promise.resolve(vaultInfo({ warnings: ['Conflicted copy found'] })),
      getSessions: () => Promise.resolve([]),
      getPieces: () => Promise.resolve([]),
      openVault: (path: string) => Promise.resolve({ info: vaultInfo({ current: path }), opened: true, lock_warning: null }),
      createVault: (path: string) => Promise.resolve(vaultInfo({ current: path })),
      importLegacyData: (path: string) => Promise.resolve(vaultInfo({ current: path })),
      closeVault: () => Promise.resolve(closed),
      forgetRecentVault: () => Promise.resolve(vaultInfo({ recent: [] })),
      pickFolder: () => Promise.resolve('/home/me/Other'),
      ...overrides,
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(VaultStore);
    toast = TestBed.inject(ToastService);
  }

  it('loads the open vault, announces its warnings and lists its data', async () => {
    setup();
    await store.init();
    expect(store.loaded()).toBe(true);
    expect(store.isOpen()).toBe(true);
    expect(store.name()).toBe('Vault');
    expect(toast.toasts().map((t) => t.message)).toEqual(['Conflicted copy found']);
    expect(mock.names()).toEqual(expect.arrayContaining(['getSessions', 'getPieces']));
  });

  it('starts without a vault when the backend is missing or fails', async () => {
    setup({ available: false });
    await store.init();
    expect(store.loaded()).toBe(true);
    expect(store.isOpen()).toBe(false);

    TestBed.resetTestingModule();
    setup({ getVaultInfo: () => Promise.reject('config broken') });
    await store.init();
    expect(store.loaded()).toBe(true);
    expect(toast.toasts().at(-1)?.message).toContain('config broken');
  });

  it('joins the folder and the name', () => {
    expect(VaultStore.join('/home/me/', ' Piano ')).toBe('/home/me/Piano');
    expect(VaultStore.join('/home/me', 'Piano')).toBe('/home/me/Piano');
  });

  it('opens a vault and resets what the previous one loaded', async () => {
    setup();
    const sessions = TestBed.inject(SessionStore);
    sessions.selectedId.set('old');
    TestBed.inject(NavStore).view.set('stats');
    store.settingsOpen.set(true);
    expect(await store.open('/home/me/Other')).toBe(true);
    expect(store.root()).toBe('/home/me/Other');
    expect(sessions.selectedId()).toBeNull();
    expect(TestBed.inject(NavStore).view()).toBe('sessions');
    expect(store.settingsOpen()).toBe(false);
  });

  it('asks before opening a vault locked by another computer', async () => {
    setup({
      openVault: (path: string, force: boolean) =>
        Promise.resolve(
          force
            ? { info: vaultInfo({ current: path }), opened: true, lock_warning: null }
            : { info: closed, opened: false, lock_warning: 'Open on laptop since 10:00' },
        ),
    });
    const confirm = TestBed.inject(ConfirmService);

    const declined = store.open('/v');
    await flush();
    expect(confirm.current()?.message).toBe('Open on laptop since 10:00');
    confirm.answer(false);
    expect(await declined).toBe(false);

    const accepted = store.open('/v');
    await flush();
    confirm.answer(true);
    expect(await accepted).toBe(true);
    expect(mock.argsOf('openVault')).toEqual(['/v', true]);
  });

  it('does not open when the backend refuses without a warning, nor twice at once', async () => {
    setup({ openVault: () => Promise.resolve({ info: closed, opened: false, lock_warning: null }) });
    expect(await store.open('/v')).toBe(false);
    store.busy.set(true);
    expect(await store.open('/v')).toBe(false);
  });

  it('picks a folder and opens it', async () => {
    setup();
    expect(await store.pickAndOpen()).toBe(true);
    expect(mock.argsOf('openVault')).toEqual(['/home/me/Other', false]);

    mock.set('pickFolder', () => Promise.resolve(null));
    expect(await store.pickAndOpen()).toBe(false);
    mock.set('pickFolder', () => Promise.reject('no portal'));
    expect(await store.pick('Title')).toBeNull();
  });

  it('creates and imports vaults', async () => {
    setup();
    expect(await store.create('/home/me', 'New')).toBe(true);
    expect(mock.argsOf('createVault')).toEqual(['/home/me/New']);
    expect(await store.importLegacy('/home/me', 'Old')).toBe(true);
    expect(mock.argsOf('importLegacyData')).toEqual(['/home/me/Old']);
    mock.set('createVault', () => Promise.reject('not empty'));
    expect(await store.create('/home/me', 'Full')).toBe(false);
    expect(toast.toasts().at(-1)?.message).toContain('not empty');
  });

  it('closes the vault unless it is recording', async () => {
    setup();
    await store.init();
    TestBed.inject(RecordingStore).recordingSessionId.set('s1');
    expect(await store.close()).toBe(false);
    expect(toast.toasts().at(-1)?.kind).toBe('warning');

    TestBed.inject(RecordingStore).recordingSessionId.set(null);
    expect(await store.close()).toBe(true);
    expect(store.isOpen()).toBe(false);
  });

  it('forgets and reveals vaults, reporting failures', async () => {
    setup();
    await store.forget('/home/me/Vault');
    expect(store.info()?.recent).toEqual([]);
    await store.reveal();
    expect(mock.names()).toContain('revealVault');

    mock.set('forgetRecentVault', () => Promise.reject('x'));
    mock.set('revealVault', () => Promise.reject('no file manager'));
    await store.forget('/v');
    await store.reveal();
    expect(toast.toasts().filter((t) => t.kind === 'error')).toHaveLength(2);
  });

  it('refreshes the info quietly', async () => {
    setup();
    await store.refreshInfo();
    expect(store.isOpen()).toBe(true);
    expect(toast.toasts()).toEqual([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mock.set('getVaultInfo', () => Promise.reject('x'));
    await store.refreshInfo();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('resolves image paths against the vault root', async () => {
    setup();
    expect(store.resolveAsset('media/a.png')).toBe('asset://localhostmedia/a.png');
    await store.init();
    expect(store.resolveAsset('./media/a.png')).toBe('asset://localhost/home/me/Vault/media/a.png');
    expect(store.resolveAsset('/tmp/b.png')).toBe('asset://localhost/tmp/b.png');
  });
});
