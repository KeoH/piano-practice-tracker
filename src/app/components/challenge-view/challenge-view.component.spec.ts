import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { mockApi } from '../../testing/mock-api';
import { ChallengeStore } from '../../core/challenge.store';
import { scoreEvents } from '../../core/challenge-score';
import { I18nService } from '../../core/i18n/i18n.service';
import type { MelodyDetailDto, MelodyDto, NoteDto, ScoreDto, ScoreNoteDto } from '../../core/models';
import { newScore } from '../../core/score';
import { ChallengeViewComponent } from './challenge-view.component';

const n = (id: string, tick: number, key: number): ScoreNoteDto => ({ id, tick, duration_ticks: 480, key, accidental: null, tie: false });
const score: ScoreDto = { ...newScore('s', 'Etude', ''), bpm: 120, bars: 2, treble: [n('a', 0, 64), n('b', 480, 67)] };
const melodyFor = (s: ScoreDto): NoteDto[] => {
  const events = scoreEvents(s);
  return events.map((e) => ({ key: e.key, start_ms: Math.round(e.startMs - events[0].startMs), end_ms: 400, velocity: 80 }));
};
const melody: MelodyDto = {
  id: 'm1',
  title: 'Etude',
  source: 'fragment',
  source_fragment_id: 'f1',
  file_path: '/v/midi/melodies/melody_m1.mid',
  bpm: 120,
  duration_ms: 1000,
  note_count: 2,
  created_at: '',
  updated_at: '',
};
const detail = (extra: Partial<MelodyDetailDto> = {}): MelodyDetailDto => ({ melody, notes: melodyFor(score), score: null, attempts: [], ...extra });

describe('ChallengeViewComponent: notation or piano roll', () => {
  let fixture: ComponentFixture<ChallengeViewComponent>;
  let store: ChallengeStore;
  let el: HTMLElement;

  beforeEach(() => {
    // jsdom has no ResizeObserver or canvas: the piano roll only needs to exist.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    TestBed.configureTestingModule({ providers: [mockApi().provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(ChallengeStore);
  });

  afterEach(() => vi.unstubAllGlobals());

  function show(d: MelodyDetailDto): void {
    store.detail.set(d);
    fixture = TestBed.createComponent(ChallengeViewComponent);
    el = fixture.nativeElement;
    fixture.detectChanges();
  }

  it('shows the notation for a melody that came from a score', () => {
    show(detail({ score }));
    expect(store.scoreMap()).not.toBeNull();
    expect(el.querySelector('app-challenge-staff')).not.toBeNull();
    expect(el.querySelector('app-piano-roll')).toBeNull();
    expect(el.querySelectorAll('app-challenge-staff g[role="img"]')).toHaveLength(2);
  });

  it('shows the piano roll for a melody recorded by hand', () => {
    show(detail());
    expect(store.scoreMap()).toBeNull();
    expect(el.querySelector('app-piano-roll')).not.toBeNull();
    expect(el.querySelector('app-challenge-staff')).toBeNull();
  });

  it('falls back to the piano roll when the score no longer matches the melody', () => {
    show(detail({ score: { ...score, treble: [n('a', 0, 64), n('b', 480, 69)] } }));
    expect(store.scoreMap()).toBeNull();
    expect(el.querySelector('app-piano-roll')).not.toBeNull();
    expect(el.querySelector('app-challenge-staff')).toBeNull();
  });

  it('colours the notes of the staff as the attempt goes', () => {
    show(detail({ score }));
    store.noteStates.set(['perfect', 'missed']);
    fixture.detectChanges();
    const notes = [...el.querySelectorAll('app-challenge-staff g[role="img"]')];
    expect(notes.map((g) => g.classList.contains('text-ok'))).toEqual([true, false]);
    expect(notes[1].classList.contains('text-rec')).toBe(true);
    expect(store.scoreStates()).toEqual({ a: 'perfect', b: 'missed' });
  });
});
