import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { mockApi } from '../../testing/mock-api';
import { mapScoreToMelody, scoreEvents } from '../../core/challenge-score';
import { I18nService } from '../../core/i18n/i18n.service';
import type { NoteDto, ScoreDto, ScoreNoteDto } from '../../core/models';
import { newScore } from '../../core/score';
import { layoutOf, xOfTick } from '../../core/score-layout';
import { ChallengeStaffComponent } from './challenge-staff.component';

const n = (id: string, tick: number, key: number, tie = false): ScoreNoteDto => ({ id, tick, duration_ticks: 480, key, accidental: null, tie });

describe('ChallengeStaffComponent', () => {
  let fixture: ComponentFixture<ChallengeStaffComponent>;
  let el: HTMLElement;
  const score: ScoreDto = { ...newScore('s', 'Etude', ''), bpm: 120, bars: 2, treble: [n('a', 960, 64), n('b', 1440, 67)] };
  const melody = (): NoteDto[] => {
    const events = scoreEvents(score);
    return events.map((e) => ({ key: e.key, start_ms: Math.round(e.startMs - events[0].startMs), end_ms: 0, velocity: 80 }));
  };
  const map = () => mapScoreToMelody(score, melody())!;
  const playheadX = () => +el.querySelector('svg > g line.stroke-accent')!.getAttribute('x1')!;
  const tickX = (tick: number) => xOfTick(layoutOf(score, 80), tick);

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [mockApi().provider] });
    TestBed.inject(I18nService).setLang('en');
    fixture = TestBed.createComponent(ChallengeStaffComponent);
    el = fixture.nativeElement;
    fixture.componentRef.setInput('map', map());
  });

  afterEach(() => vi.useRealTimers());

  const set = (inputs: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
  };

  it('shows the notation of the score with the notes coloured by their state', () => {
    set({ states: { a: 'perfect', b: 'missed' } });
    const notes = [...el.querySelectorAll('g[role="img"]')];
    expect(notes).toHaveLength(2);
    expect(notes[0].classList.contains('text-ok')).toBe(true);
    expect(notes[1].classList.contains('text-rec')).toBe(true);
  });

  it('draws the playing marks at the tick their time falls on, at the chosen tempo', () => {
    // A mistake played 500 ms into the attempt: the melody starts at beat 3, so beat 4 at 100 %.
    set({ tempoPct: 100, marks: [{ time_ms: 500, key: 60, kind: 'wrong' }] });
    expect(el.querySelectorAll('path.stroke-rec')).toHaveLength(1);
    const x = +el.querySelector('path.stroke-rec')!.getAttribute('d')!.split(' ')[1] + 5;
    expect(x).toBeCloseTo(tickX(1440) + 18);
    set({ tempoPct: 50 }); // half as fast: the same time is one beat earlier
    expect(+el.querySelector('path.stroke-rec')!.getAttribute('d')!.split(' ')[1] + 5).toBeCloseTo(tickX(1200) + 18);
  });

  it('marks the moment of a mistake chosen in the result, and nothing before that', () => {
    expect(el.querySelector('svg > g line.stroke-accent')).toBeNull();
    set({ focusMs: 500 });
    expect(playheadX()).toBeCloseTo(tickX(1440));
    set({ focusMs: null });
    expect(el.querySelector('svg > g line.stroke-accent')).toBeNull();
  });

  it('follows the clock of the attempt while it runs, waiting on the first note during the count-in', () => {
    let now = -1500;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    set({ running: true, clock: () => now });
    fixture.detectChanges();
    expect(playheadX()).toBeCloseTo(tickX(960)); // the first note
    now = 500;
    vi.advanceTimersByTime(40);
    fixture.detectChanges();
    expect(playheadX()).toBeCloseTo(tickX(1440));
    set({ running: false });
    fixture.detectChanges();
    expect(el.querySelector('svg > g line.stroke-accent')).toBeNull();
    vi.unstubAllGlobals();
  });
});
