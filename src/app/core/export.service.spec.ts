import { TestBed } from '@angular/core/testing';
import { mockApi } from '../testing/mock-api';
import { ExportService, bytesToBase64, exportFileName, scorePdfKey, wavFileName } from './export.service';
import { I18nService } from './i18n/i18n.service';
import { newScore } from './score';
import { ToastService } from './toast.service';

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

describe('ExportService', () => {
  function setup(overrides: Parameters<typeof mockApi>[0] = {}) {
    const mock = mockApi({
      pickWavSavePath: (_title: string, name: string) => Promise.resolve(`/out/${name}`),
      pickSavePath: (_title: string, name: string) => Promise.resolve(`/out/${name}`),
      exportAudio: (_file: string, dest: string) => Promise.resolve(dest),
      exportCompositionAudio: (_id: string, dest: string) => Promise.resolve(dest),
      exportCompositionMidi: (_id: string, dest: string) => Promise.resolve(dest),
      exportScorePdf: (dest: string) => Promise.resolve(dest),
      ...overrides,
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    return { mock, exports: TestBed.inject(ExportService), toast: TestBed.inject(ToastService) };
  }

  it('exports a file as WAV where the user chose', async () => {
    const { mock, exports, toast } = setup();
    const done = exports.exportWav('/v/frag.mid', 'Bars 1/8');
    expect(exports.isBusy('/v/frag.mid')).toBe(false); // still choosing where
    await done;
    expect(mock.argsOf('exportAudio')).toEqual(['/v/frag.mid', '/out/Bars 1 8.wav']);
    expect(toast.toasts().at(-1)?.message).toContain('/out/Bars 1 8.wav');
    expect(exports.isBusy('/v/frag.mid')).toBe(false);
  });

  it('exports compositions as WAV or MIDI', async () => {
    const { mock, exports } = setup();
    await exports.exportComposition('c1', 'Song', 'wav');
    await exports.exportComposition('c1', 'Song', 'mid');
    expect(mock.argsOf('exportCompositionAudio')).toEqual(['c1', '/out/Song.wav']);
    expect(mock.argsOf('exportCompositionMidi')).toEqual(['c1', '/out/Song.mid']);
    expect(mock.argsOf('pickSavePath')?.[2]).toEqual({ name: 'MIDI', extensions: ['mid'] });
  });

  it('marks the file busy while it is written and ignores a second export', async () => {
    let finish!: (path: string) => void;
    const { mock, exports } = setup({ exportAudio: () => new Promise((r) => (finish = r)) });
    const first = exports.exportWav('/v/a.mid', 'A');
    await vi.waitFor(() => expect(exports.isBusy('/v/a.mid')).toBe(true));
    await exports.exportWav('/v/a.mid', 'A');
    expect(mock.count('pickWavSavePath')).toBe(1);
    finish('/out/A.wav');
    await first;
    expect(exports.isBusy('/v/a.mid')).toBe(false);
    expect(exports.isBusy(null)).toBe(false);
  });

  it('does nothing when the dialog is cancelled and reports failures', async () => {
    const { mock, exports, toast } = setup({ pickWavSavePath: () => Promise.resolve(null) });
    await exports.exportWav('/v/a.mid', 'A');
    expect(mock.count('exportAudio')).toBe(0);

    mock.set('pickWavSavePath', () => Promise.reject('no portal'));
    await exports.exportWav('/v/a.mid', 'A');
    mock.set('pickSavePath', () => Promise.resolve('/out/x.mid'));
    mock.set('exportCompositionMidi', () => Promise.reject('empty composition'));
    await exports.exportComposition('c1', 'X', 'mid');
    expect(toast.toasts().map((t) => t.kind)).toEqual(['error', 'error']);
    expect(toast.toasts().at(-1)?.message).toContain('empty composition');
  });

  describe('scores as PDF', () => {
    const score = { ...newScore('sc1', 'Gymnopédie / No. 1', '2026-01-01'), treble: [{ id: 'a', tick: 0, duration_ticks: 480, key: 72, accidental: null, tie: false }] };

    it('asks for a .pdf, draws the score and sends the PDF to the backend', async () => {
      const { mock, exports, toast } = setup();
      await exports.exportScore(score);
      expect(mock.argsOf('pickSavePath')?.[1]).toBe('Gymnopédie No. 1.pdf');
      expect(mock.argsOf('pickSavePath')?.[2]).toEqual({ name: 'PDF', extensions: ['pdf'] });
      const [dest, data] = mock.argsOf('exportScorePdf') as [string, string];
      expect(dest).toBe('/out/Gymnopédie No. 1.pdf');
      expect(atob(data).startsWith('%PDF-')).toBe(true);
      expect(toast.toasts().at(-1)?.kind).toBe('success');
      expect(toast.toasts().at(-1)?.message).toContain('/out/Gymnopédie No. 1.pdf');
      expect(exports.isBusy(scorePdfKey('sc1'))).toBe(false);
    });

    it('draws nothing and writes nothing when the dialog is cancelled', async () => {
      const { mock, exports } = setup({ pickSavePath: () => Promise.resolve(null) });
      await exports.exportScore(score);
      expect(mock.count('exportScorePdf')).toBe(0);
    });

    it('is busy while it works and ignores a second click', async () => {
      let finish!: (path: string) => void;
      const { mock, exports } = setup({ exportScorePdf: () => new Promise((r) => (finish = r)) });
      const first = exports.exportScore(score);
      await vi.waitFor(() => expect(exports.isBusy(scorePdfKey('sc1'))).toBe(true));
      await exports.exportScore(score);
      expect(mock.count('pickSavePath')).toBe(1);
      finish('/out/x.pdf');
      await first;
      expect(exports.isBusy(scorePdfKey('sc1'))).toBe(false);
    });

    it('reports a failure to write', async () => {
      const { exports, toast } = setup({ exportScorePdf: () => Promise.reject('disk full') });
      await exports.exportScore(score);
      expect(toast.toasts().at(-1)?.kind).toBe('error');
      expect(toast.toasts().at(-1)?.message).toContain('disk full');
      expect(exports.isBusy(scorePdfKey('sc1'))).toBe(false);
    });
  });
});

describe('bytesToBase64', () => {
  it('encodes small and large inputs alike', () => {
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe('SGk=');
    const big = new Uint8Array(100_000).fill(65);
    expect(atob(bytesToBase64(big))).toBe('A'.repeat(100_000));
  });
});
