import { exportFileName, wavFileName } from './export.service';

describe('wavFileName', () => {
  it('keeps readable titles and adds the extension', () => {
    expect(wavFileName('Nocturne op. 9 – bars 1-16')).toBe('Nocturne op. 9 – bars 1-16.wav');
  });

  it('removes characters that are not valid in file names', () => {
    expect(wavFileName('a/b\\c: "d" <e>|f?*')).toBe('a b c d e f.wav');
    expect(wavFileName('..hidden')).toBe('hidden.wav');
  });

  it('falls back to a default name', () => {
    expect(wavFileName('  //  ')).toBe('piano.wav');
  });

  it('takes the extension of the export', () => {
    expect(exportFileName('Nocturne: arrangement', 'mid')).toBe('Nocturne arrangement.mid');
  });
});
