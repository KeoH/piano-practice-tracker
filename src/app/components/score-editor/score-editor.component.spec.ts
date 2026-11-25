import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { flush, mockApi } from '../../testing/mock-api';
import { ConfirmService } from '../../core/confirm.service';
import { NavStore } from '../../core/nav.store';
import { I18nService } from '../../core/i18n/i18n.service';
import type { ScoreDto } from '../../core/models';
import { newScore } from '../../core/score';
import { ScoreStore } from '../../core/score.store';
import { ScoreEditorComponent } from './score-editor.component';
import { ScoreListComponent } from '../score-list/score-list.component';

const score = (extra: Partial<ScoreDto> = {}): ScoreDto => ({ ...newScore('s1', 'Étude', '2026-01-01T00:00:00Z'), ...extra });

describe('ScoreEditorComponent', () => {
  let fixture: ComponentFixture<ScoreEditorComponent>;
  let store: ScoreStore;
  let mock: ReturnType<typeof mockApi>;
  let el: HTMLElement;
  const button = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label)!;

  async function open(doc: ScoreDto | null = score()) {
    mock.set('getScores', () => Promise.resolve(doc ? [{ id: doc.id, title: doc.title, bpm: doc.bpm, beats: 4, beat_unit: 4, bars: doc.bars, note_count: 0, duration_ms: 0, fragment_id: null, updated_at: '' }] : []));
    mock.set('getScore', () => Promise.resolve(doc!));
    fixture = TestBed.createComponent(ScoreEditorComponent);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
    await flush(20);
    fixture.detectChanges();
  }

  beforeEach(() => {
    mock = mockApi({ saveScore: (d: ScoreDto) => Promise.resolve(d), createScore: () => Promise.resolve(score()), deleteScore: () => Promise.resolve(), getScores: () => Promise.resolve([]) });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(ScoreStore);
  });

  it('opens the latest score and shows its title and summary', async () => {
    await open(score({ treble: [{ id: 'a', tick: 0, duration_ticks: 480, key: 60, accidental: null, tie: false }] }));
    expect((el.querySelector('#score-title') as HTMLInputElement).value).toBe('Étude');
    expect(el.textContent).toContain('4 bars');
    expect(el.textContent).toContain('1 note');
    expect(el.querySelector('app-score-staff svg')).not.toBeNull();
  });

  describe('PDF export', () => {
    const pdfButton = () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Export PDF'))!;
    const withNote = () => score({ treble: [{ id: 'a', tick: 0, duration_ticks: 480, key: 72, accidental: null, tie: false }] });

    it('is disabled while the score is empty', async () => {
      await open(score());
      expect(pdfButton().disabled).toBe(true);
    });

    it('asks where to save a PDF named after the score and sends it to the backend', async () => {
      mock.set('pickSavePath', (_t: string, name: string) => Promise.resolve(`/out/${name}`));
      mock.set('exportScorePdf', (dest: string) => Promise.resolve(dest));
      await open(withNote());
      expect(pdfButton().disabled).toBe(false);
      pdfButton().click();
      await vi.waitFor(() => expect(mock.names()).toContain('exportScorePdf'));
      expect(mock.argsOf('pickSavePath')?.[1]).toBe('Étude.pdf');
      expect(mock.argsOf('exportScorePdf')?.[0]).toBe('/out/Étude.pdf');
    });
  });

  it('offers to create the first score when there are none', async () => {
    await open(null);
    expect(el.textContent).toContain('Create a score');
    const create = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Create a score'))!;
    create.click();
    await fixture.whenStable();
    await flush(10);
    expect(mock.names()).toContain('createScore');
  });

  it('chooses a note value and the dot from the palette', async () => {
    await open();
    button('Half note').click();
    fixture.detectChanges();
    expect(store.kind()).toBe('half');
    expect(button('Half note').getAttribute('aria-pressed')).toBe('true');
    button('Dotted note (.)').click();
    expect(store.dotted()).toBe(true);
    button('Whole note').click();
    fixture.detectChanges();
    expect(store.dotted()).toBe(false);
    expect(button('Dotted note (.)').disabled).toBe(true);
  });

  it('starts a palette drag on press, for the staff to take', async () => {
    await open();
    button('Eighth note').dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
    expect(store.paletteDrag()).toEqual({ kind: 'eighth', dotted: false });
  });

  it('sets the tempo, bounded, and the time signature', async () => {
    await open();
    const bpm = el.querySelector('#score-bpm') as HTMLInputElement;
    bpm.value = '120';
    bpm.dispatchEvent(new Event('change'));
    expect(store.doc()!.bpm).toBe(120);
    bpm.value = '999';
    bpm.dispatchEvent(new Event('change'));
    expect(store.doc()!.bpm).toBe(120);
    expect(bpm.value).toBe('120');
    const meter = el.querySelector('#score-meter') as HTMLSelectElement;
    meter.value = '3/4';
    meter.dispatchEvent(new Event('change'));
    expect(store.doc()!.beats).toBe(3);
  });

  it('keeps the transport, the palette and the settings in a fixed side panel, apart from the staff', async () => {
    await open();
    const aside = el.querySelector('aside')!;
    expect(aside.classList.contains('sticky')).toBe(true);
    const inside = (label: string) => !!aside.querySelector(`button[aria-label="${label}"]`);
    for (const label of [
      'Play', 'Stop', 'Quarter note', 'Dotted note (.)', 'Sharp (#)', 'Flat (b)', 'Tie to the next note (T)', 'Slur to the next note (L)', 'Repeat sign',
      'Add a bar', 'Remove a bar', 'Zoom in', 'Zoom out',
    ]) {
      expect(inside(label), label).toBe(true);
    }
    for (const id of ['#score-bpm', '#score-meter', '#score-pickup']) expect(aside.querySelector(id), id).not.toBeNull();
    expect(aside.querySelector('app-rate-select')).not.toBeNull();
    // Nothing of the controls is left with the staff, which is not in the panel.
    expect(aside.querySelector('app-score-staff')).toBeNull();
    const main = el.querySelector('app-score-staff')!.parentElement!.parentElement!;
    expect(main.querySelector('#score-bpm, #score-meter, button[aria-label="Zoom in"]')).toBeNull();
    expect(aside.textContent).toContain('Drag a value onto the staff');
  });

  it('chooses the repeat sign in the palette like a note value, and says how to put it', async () => {
    await open();
    expect(button('Repeat sign').getAttribute('aria-pressed')).toBe('false');
    button('Repeat sign').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(store.repeatDrag()).toBe(true); // the staff takes the drop
    store.repeatDrag.set(false);
    button('Repeat sign').click();
    fixture.detectChanges();
    expect(store.repeatTool()).toBe(true);
    expect(button('Repeat sign').getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('aside')!.textContent).toContain('Click the bar the repeat sign closes');
    button('Repeat sign').click();
    expect(store.repeatTool()).toBe(false);
  });

  it('shows where a placed repeat sign is and takes it away from the panel', async () => {
    await open();
    store.setRepeatBar(1);
    fixture.detectChanges();
    const aside = el.querySelector('aside')!;
    expect(aside.textContent).toContain('After bar 2');
    // 4 bars at 90 BPM last 10.7 s; the sign after bar 2 adds 5.3 s: the length is what is played.
    expect(el.textContent).toContain('00:16');
    [...aside.querySelectorAll('button')].find((b) => b.textContent!.includes('Remove the repeat sign'))!.click();
    fixture.detectChanges();
    expect(store.doc()!.repeat_bar).toBeNull();
    expect(aside.textContent).not.toContain('After bar 2');
  });

  it('names the pickup bar when the sign is after it', async () => {
    await open();
    store.setPickup(480);
    store.setRepeatBar(0);
    fixture.detectChanges();
    expect(el.querySelector('aside')!.textContent).toContain('After the pickup');
  });

  it('slurs the selected note to the next one with the slur button, which is off without a note', async () => {
    await open();
    expect(button('Slur to the next note (L)').disabled).toBe(true);
    store.placeNote('treble', 0, 0);
    store.placeNote('treble', 480, 1);
    store.selectNote(store.doc()!.treble[0].id);
    fixture.detectChanges();
    expect(button('Slur to the next note (L)').getAttribute('aria-pressed')).toBe('false');
    button('Slur to the next note (L)').click();
    fixture.detectChanges();
    expect(store.doc()!.slurs).toHaveLength(1);
    expect(button('Slur to the next note (L)').getAttribute('aria-pressed')).toBe('true');
    button('Slur to the next note (L)').click();
    expect(store.doc()!.slurs).toEqual([]);
  });

  it('adds and removes bars', async () => {
    await open();
    button('Add a bar').click();
    expect(store.doc()!.bars).toBe(5);
    button('Remove a bar').click();
    button('Remove a bar').click();
    expect(store.doc()!.bars).toBe(3);
  });

  it('shows the selected note with actions, and the hint otherwise', async () => {
    await open(score({ treble: [{ id: 'a', tick: 0, duration_ticks: 480, key: 64, accidental: null, tie: false }] }));
    expect(el.textContent).toContain('Drag a value onto the staff');
    store.selectNote('a');
    fixture.detectChanges();
    expect(el.textContent).toContain('Selected: E4 · Quarter note');
    [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Remove note'))!.click();
    expect(store.doc()!.treble).toHaveLength(0);
  });

  it('undoes and redoes from the header', async () => {
    await open();
    store.placeNote('treble', 0, 0);
    fixture.detectChanges();
    expect(button('Undo').disabled).toBe(false);
    button('Undo').click();
    expect(store.doc()!.treble).toHaveLength(0);
    fixture.detectChanges();
    button('Redo').click();
    expect(store.doc()!.treble).toHaveLength(1);
  });

  it('asks before deleting, mentioning the compositions that use it', async () => {
    await open(score({ fragment_id: 'f1' }));
    mock.set('countCompositionUses', () => Promise.resolve(2));
    const ask = vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(true);
    button('Delete score').click();
    await fixture.whenStable();
    await flush(20);
    expect(ask.mock.calls[0][0].message).toContain('Étude');
    expect(ask.mock.calls[0][0].message).toContain('2 compositions');
    expect(mock.argsOf('deleteScore')).toEqual(['s1']);
  });

  it('turns the saved score into a challenge and opens it', async () => {
    mock.set('createMelodyFromFragment', () => Promise.resolve({ id: 'm1', title: 'Étude' } as never));
    await open(score({ fragment_id: 'frag1', treble: [{ id: 'a', tick: 0, duration_ticks: 480, key: 64, accidental: null, tie: false }] }));
    const useIt = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Use as a challenge'))!;
    expect(useIt.disabled).toBe(false);
    useIt.click();
    await fixture.whenStable();
    await flush(30);
    expect(mock.argsOf('createMelodyFromFragment')?.[0]).toBe('frag1');
    expect(TestBed.inject(NavStore).view()).toBe('challenges');
  });

  it('cannot become a challenge while it has no notes', async () => {
    await open();
    const useIt = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Use as a challenge'))!;
    expect(useIt.disabled).toBe(true);
  });

  it('keeps the title when the field is left empty', async () => {
    await open();
    const title = el.querySelector('#score-title') as HTMLInputElement;
    title.value = '   ';
    title.dispatchEvent(new Event('blur'));
    expect(title.value).toBe('Étude');
    title.value = 'Prelude';
    title.dispatchEvent(new Event('blur'));
    expect(store.doc()!.title).toBe('Prelude');
  });

  it('zooms the staff in and out within its limits', async () => {
    await open();
    for (let i = 0; i < 8; i++) {
      button('Zoom in').click();
      fixture.detectChanges();
    }
    expect(store.zoom()).toBe(128);
    expect(button('Zoom in').disabled).toBe(true);
    for (let i = 0; i < 8; i++) {
      button('Zoom out').click();
      fixture.detectChanges();
    }
    expect(store.zoom()).toBe(48);
  });
});

describe('ScoreListComponent', () => {
  it('lists the scores, filters them and opens one', async () => {
    const mock = mockApi({
      getScore: () => Promise.resolve(score()),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    const store = TestBed.inject(ScoreStore);
    store.scores.set([
      { id: 's1', title: 'Étude', bpm: 90, beats: 4, beat_unit: 4, bars: 4, note_count: 12, duration_ms: 10000, fragment_id: null, updated_at: '' },
      { id: 's2', title: 'Waltz', bpm: 120, beats: 3, beat_unit: 4, bars: 1, note_count: 1, duration_ms: 1500, fragment_id: null, updated_at: '' },
    ]);
    const fixture = TestBed.createComponent(ScoreListComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('90 BPM · 4 bars · 12 notes');
    expect(el.textContent).toContain('120 BPM · 1 bar · 1 note');
    store.filter.set('wal');
    fixture.detectChanges();
    expect(el.querySelectorAll('li')).toHaveLength(1);
    el.querySelector<HTMLButtonElement>('li button')!.click();
    await flush(10);
    expect(store.selectedId()).toBe('s2');
    store.filter.set('zzz');
    fixture.detectChanges();
    expect(el.textContent).toContain('No scores match');
  });
});
