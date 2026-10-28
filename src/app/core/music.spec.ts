import { isBlackKey, noteName, parseNoteNames } from './music';

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
});
