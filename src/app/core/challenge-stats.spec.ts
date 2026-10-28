import {
  attemptMistakes,
  bestAttempt,
  clampTempo,
  completedChronological,
  effectiveBpm,
  hitsUpTo,
  masteredTempo,
  noteMissRates,
  runningMax,
  suggestedTempo,
  timingTendency,
  trend,
} from './challenge-stats';
import type { AttemptDto, AttemptSummaryDto, NoteDto, NoteOutcome } from './models';

function summary(over: Partial<AttemptSummaryDto> = {}): AttemptSummaryDto {
  return {
    id: 'a',
    melody_id: 'm',
    created_at: '2026-10-01T10:00:00.000Z',
    tempo_pct: 100,
    bpm: 120,
    completed: true,
    score: 500,
    accuracy: 0.5,
    hits: 1,
    perfect: 1,
    misses: 1,
    wrong: 0,
    extra: 0,
    mean_offset_ms: 0,
    mean_abs_offset_ms: 0,
    latency_comp_ms: 0,
    duration_ms: 1000,
    ...over,
  };
}

function attempt(over: Partial<AttemptSummaryDto> = {}, notes: NoteOutcome[] = []): AttemptDto {
  return { summary: summary(over), played_midi_path: null, details: { notes, errors: [] } };
}

const hit: NoteOutcome = { status: 'perfect', offset_ms: 0 };
const miss: NoteOutcome = { status: 'missed', offset_ms: null };
const notes: NoteDto[] = [0, 500, 1000].map((start_ms, i) => ({ key: 60 + i, start_ms, end_ms: start_ms + 400, velocity: 80 }));

describe('challenge-stats', () => {
  it('clamps tempos to 5 % steps', () => {
    expect(clampTempo(83)).toBe(85);
    expect(clampTempo(10)).toBe(40);
    expect(clampTempo(400)).toBe(150);
    expect(effectiveBpm(90, 80)).toBe(72);
  });

  it('finds the best completed attempt', () => {
    const list = [
      attempt({ id: 'c', score: 900, completed: false }),
      attempt({ id: 'b', score: 700, tempo_pct: 80, created_at: '2026-10-03' }),
      attempt({ id: 'a', score: 700, tempo_pct: 80, created_at: '2026-10-02' }),
      attempt({ id: 'd', score: 600 }),
    ];
    expect(bestAttempt(list)?.summary.id).toBe('a');
    expect(bestAttempt(list, 100)?.summary.id).toBe('d');
    expect(bestAttempt(list, 120)).toBeNull();
  });

  it('computes the mastered tempo and the suggestion', () => {
    const list = [attempt({ tempo_pct: 90, accuracy: 0.95 }), attempt({ tempo_pct: 120, accuracy: 0.8 }), attempt({ tempo_pct: 130, accuracy: 0.99, completed: false })];
    expect(masteredTempo(list)).toBe(90);
    expect(masteredTempo([])).toBeNull();
    expect(suggestedTempo(summary({ tempo_pct: 90, accuracy: 0.92 }))).toEqual({ tempo: 95, direction: 'up' });
    expect(suggestedTempo(summary({ tempo_pct: 150, accuracy: 1 }))).toBeNull();
    expect(suggestedTempo(summary({ tempo_pct: 80, accuracy: 0.3 }))).toEqual({ tempo: 70, direction: 'down' });
    expect(suggestedTempo(summary({ accuracy: 0.7 }))).toBeNull();
    expect(suggestedTempo(summary({ accuracy: 1, completed: false }))).toBeNull();
  });

  it('measures the trend', () => {
    expect(trend([0.5])).toBeNull();
    expect(trend([0.5, 0.7])).toBeCloseTo(0.2);
    expect(trend([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1, 1], 5)).toBeCloseTo(0.44);
  });

  it('counts hits up to a moment, scaled by the tempo', () => {
    const statuses = ['perfect', 'missed', 'good'] as const;
    expect(hitsUpTo(notes, statuses, 100, 999)).toBe(1);
    expect(hitsUpTo(notes, statuses, 100, 1000)).toBe(2);
    // At 50 % the third note is due at 2 s.
    expect(hitsUpTo(notes, statuses, 50, 1500)).toBe(1);
    expect(hitsUpTo(notes, [], 100, 5000)).toBe(0);
  });

  it('computes miss rates over the recent completed attempts', () => {
    const list = [attempt({}, [hit, miss, miss]), attempt({ completed: false }, [miss, miss, miss]), attempt({}, [hit, hit, miss]), attempt({}, [hit])];
    expect(noteMissRates(3, list)).toEqual([0, 0.5, 1]);
    expect(noteMissRates(3, list, 1)).toEqual([0, 1, 1]);
    expect(noteMissRates(3, [])).toBeNull();
  });

  it('lists the mistakes in time order', () => {
    const a = attempt({ tempo_pct: 50 }, [hit, miss, hit]);
    a.details.errors = [
      { time_ms: 1800, kind: 'wrong', played_key: 63, expected_key: 62 },
      { time_ms: 100, kind: 'extra', played_key: 70, expected_key: null },
    ];
    expect(attemptMistakes(notes, a)).toEqual([
      { time_ms: 100, kind: 'extra', key: 70, expected_key: null },
      { time_ms: 1000, kind: 'missed', key: 61, expected_key: null },
      { time_ms: 1800, kind: 'wrong', key: 63, expected_key: 62 },
    ]);
  });

  it('orders, tends and accumulates', () => {
    expect(completedChronological([attempt({ id: '2' }), attempt({ id: 'x', completed: false }), attempt({ id: '1' })]).map((a) => a.summary.id)).toEqual(['1', '2']);
    expect([timingTendency(-35), timingTendency(5), timingTendency(20)]).toEqual(['early', 'steady', 'late']);
    expect(runningMax([0.2, 0.5, 0.4, 0.9])).toEqual([0.2, 0.5, 0.5, 0.9]);
  });
});
