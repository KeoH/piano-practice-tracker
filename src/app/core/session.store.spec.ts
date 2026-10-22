import { TestBed } from '@angular/core/testing';
import { comment, detail, fragment, session, summary } from '../testing/fixtures';
import { type MockApi, flush, mockApi } from '../testing/mock-api';
import { ConfirmService } from './confirm.service';
import { I18nService } from './i18n/i18n.service';
import { SessionStore } from './session.store';
import { ToastService } from './toast.service';

describe('SessionStore', () => {
  let store: SessionStore;
  let mock: MockApi;
  let toast: ToastService;

  beforeEach(() => {
    mock = mockApi({
      getSessions: () =>
        Promise.resolve([
          summary({ id: 'a', title: 'Scales', session_date: '2026-10-01' }),
          summary({ id: 'b', title: 'Nocturne', session_date: '2026-10-15' }),
          summary({ id: 'c', title: 'Old', session_date: '', updated_at: '2026-01-01' }),
        ]),
      getSessionDetail: (id: string) => Promise.resolve(detail({ session: session({ id }) })),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(SessionStore);
    toast = TestBed.inject(ToastService);
  });

  it('lists the newest sessions first and filters by title', async () => {
    await store.refreshList();
    expect(store.filteredSessions().map((s) => s.id)).toEqual(['b', 'a', 'c']);
    store.filter.set('  NOC ');
    expect(store.filteredSessions().map((s) => s.id)).toEqual(['b']);
    expect(store.listLoading()).toBe(false);
  });

  it('shows an error toast when the list fails', async () => {
    mock.set('getSessions', () => Promise.reject('db locked'));
    await store.refreshList();
    expect(toast.toasts().at(-1)?.message).toContain('db locked');
  });

  it('does nothing without the backend', async () => {
    mock = mockApi({ available: false });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [mock.provider] });
    await TestBed.inject(SessionStore).refreshList();
    expect(mock.calls).toEqual([]);
  });

  it('selects a session and loads its detail once', async () => {
    await store.select('a');
    expect(store.session()?.id).toBe('a');
    await store.select('a');
    expect(mock.count('getSessionDetail')).toBe(1);
    await store.select(null);
    expect(store.detail()).toBeNull();
  });

  it('ignores a detail that arrives after another selection', async () => {
    let resolveA!: (d: ReturnType<typeof detail>) => void;
    mock.set('getSessionDetail', (id: string) =>
      id === 'a' ? new Promise((r) => (resolveA = r)) : Promise.resolve(detail({ session: session({ id }) })),
    );
    const first = store.select('a');
    await store.select('b');
    resolveA(detail({ session: session({ id: 'a' }) }));
    await first;
    expect(store.session()?.id).toBe('b');
  });

  it('sorts the fragments by order and creation date', async () => {
    store.detail.set(
      detail({
        fragments: [
          fragment({ id: 'z', order_index: 1 }),
          fragment({ id: 'y', order_index: 0, created_at: '2026-10-02' }),
          fragment({ id: 'x', order_index: 0, created_at: '2026-10-01' }),
        ],
      }),
    );
    expect(store.fragments().map((f) => f.id)).toEqual(['x', 'y', 'z']);
  });

  it('creates a session, selects it and opens the record tab', async () => {
    mock.set('createSession', () => Promise.resolve(detail({ session: session({ id: 'new' }) })));
    store.tab.set('notes');
    await store.create();
    expect(mock.argsOf('createSession')?.[0]).toMatch(/^Practice /);
    expect(store.selectedId()).toBe('new');
    expect(store.tab()).toBe('record');
    expect(toast.toasts().at(-1)?.kind).toBe('success');
  });

  it('removes a session and clears the selection', async () => {
    await store.refreshList();
    await store.select('a');
    expect(await store.remove('a')).toBe(true);
    expect(store.selectedId()).toBeNull();
    expect(store.sessions().some((s) => s.id === 'a')).toBe(true); // list reloaded from the mock

    mock.set('deleteSession', () => Promise.reject('busy'));
    expect(await store.remove('b')).toBe(false);
  });

  it('saves fields optimistically and in order, with the latest values', async () => {
    await store.refreshList();
    store.detail.set(detail({ session: session({ id: 'a', title: 'Old', bpm: 80 }) }));
    const p1 = store.saveFields({ title: 'New' });
    const p2 = store.saveFields({ bpm: 100 });
    expect(store.session()).toMatchObject({ title: 'New', bpm: 100 });
    expect(store.sessions().find((s) => s.id === 'a')).toMatchObject({ title: 'New', bpm: 100 });
    expect(store.savingCount()).toBe(2);
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    expect(store.savingCount()).toBe(0);
    expect(mock.calls.filter((c) => c.cmd === 'updateSession').map((c) => c.args)).toEqual([
      ['a', 'New', 100, ''],
      ['a', 'New', 100, ''],
    ]);
  });

  it('reports a failed save and skips it without a session', async () => {
    expect(await store.saveFields({ title: 'x' })).toBe(false);
    store.detail.set(detail());
    mock.set('updateSession', () => Promise.reject('read-only'));
    expect(await store.saveFields({ title: 'x' })).toBe(false);
    expect(toast.toasts().at(-1)?.kind).toBe('error');
  });

  describe('undoTrim', () => {
    beforeEach(() => {
      mock.set('undoRawTrim', () => Promise.resolve({ session: session({ raw_duration_ms: 70_000 }), removed_fragment_id: null }));
    });

    it('does nothing without history', async () => {
      store.detail.set(detail());
      expect(await store.undoTrim()).toBe(false);
      expect(mock.count('undoRawTrim')).toBe(0);
    });

    it('undoes a discard straight away', async () => {
      await store.select('s1');
      store.detail.set(detail({ undo_depth: 2 }));
      expect(await store.undoTrim()).toBe(true);
      expect(mock.argsOf('undoRawTrim')).toEqual(['s1']);
      expect(toast.toasts().at(-1)?.message).toBe(TestBed.inject(I18nService).t('slicer.undone'));
    });

    it('asks before deleting a fragment with comments', async () => {
      const confirm = TestBed.inject(ConfirmService);
      const frag = fragment({ id: 'f1', comments: [comment()] });
      store.detail.set(detail({ undo_depth: 1, undo_fragment_id: 'f1', fragments: [frag] }));

      const declined = store.undoTrim();
      await flush();
      confirm.answer(false);
      expect(await declined).toBe(false);
      expect(mock.count('undoRawTrim')).toBe(0);

      mock.set('undoRawTrim', () => Promise.resolve({ session: session(), removed_fragment_id: 'f1' }));
      const accepted = store.undoTrim();
      await flush();
      confirm.answer(true);
      expect(await accepted).toBe(true);
      expect(toast.toasts().at(-1)?.message).toContain('Bars 1-8');
    });

    it('reports a failed undo', async () => {
      store.detail.set(detail({ undo_depth: 1 }));
      mock.set('undoRawTrim', () => Promise.reject('no snapshot'));
      expect(await store.undoTrim()).toBe(false);
      expect(store.undoing()).toBe(false);
    });
  });

  it('patches and removes fragments locally', () => {
    store.sessions.set([summary({ id: 's1', fragment_count: 1 })]);
    store.detail.set(detail({ fragments: [fragment()] }));
    store.patchFragment('f1', (f) => ({ ...f, title: 'Renamed' }));
    expect(store.fragments()[0].title).toBe('Renamed');
    store.removeFragmentLocal('f1');
    expect(store.fragments()).toEqual([]);
    expect(store.sessions().find((s) => s.id === 's1')?.fragment_count).toBe(0);

    store.applySession(session({ id: 'other', title: 'x' }));
    expect(store.session()?.title).toBe('Monday');
    store.applySession(session({ title: 'Updated' }));
    expect(store.session()?.title).toBe('Updated');
  });

  it('resets everything when the vault changes', async () => {
    await store.refreshList();
    await store.select('a');
    store.reset();
    expect(store.sessions()).toEqual([]);
    expect(store.selectedId()).toBeNull();
    expect(store.detail()).toBeNull();
  });
});
