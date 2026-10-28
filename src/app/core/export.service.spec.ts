import { TestBed } from '@angular/core/testing';
import { mockApi } from '../testing/mock-api';
import { ExportService, exportFileName, wavFileName } from './export.service';
import { I18nService } from './i18n/i18n.service';
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
});
