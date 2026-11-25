import { TestBed } from '@angular/core/testing';
import { pieceSummary } from '../../testing/fixtures';
import { type MockApi, flush, mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { NavStore } from '../../core/nav.store';
import { PieceStore } from '../../core/piece.store';
import { ScoreStore } from '../../core/score.store';
import { ScorePieceSelectComponent } from './score-piece-select.component';

describe('ScorePieceSelectComponent', () => {
  let mock: MockApi;

  async function setup(pieceId: string | null = null) {
    let created = false;
    mock = mockApi({
      getPieces: () =>
        Promise.resolve([
          pieceSummary({ id: 'p1', title: 'Nocturne' }),
          pieceSummary({ id: 'p2', title: 'Old etude', archived: true }),
          ...(created ? [pieceSummary({ id: 'p9', title: 'My etude' })] : []),
        ]),
      assignScorePiece: (scoreId: string, id: string | null) => Promise.resolve({ id: scoreId, piece_id: id } as never),
      createPiece: (title: string) => {
        created = true;
        return Promise.resolve(pieceSummary({ id: 'p9', title }).piece);
      },
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    await TestBed.inject(PieceStore).refreshList();
    TestBed.inject(ScoreStore).scores.set([
      { id: 's1', title: 'My etude', bpm: 90, beats: 4, beat_unit: 4, bars: 4, note_count: 3, duration_ms: 1000, fragment_id: null, piece_id: pieceId, updated_at: '' },
    ]);
    const fixture = TestBed.createComponent(ScorePieceSelectComponent);
    fixture.componentRef.setInput('scoreId', 's1');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const select = () => el.querySelector('select') as HTMLSelectElement;
    const choose = async (value: string) => {
      select().value = value;
      select().dispatchEvent(new Event('change'));
      await fixture.whenStable();
      await flush(20);
      fixture.detectChanges();
    };
    return { fixture, el, select, choose };
  }

  it('offers the active pieces, "new piece from this score" and none', async () => {
    const { select } = await setup();
    const labels = [...select().options].map((o) => o.textContent!.trim());
    expect(labels).toHaveLength(3);
    expect(labels[1]).toBe('Nocturne');
    expect(select().value).toBe('');
  });

  it('keeps an archived piece when the score is in it', async () => {
    const { select } = await setup('p2');
    expect([...select().options].map((o) => o.value)).toContain('p2');
    expect(select().value).toBe('p2');
  });

  it('files the score under the chosen piece and takes it out', async () => {
    const { select, choose } = await setup();
    await choose('p1');
    expect(mock.argsOf('assignScorePiece')).toEqual(['s1', 'p1']);
    expect(TestBed.inject(ScoreStore).scores()[0].piece_id).toBe('p1');
    expect(select().value).toBe('p1');
    await choose('');
    expect(mock.argsOf('assignScorePiece')).toEqual(['s1', null]);
    expect(select().value).toBe('');
  });

  it('creates a piece named after the score in one step', async () => {
    const { select, choose } = await setup();
    await choose('__new__');
    expect(mock.argsOf('createPiece')).toEqual(['My etude', '']);
    expect(mock.argsOf('assignScorePiece')).toEqual(['s1', 'p9']);
    expect(TestBed.inject(ScoreStore).scores()[0].piece_id).toBe('p9');
    expect(select().value).toBe('p9');
  });

  it('opens the piece in the repertoire', async () => {
    const { el, fixture } = await setup('p1');
    (el.querySelector('button') as HTMLButtonElement).click();
    expect(TestBed.inject(NavStore).view()).toBe('pieces');
    expect(TestBed.inject(PieceStore).selectedId()).toBe('p1');
    fixture.detectChanges();
  });
});
