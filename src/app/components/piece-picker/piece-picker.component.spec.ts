import { TestBed } from '@angular/core/testing';
import { piece, pieceSummary } from '../../testing/fixtures';
import { type MockApi, mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { PieceStore } from '../../core/piece.store';
import { type PieceChoice, PiecePickerComponent } from './piece-picker.component';

describe('PiecePickerComponent', () => {
  let mock: MockApi;

  async function setup(pieceId: string | null = null, passage = '') {
    mock = mockApi({
      getPieces: () =>
        Promise.resolve([
          pieceSummary({ id: 'p1', title: 'Nocturne', composer: 'Chopin' }, { passages: ['Bars 1-8', 'Coda'] }),
          pieceSummary({ id: 'p2', title: 'Old etude', archived: true }),
        ]),
      createPiece: (title: string) => Promise.resolve(piece({ id: 'p3', title })),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    await TestBed.inject(PieceStore).refreshList();
    const fixture = TestBed.createComponent(PiecePickerComponent);
    fixture.componentRef.setInput('pieceId', pieceId);
    fixture.componentRef.setInput('passage', passage);
    const choices: PieceChoice[] = [];
    fixture.componentInstance.changed.subscribe((c) => choices.push(c));
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    return { fixture, el, choices, select: () => el.querySelector('select') as HTMLSelectElement };
  }

  it('lists the active pieces and suggests the passages of the chosen one', async () => {
    const { el, select } = await setup('p1', 'Coda');
    const labels = [...select().options].map((o) => o.textContent!.trim());
    expect(labels).toEqual(['No piece', 'Nocturne · Chopin', 'New piece…'].map((l, i) => (i === 1 ? l : expect.any(String))));
    expect(labels).not.toContain('Old etude');
    expect([...el.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['Bars 1-8', 'Coda']);
    expect((el.querySelectorAll('input')[0] as HTMLInputElement).disabled).toBe(false);
  });

  it('keeps an archived piece when it is the current one', async () => {
    const { select } = await setup('p2');
    expect([...select().options].some((o) => o.value === 'p2')).toBe(true);
  });

  it('emits the chosen piece, dropping the passage when it is cleared', async () => {
    const { select, choices, el } = await setup('p1', 'Coda');
    select().value = '';
    select().dispatchEvent(new Event('change'));
    select().value = 'p1';
    select().dispatchEvent(new Event('change'));
    const passage = el.querySelector('input') as HTMLInputElement;
    passage.value = '  Bars 9-16 ';
    passage.dispatchEvent(new Event('change'));
    expect(choices).toEqual([
      { pieceId: null, passage: '' },
      { pieceId: 'p1', passage: 'Coda' },
      { pieceId: 'p1', passage: 'Bars 9-16' },
    ]);
  });

  it('creates a new piece inline', async () => {
    const { fixture, el, select, choices } = await setup(null, '');
    select().value = '__new__';
    select().dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const title = el.querySelector('input') as HTMLInputElement;
    const create = el.querySelector('.btn-primary') as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    title.value = 'Prelude';
    title.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(create.disabled).toBe(false);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();
    expect(mock.argsOf('createPiece')).toEqual(['Prelude', '']);
    expect(choices).toEqual([{ pieceId: 'p3', passage: '' }]);
    fixture.detectChanges();
    expect(el.querySelector('select')).not.toBeNull();
  });

  it('cancels the new piece with Escape or the button', async () => {
    const { fixture, el, select } = await setup();
    select().value = '__new__';
    select().dispatchEvent(new Event('change'));
    fixture.detectChanges();
    el.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(el.querySelector('select')).not.toBeNull();

    select().value = '__new__';
    select().dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (el.querySelector('.btn-ghost') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('select')).not.toBeNull();
    expect(mock.count('createPiece')).toBe(0);
  });
});
