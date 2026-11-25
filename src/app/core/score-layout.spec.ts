import {
  END_PAD,
  HEAD_W,
  HEAD_W_NEXT,
  MAX_STRETCH,
  NOTE_X,
  PRINT_METRICS,
  SCREEN_METRICS,
  RULER_H,
  STAFF_GAP,
  STEP_PX,
  SYSTEM_H,
  barLineAt,
  hitAt,
  inRuler,
  layoutOf,
  noteX,
  restShape,
  rulerTick,
  stemUp,
  systemHeight,
  systemAt,
  xOfTick,
  yOfStep,
} from './score-layout';

const meter = { beats: 4, beat_unit: 4, bars: 4, pickup_ticks: 0 };

describe('score layout: one system', () => {
  it('lays out the grand staff under the ruler, with room for ledger lines', () => {
    const l = layoutOf(meter, 80);
    const sys = l.systems[0];
    expect(l.systems).toHaveLength(1);
    expect(sys.staves.treble.bottom - sys.staves.treble.top).toBe(40);
    expect(sys.staves.bass.top - sys.staves.treble.bottom).toBe(STAFF_GAP);
    expect(sys.staves.treble.top).toBeGreaterThan(RULER_H);
    expect(l.height).toBe(SYSTEM_H);
    expect(sys.midY).toBe((sys.staves.treble.bottom + sys.staves.bass.top) / 2);
  });

  it('is as wide as its bars, whatever the time signature', () => {
    // 80 px per quarter note: a 4/4 bar is 320 px, a 3/4 bar 240 px.
    expect(layoutOf(meter, 80).width).toBe(HEAD_W + 4 * 320 + END_PAD);
    expect(layoutOf({ beats: 3, beat_unit: 4, bars: 2, pickup_ticks: 0 }, 80).width).toBe(HEAD_W + 2 * 240 + END_PAD);
    expect(layoutOf(meter, 48).width).toBe(HEAD_W + 4 * 192 + END_PAD);
  });

  it('is shorter by what the pickup bar lacks', () => {
    // One beat of pickup in 4/4: the first bar is 80 px and the closing bar 240 px (the 3 beats it lacks),
    // so they are one whole bar of 320 px between them.
    expect(layoutOf({ ...meter, pickup_ticks: 480 }, 80).width).toBe(HEAD_W + 3 * 320 + END_PAD);
  });

  it('maps ticks to x in proportion to time', () => {
    const l = layoutOf(meter, 80);
    expect(xOfTick(l, 0)).toBe(HEAD_W);
    expect(xOfTick(l, 480)).toBe(HEAD_W + 80);
    expect(noteX(l, 480)).toBe(HEAD_W + 80 + NOTE_X);
  });

  it('puts a line or space at a step of its staff, one step being half a line spacing', () => {
    const sys = layoutOf(meter, 80).systems[0];
    expect(yOfStep(sys, 'treble', 0)).toBe(sys.staves.treble.bottom);
    expect(yOfStep(sys, 'treble', 8)).toBe(sys.staves.treble.top);
    expect(yOfStep(sys, 'treble', 1)).toBe(sys.staves.treble.bottom - STEP_PX);
    expect(yOfStep(sys, 'bass', -2)).toBe(sys.staves.bass.bottom + 2 * STEP_PX);
  });

  it('finds the staff, step and tick under the pointer, and the other way round', () => {
    const l = layoutOf(meter, 80);
    for (const staff of ['treble', 'bass'] as const) {
      for (let step = -6; step <= 14; step++) {
        for (const tick of [0, 480, 1920, 5760]) {
          const hit = hitAt(l, noteX(l, tick), yOfStep(l.systems[0], staff, step));
          expect(hit, `${staff} ${step} ${tick}`).toMatchObject({ staff, step, tick, system: 0 });
        }
      }
    }
  });

  it('snaps a pointer between two lines to the nearer step', () => {
    const l = layoutOf(meter, 80);
    const sys = l.systems[0];
    expect(hitAt(l, 200, yOfStep(sys, 'treble', 3) + 1.2)?.step).toBe(3);
    expect(hitAt(l, 200, yOfStep(sys, 'treble', 3) - STEP_PX * 0.6)?.step).toBe(4);
  });

  it('hands the gap between the staves to the nearer one (middle C belongs to both)', () => {
    const l = layoutOf(meter, 80);
    expect(hitAt(l, 200, l.systems[0].midY - 1)?.staff).toBe('treble');
    expect(hitAt(l, 200, l.systems[0].midY + 1)?.staff).toBe('bass');
  });

  it('ignores the clefs, the ruler and what is outside the SVG', () => {
    const l = layoutOf(meter, 80);
    expect(hitAt(l, HEAD_W - 1, 200)).toBeNull();
    expect(hitAt(l, 200, RULER_H - 1)).toBeNull();
    expect(hitAt(l, 200, l.height + 5)).toBeNull();
    expect(hitAt(l, l.systems[0].right + 200, 200)).toBeNull(); // past the last bar
  });

  it('seeks on the ruler, snapped and inside the score', () => {
    const l = layoutOf(meter, 80);
    expect(inRuler(l, 200, 10)).toBe(true);
    expect(inRuler(l, HEAD_W - 5, 10)).toBe(false);
    expect(inRuler(l, 200, RULER_H + 1)).toBe(false);
    expect(rulerTick(l, meter, xOfTick(l, 960) + 3, 10)).toBe(960);
    expect(rulerTick(l, meter, 0, 10)).toBe(0);
    expect(rulerTick(l, meter, 99_999, 10)).toBe(7680);
  });
});

describe('score layout: systems', () => {
  /** Four 4/4 bars are 320 px each at 80 px per quarter: 2 bars need 84 + 640 + 24. */
  const six = { beats: 3, beat_unit: 4, bars: 6, pickup_ticks: 0 }; // six 3/4 bars of 240 px

  it('breaks the bars into lines that fit the width of the view', () => {
    // 84 + 3 × 240 + 24 = 828 fits in 900; a fourth bar would need 1068.
    const l = layoutOf(six, 80, 900);
    expect(l.systems.map((s) => [s.firstBar, s.lastBar])).toEqual([[0, 2], [3, 5]]);
    expect(l.systems.map((s) => [s.startTick, s.endTick])).toEqual([[0, 4320], [4320, 8640]]);
    expect(l.height).toBe(2 * SYSTEM_H);
    expect(l.width).toBe(900);
  });

  it('stacks the systems from top to bottom, each with its own staves', () => {
    const l = layoutOf(six, 80, 900);
    expect(l.systems[1].top).toBe(SYSTEM_H);
    expect(l.systems[1].staves.treble.top - l.systems[0].staves.treble.top).toBe(SYSTEM_H);
    expect(l.systems[1].x0).toBe(HEAD_W_NEXT); // only the first line has the time signature
    expect(l.systems[0].x0).toBe(HEAD_W);
  });

  it('stretches the bars of a line to fill it, except in the last one', () => {
    const l = layoutOf(six, 80, 900);
    const [first, last] = l.systems;
    expect(first.ppt).toBeGreaterThan(80 / 480);
    expect(first.ppt).toBeLessThanOrEqual((80 / 480) * MAX_STRETCH + 1e-9);
    expect(last.ppt).toBe(80 / 480);
    expect(first.right).toBeLessThanOrEqual(900 - END_PAD + 1e-6);
  });

  it('does not stretch a line past the limit', () => {
    // Bars of 240 px in a 2000 px view: a line holds 7 of them and would stretch a lot, but it only grows by MAX_STRETCH.
    const l = layoutOf({ ...six, bars: 20 }, 80, 2000);
    expect(l.systems.length).toBeGreaterThan(1);
    expect(l.systems[0].ppt).toBeLessThanOrEqual((80 / 480) * MAX_STRETCH + 1e-9);
  });

  it('always puts at least one bar in a line, so a very wide bar makes the SVG wider than the view', () => {
    const l = layoutOf({ beats: 4, beat_unit: 4, bars: 3, pickup_ticks: 0 }, 128, 300);
    expect(l.systems.map((s) => s.lastBar - s.firstBar + 1)).toEqual([1, 1, 1]);
    expect(l.width).toBeGreaterThan(300);
  });

  it('keeps everything in one line when there is no width to fit', () => {
    expect(layoutOf(six, 80).systems).toHaveLength(1);
    expect(layoutOf(six, 80, 5000).systems).toHaveLength(1);
  });

  it('breaks after a short pickup bar like any other', () => {
    const l = layoutOf({ beats: 4, beat_unit: 4, bars: 4, pickup_ticks: 480 }, 80, 800);
    // 84 + 80 (pickup) + 320 + 24 = 508 fits, one more bar would need 828; the next line starts with a narrower head.
    expect(l.systems.map((s) => [s.firstBar, s.lastBar])).toEqual([[0, 1], [2, 3]]);
    expect(l.systems[0].startTick).toBe(0);
    expect(l.systems[0].endTick).toBe(480 + 1920);
    expect(l.systems[1].endTick).toBe(3 * 1920); // the closing bar makes the last bar short
  });

  it('finds the system of a tick, the last one past the end', () => {
    const l = layoutOf(six, 80, 900);
    expect(systemAt(l, 0).index).toBe(0);
    expect(systemAt(l, 4319).index).toBe(0);
    expect(systemAt(l, 4320).index).toBe(1);
    expect(systemAt(l, 99_999).index).toBe(1);
  });

  it('maps a tick to x inside its own system', () => {
    const l = layoutOf(six, 80, 900);
    const [a, b] = l.systems;
    expect(xOfTick(l, 4320)).toBe(b.x0);
    expect(xOfTick(l, 4320 + 480)).toBeCloseTo(b.x0 + 480 * b.ppt);
    expect(xOfTick(l, 480)).toBeCloseTo(a.x0 + 480 * a.ppt);
  });

  it('finds the system, staff, step and tick under the pointer and the other way round', () => {
    const l = layoutOf(six, 80, 900);
    for (const sys of l.systems) {
      for (const tick of [sys.startTick, sys.startTick + 480, sys.endTick - 480]) {
        for (const staff of ['treble', 'bass'] as const) {
          const hit = hitAt(l, noteX(l, tick), yOfStep(sys, staff, 3));
          expect(hit, `${sys.index} ${staff} ${tick}`).toMatchObject({ system: sys.index, staff, step: 3 });
          expect(hit!.tick).toBeCloseTo(tick);
        }
      }
    }
  });

  it('ignores a point right of the last bar of a line and the ruler of any system', () => {
    const l = layoutOf(six, 80, 900);
    const [a, b] = l.systems;
    expect(hitAt(l, a.right + 100, a.staves.treble.top)).toBeNull();
    expect(hitAt(l, 200, b.top + RULER_H - 1)).toBeNull();
    expect(inRuler(l, 200, b.top + 5)).toBe(true);
    expect(inRuler(l, 200, a.top + RULER_H + 5)).toBe(false);
  });

  it('seeks on the ruler of the line that was clicked', () => {
    const l = layoutOf(six, 80, 900);
    const b = l.systems[1];
    expect(rulerTick(l, six, b.x0, b.top + 5)).toBe(4320);
    expect(rulerTick(l, six, b.x0 + 480 * b.ppt, b.top + 5)).toBe(4320 + 480);
    expect(rulerTick(l, six, 99_999, b.top + 5)).toBe(8640);
    expect(rulerTick(l, six, 99_999, l.systems[0].top + 5)).toBe(4320); // not past the line
  });
});

describe('score layout: glyph helpers', () => {
  it('draws the rest that matches its length, and a whole-bar rest for an empty bar', () => {
    expect(restShape(1920, 1920)).toBe('bar');
    expect(restShape(1440, 1440)).toBe('bar'); // a 3/4 bar
    expect(restShape(960, 1920)).toBe('half');
    expect(restShape(480, 1920)).toBe('quarter');
    expect(restShape(240, 1920)).toBe('eighth');
    expect(restShape(120, 1920)).toBe('sixteenth');
    expect(restShape(60, 1920)).toBe('sixteenth');
  });

  it('puts the stem up below the middle line and down from it', () => {
    expect(stemUp(0)).toBe(true);
    expect(stemUp(3)).toBe(true);
    expect(stemUp(4)).toBe(false);
    expect(stemUp(9)).toBe(false);
  });
});

describe('score layout: bar lines', () => {
  const l = layoutOf(meter, 80); // four 4/4 bars of 640 px, one system
  const y = (l.systems[0].staves.treble.top + l.systems[0].staves.bass.bottom) / 2;

  it('snaps a point to the end of the closest bar', () => {
    const { x0 } = l.systems[0]; // a 4/4 bar is 320 px at 80 px per quarter note
    expect(barLineAt(l, meter, x0 + 300, y)).toMatchObject({ bar: 0, tick: 1920, x: x0 + 320 });
    expect(barLineAt(l, meter, x0 + 400, y)).toMatchObject({ bar: 0 }); // 80 px past the line, 240 from the next
    expect(barLineAt(l, meter, x0 + 500, y)).toMatchObject({ bar: 1, tick: 3840 });
    expect(barLineAt(l, meter, x0 + 1280, y)).toMatchObject({ bar: 3, tick: 7680 });
    expect(barLineAt(l, meter, x0 + 5000, y)).toBeNull(); // far past the end
  });

  it('is only in the bars of the system under the point', () => {
    const wrapped = layoutOf({ ...meter, bars: 6 }, 80, 900);
    expect(wrapped.systems.length).toBeGreaterThan(1);
    const second = wrapped.systems[1];
    const hit = barLineAt(wrapped, { ...meter, bars: 6 }, second.x0 + 10, second.top + 100)!;
    expect(hit.system).toBe(1);
    expect(hit.bar).toBeGreaterThanOrEqual(second.firstBar);
    expect(barLineAt(wrapped, meter, -50, second.top + 100)).toBeNull(); // over the clefs
    expect(barLineAt(wrapped, meter, 100, -5)).toBeNull();
  });

  it('counts the pickup bar as a short bar', () => {
    const pickup = { ...meter, bars: 3, pickup_ticks: 480 };
    const lp = layoutOf(pickup, 80);
    const hit = barLineAt(lp, pickup, lp.systems[0].x0 + 50, 100)!;
    expect(hit).toMatchObject({ bar: 0, tick: 480 });
  });
});

describe('score layout: print metrics', () => {
  it('keeps the screen layout as it was without metrics', () => {
    const a = layoutOf(meter, 80, 600);
    const b = layoutOf(meter, 80, 600, SCREEN_METRICS);
    expect(b).toEqual(a);
    expect(a.systemH).toBe(SYSTEM_H);
    expect(a.height).toBe(a.systems.length * SYSTEM_H);
  });

  it('has no ruler and closer staves for print, so a system is shorter', () => {
    const l = layoutOf(meter, 80, 600, PRINT_METRICS);
    expect(l.systemH).toBe(systemHeight(PRINT_METRICS));
    expect(l.systemH).toBeLessThan(SYSTEM_H);
    expect(l.systems[0].staves.treble.top).toBe(PRINT_METRICS.padV);
    expect(l.systems[1].top).toBe(l.systemH);
  });

  it('breaks the bars for a fixed page width', () => {
    const wide = { ...meter, bars: 12 };
    const l = layoutOf(wide, 60, 1000, PRINT_METRICS);
    expect(l.systems.length).toBeGreaterThan(1);
    for (const sys of l.systems.slice(0, -1)) expect(sys.right + END_PAD).toBeLessThanOrEqual(1000 + 1e-6);
  });
});
