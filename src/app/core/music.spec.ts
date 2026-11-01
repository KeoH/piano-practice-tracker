import { beatMs, isBlackKey, noteName, noteValue, parseNoteNames } from './music';

const EN = parseNoteNames('C,C♯,D,D♯,E,F,F♯,G,G♯,A,A♯,B');

describe('music', () => {
  it('names keys with their octave', () => {
    expect(noteName(60, EN)).toBe('C4');
    expect(noteName(61, EN)).toBe('C♯4');
    expect(noteName(21, EN)).toBe('A0');
    expect(noteName(108, EN)).toBe('C8');
    expect(noteName(59, EN)).toBe('B3');
    expect(noteName(67, parseNoteNames('Do,Do♯,Re,Re♯,Mi,Fa,Fa♯,Sol,Sol♯,La,La♯,Si'))).toBe('Sol4');
  });

  it('knows the black keys', () => {
    expect([60, 61, 62, 63, 64, 65, 66].map(isBlackKey)).toEqual([false, true, false, true, false, false, true]);
  });

  describe('noteValue', () => {
    const at90 = (beats: number) => noteValue(beats * beatMs(90), 90);

    it('names the plain and dotted values', () => {
      expect(at90(4)).toMatchObject({ kind: 'whole', dotted: false, exact: true });
      expect(at90(3)).toMatchObject({ kind: 'half', dotted: true, exact: true });
      expect(at90(2)).toMatchObject({ kind: 'half', dotted: false });
      expect(at90(1.5)).toMatchObject({ kind: 'quarter', dotted: true });
      expect(at90(1)).toMatchObject({ kind: 'quarter', dotted: false });
      expect(at90(0.5)).toMatchObject({ kind: 'eighth' });
      expect(at90(0.25)).toMatchObject({ kind: 'sixteenth' });
      expect(at90(0.125)).toMatchObject({ kind: 'thirtysecond' });
    });

    it('treats a key lifted early as the written value, not a dotted one', () => {
      const v = at90(0.8);
      expect(v).toMatchObject({ kind: 'quarter', dotted: false, exact: false });
      expect(v!.beats).toBeCloseTo(0.8);
    });

    it('is approximate between values and unknown without a tempo', () => {
      expect(at90(1.2)).toMatchObject({ kind: 'quarter', dotted: false, exact: false });
      expect(noteValue(500, 0)).toBeNull();
      expect(noteValue(0, 90)).toBeNull();
      expect(at90(0.05)).toBeNull();
    });
  });
});
