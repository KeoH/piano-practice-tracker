import { TestBed } from '@angular/core/testing';
import { detail, fragment, piece, pieceDetail, pieceSummary } from '../testing/fixtures';
import { type MockApi, mockApi } from '../testing/mock-api';
import { I18nService } from './i18n/i18n.service';
import { PieceStore } from './piece.store';
import { SessionStore } from './session.store';
import { ToastService } from './toast.service';

describe('PieceStore', () => {
  let store: PieceStore;
  let mock: MockApi;

  beforeEach(() => {
    mock = mockApi({
      getPieces: () =>
        Promise.resolve([
          pieceSummary({ id: 'p1', title: 'Nocturne', composer: 'Chopin' }),
          pieceSummary({ id: 'p2', title: 'Gymnopédie 1', composer: 'Satie' }),
        ]),
      getPieceDetail: (id: string) => Promise.resolve(pieceDetail({ piece: piece({ id }) })),
      createPiece: (title: string, composer: string) => Promise.resolve(piece({ id: 'p3', title, composer })),
      updatePiece: (id, title, composer, notes, archived) => Promise.resolve(piece({ id, title, composer, notes, archived })),
      assignFragmentPiece: (id: string, pieceId: string | null, passage: string) =>
        Promise.resolve(fragment({ id, piece_id: pieceId, passage })),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(PieceStore);
  });

  it('filters by title or composer', async () => {
    await store.refreshList();
    store.filter.set('satie');
    expect(store.filteredPieces().map((p) => p.piece.id)).toEqual(['p2']);
    store.filter.set('noct');
    expect(store.filteredPieces().map((p) => p.piece.id)).toEqual(['p1']);
    expect(store.byId('p2')?.piece.title).toBe('Gymnopédie 1');
    expect(store.byId(null)).toBeUndefined();
  });

  it('selects a piece and drops a stale detail', async () => {
    await store.select('p1');
    expect(store.detail()?.piece.id).toBe('p1');
    let resolve!: (d: ReturnType<typeof pieceDetail>) => void;
    mock.set('getPieceDetail', () => new Promise((r) => (resolve = r)));
    const pending = store.select('p2');
    expect(store.detail()).toBeNull();
    store.selectedId.set('p1');
    resolve(pieceDetail({ piece: piece({ id: 'p2' }) }));
    await pending;
    expect(store.detail()).toBeNull();
  });

  it('creates a piece with trimmed fields', async () => {
    const created = await store.create('  Prelude  ', ' Bach ');
    expect(created?.title).toBe('Prelude');
    expect(mock.argsOf('createPiece')).toEqual(['Prelude', 'Bach']);
    mock.set('createPiece', () => Promise.reject('dup'));
    expect(await store.create('x')).toBeNull();
  });

  it('updates the selected piece and refreshes the list when archiving', async () => {
    await store.refreshList();
    await store.select('p1');
    await store.update({ notes: 'Slow left hand' });
    expect(store.detail()?.piece.notes).toBe('Slow left hand');
    expect(store.byId('p1')?.piece.notes).toBe('Slow left hand');
    const lists = mock.count('getPieces');
    await store.update({ archived: true });
    expect(mock.count('getPieces')).toBe(lists + 1);
  });

  it('reloads the detail when an update fails', async () => {
    await store.update({ notes: 'ignored without a piece' });
    expect(mock.count('updatePiece')).toBe(0);
    await store.select('p1');
    mock.set('updatePiece', () => Promise.reject('locked'));
    await store.update({ title: 'X' });
    expect(TestBed.inject(ToastService).toasts().at(-1)?.kind).toBe('error');
    expect(mock.count('getPieceDetail')).toBe(2);
  });

  it('removes a piece and reloads the open session', async () => {
    const sessions = TestBed.inject(SessionStore);
    sessions.selectedId.set('s1');
    await store.select('p1');
    expect(await store.remove('p1')).toBe(true);
    expect(store.selectedId()).toBeNull();
    expect(mock.names()).toContain('getSessionDetail');
    mock.set('deletePiece', () => Promise.reject('nope'));
    expect(await store.remove('p2')).toBe(false);
  });

  it('assigns a fragment and patches the session that shows it', async () => {
    const sessions = TestBed.inject(SessionStore);
    sessions.detail.set(detail({ fragments: [fragment()] }));
    await store.select('p1');
    const updated = await store.assign(fragment(), 'p1', '  Bars 1-8 ');
    expect(updated).toMatchObject({ piece_id: 'p1', passage: 'Bars 1-8' });
    expect(sessions.fragments()[0]).toMatchObject({ piece_id: 'p1', passage: 'Bars 1-8' });
    expect(mock.count('getPieceDetail')).toBe(2);

    mock.set('assignFragmentPiece', () => Promise.reject('gone'));
    expect(await store.assign(fragment(), null, '')).toBeNull();
  });

  it('reports a failed list and resets', async () => {
    mock.set('getPieces', () => Promise.reject('io'));
    await store.refreshList();
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message).toContain('io');
    await store.select('p1');
    store.reset();
    expect(store.detail()).toBeNull();
    expect(store.selectedId()).toBeNull();
  });
});
