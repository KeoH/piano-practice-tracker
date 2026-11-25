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

  describe('collections', () => {
    const coll = (id: string, name: string, piece_ids: string[]) => ({ id, name, piece_ids, created_at: '', updated_at: '' });

    beforeEach(async () => {
      mock.set('getCollections', () => Promise.resolve([coll('c1', 'Christmas', ['p1']), coll('c2', 'Grade 3', ['p1', 'p2'])]));
      await store.refreshList();
    });

    it('narrows the list to a collection and falls back to everything when it is gone', () => {
      store.collectionFilter.set('c1');
      expect(store.filteredPieces().map((p) => p.piece.id)).toEqual(['p1']);
      store.filter.set('satie');
      expect(store.filteredPieces()).toEqual([]);
      store.filter.set('');
      store.collectionFilter.set('deleted');
      expect(store.activeCollection()).toBeNull();
      expect(store.filteredPieces().length).toBe(2);
    });

    it('knows the collections of the selected piece', async () => {
      await store.select('p2');
      expect(store.selectedCollectionIds()).toEqual(['c2']);
    });

    it('puts a piece in a collection and takes it out, sending the whole list each time', async () => {
      mock.set('setPieceCollections', (pieceId: string, ids: string[]) =>
        Promise.resolve([coll('c1', 'Christmas', ids.includes('c1') ? [pieceId] : []), coll('c2', 'Grade 3', ids.includes('c2') ? [pieceId] : [])]),
      );
      await store.toggleInCollection('p2', 'c1');
      expect(mock.argsOf('setPieceCollections')).toEqual(['p2', ['c2', 'c1']]);
      await store.toggleInCollection('p2', 'c1');
      expect(mock.argsOf('setPieceCollections')).toEqual(['p2', ['c2']]);
      expect(store.collections()[0].piece_ids).toEqual([]);
    });

    it('creates a collection, optionally with the piece in it, and keeps them by name', async () => {
      mock.set('createCollection', (name: string) => Promise.resolve(coll('c3', name, [])));
      await store.createCollection('  Advent ');
      expect(mock.argsOf('createCollection')).toEqual(['Advent']);
      expect(store.collections().map((c) => c.name)).toEqual(['Advent', 'Christmas', 'Grade 3']);

      mock.set('setPieceCollections', () => Promise.resolve([coll('c3', 'Recital', ['p2'])]));
      await store.createCollection('Recital', 'p2');
      expect(mock.argsOf('setPieceCollections')).toEqual(['p2', ['c2', 'c3']]);
      expect(store.collections()).toEqual([coll('c3', 'Recital', ['p2'])]);

      mock.set('createCollection', () => Promise.reject('boom'));
      expect(await store.createCollection('x')).toBeNull();
    });

    it('renames and deletes, dropping the filter of a deleted collection', async () => {
      mock.set('renameCollection', (id: string, name: string) => Promise.resolve(coll(id, name, ['p1'])));
      await store.renameCollection('c1', ' Xmas ');
      expect(store.collections().map((c) => c.name)).toEqual(['Grade 3', 'Xmas']);
      store.collectionFilter.set('c1');
      expect(await store.removeCollection('c1')).toBe(true);
      expect(store.collectionFilter()).toBeNull();
      expect(store.collections().map((c) => c.id)).toEqual(['c2']);
    });

    it('reloads when a change is rejected', async () => {
      mock.set('setPieceCollections', () => Promise.reject('nope'));
      const before = mock.count('getCollections');
      await store.toggleInCollection('p1', 'c2');
      await Promise.resolve();
      expect(mock.count('getCollections')).toBeGreaterThan(before);
      expect(TestBed.inject(ToastService).toasts().length).toBe(1);
    });
  });

  describe('scores', () => {
    it('files a score and refreshes the list and the open piece', async () => {
      mock.set('assignScorePiece', (scoreId: string, pieceId: string | null) =>
        Promise.resolve({ id: scoreId, piece_id: pieceId } as never),
      );
      await store.select('p1');
      const lists = mock.count('getPieces');
      const details = mock.count('getPieceDetail');
      const updated = await store.assignScore('s1', 'p1');
      expect(mock.argsOf('assignScorePiece')).toEqual(['s1', 'p1']);
      expect(updated?.piece_id).toBe('p1');
      expect(mock.count('getPieces')).toBe(lists + 1);
      await Promise.resolve();
      expect(mock.count('getPieceDetail')).toBe(details + 1);
    });

    describe('order', () => {
      const entry = (id: string) => ({ id, title: id, piece_id: 'p1' }) as never;

      beforeEach(async () => {
        mock.set('getPieceDetail', (id: string) =>
          Promise.resolve(pieceDetail({ piece: piece({ id }), scores: [entry('a'), entry('b'), entry('c')] })),
        );
        await store.select('p1');
      });

      const ids = () => store.detail()!.scores.map((s) => s.id);

      it('moves a score one place, at once, and keeps what the backend stores', async () => {
        mock.set('reorderPieceScores', (_id: string, order: string[]) => Promise.resolve(order.map(entry)));
        const pending = store.moveScore('c', -1);
        expect(ids()).toEqual(['a', 'c', 'b']);
        await pending;
        expect(mock.argsOf('reorderPieceScores')).toEqual(['p1', ['a', 'c', 'b']]);
        await store.moveScore('a', 1);
        expect(ids()).toEqual(['c', 'a', 'b']);
      });

      it('does nothing at the ends of the list', async () => {
        await store.moveScore('a', -1);
        await store.moveScore('c', 1);
        await store.moveScore('zzz', 1);
        expect(mock.count('reorderPieceScores')).toBe(0);
        expect(ids()).toEqual(['a', 'b', 'c']);
      });

      it('reloads the stored order when it is refused', async () => {
        mock.set('reorderPieceScores', () => Promise.reject('stale'));
        const loads = mock.count('getPieceDetail');
        await store.moveScore('b', -1);
        await Promise.resolve();
        expect(mock.count('getPieceDetail')).toBe(loads + 1);
        expect(TestBed.inject(ToastService).toasts().at(-1)?.kind).toBe('error');
      });
    });

    it('makes a piece from a score in one step', async () => {
      mock.set('assignScorePiece', (scoreId: string, pieceId: string | null) =>
        Promise.resolve({ id: scoreId, piece_id: pieceId } as never),
      );
      const created = await store.createFromScore('s1', 'My etude');
      expect(created?.id).toBe('p3');
      expect(mock.argsOf('createPiece')).toEqual(['My etude', '']);
      expect(mock.argsOf('assignScorePiece')).toEqual(['s1', 'p3']);

      mock.set('assignScorePiece', () => Promise.reject('no'));
      expect(await store.createFromScore('s1', 'x')).toBeNull();
    });
  });
});
