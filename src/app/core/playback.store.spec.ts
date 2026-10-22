import { TestBed } from '@angular/core/testing';
import { PlaybackStore } from './playback.store';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

/** Mock of the IPC facade: records the calls in order. */
function mockApi() {
  const calls: { cmd: string; args: unknown[] }[] = [];
  const record =
    (cmd: string, result: unknown = undefined) =>
    (...args: unknown[]) => {
      calls.push({ cmd, args });
      return Promise.resolve(result);
    };
  return {
    calls,
    names: () => calls.map((c) => c.cmd),
    api: {
      available: true,
      onPlaybackProgress: () => Promise.resolve(() => undefined),
      playMidiFile: record('play'),
      playComposition: record('playComposition'),
      pauseMidiPlayback: record('pause'),
      seekMidiPlayback: record('seek'),
      stopMidiPlayback: record('stop'),
      setPlaybackRate: (rate: number) => {
        calls.push({ cmd: 'rate', args: [rate] });
        return Promise.resolve(Math.min(1.5, Math.max(0.25, rate)));
      },
      setPlaybackLoop: record('loop'),
    },
  };
}

describe('PlaybackStore', () => {
  let store: PlaybackStore;
  let mock: ReturnType<typeof mockApi>;

  beforeEach(() => {
    mock = mockApi();
    TestBed.configureTestingModule({ providers: [{ provide: TauriApiService, useValue: mock.api }] });
    store = TestBed.inject(PlaybackStore);
  });

  it('keeps the speed the backend applied', async () => {
    await store.setRate(0.7);
    expect(store.rate()).toBe(0.7);
    await store.setRate(3);
    expect(store.rate()).toBe(1.5);
  });

  it('applies a loop right away to the loaded file', async () => {
    await store.play('a.mid', 0);
    await store.setLoop('a.mid', 1000, 3000);
    expect(store.loopFor('a.mid')).toEqual({ file: 'a.mid', start: 1000, end: 3000 });
    expect(store.loopFor('b.mid')).toBeNull();
    expect(mock.calls.at(-1)).toEqual({ cmd: 'loop', args: [{ file: 'a.mid', start: 1000, end: 3000 }] });

    await store.clearLoop('b.mid');
    expect(store.loop()).not.toBeNull();
    await store.clearLoop('a.mid');
    expect(store.loop()).toBeNull();
    expect(mock.calls.at(-1)).toEqual({ cmd: 'loop', args: [null] });
  });

  it('sends the loop of a file that was not loaded when it starts playing, from the loop start', async () => {
    await store.setLoop('a.mid', 2000, 4000);
    expect(mock.names()).not.toContain('loop');
    await store.play('a.mid', 500);
    expect(mock.calls.slice(-2)).toEqual([
      { cmd: 'play', args: ['a.mid', 2000] },
      { cmd: 'loop', args: [{ file: 'a.mid', start: 2000, end: 4000 }] },
    ]);
    // Inside the loop, it starts where asked.
    await store.play('a.mid', 3000);
    expect(mock.calls.at(-2)).toEqual({ cmd: 'play', args: ['a.mid', 3000] });
  });

  it('drops the loop when another file plays', async () => {
    await store.setLoop('a.mid', 0, 1000);
    await store.play('b.mid', 0);
    expect(store.loop()).toBeNull();
    expect(mock.names().at(-1)).toBe('play');
  });

  it('plays a composition by its key', async () => {
    await store.play('composition:abc', 1200);
    expect(mock.calls.at(-1)).toEqual({ cmd: 'playComposition', args: ['abc', 1200] });
    expect(store.activeFile()).toBe('composition:abc');
    expect(store.isPlaying('composition:abc')).toBe(true);
  });
  it('pauses and resumes the same file from its position', async () => {
    await store.play('a.mid', 1000);
    expect(store.isPlaying('a.mid')).toBe(true);
    await store.toggle('a.mid');
    expect(store.isPlaying('a.mid')).toBe(false);
    expect(store.positionFor('a.mid')).toBe(1000);
    await store.toggleActive();
    expect(mock.calls.at(-1)).toEqual({ cmd: 'play', args: ['a.mid', 1000] });
  });

  it('follows the progress events of the backend and stops a preview at its end', async () => {
    let emit!: (p: { file_path: string; current_ms: number; duration_ms: number; is_playing: boolean }) => void;
    Object.assign(mock.api, {
      onPlaybackProgress: (cb: typeof emit) => {
        emit = cb;
        return Promise.resolve(() => undefined);
      },
    });
    await store.init();
    await store.init(); // only listens once
    expect(mock.names()).toContain('rate');

    await store.play('a.mid', 0, 2000);
    emit({ file_path: 'a.mid', current_ms: 1500, duration_ms: 5000, is_playing: true });
    expect(store.positionFor('a.mid')).toBe(1500);
    expect(mock.names()).not.toContain('pause');
    emit({ file_path: 'a.mid', current_ms: 2050, duration_ms: 5000, is_playing: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.names()).toContain('pause');
    expect(store.cursors()['a.mid']).toBe(2000);
  });

  it('seeks the active file in the backend and other files locally', async () => {
    await store.play('a.mid', 0);
    await store.seek('a.mid', 2500.4);
    expect(mock.calls.at(-1)).toEqual({ cmd: 'seek', args: [2500] });
    await store.seek('b.mid', 700);
    expect(mock.calls.at(-1)?.cmd).toBe('seek');
    expect(store.positionFor('b.mid')).toBe(700);
    expect(store.positionFor(null)).toBe(0);
  });

  it('stops the active file and rewinds other files without stopping', async () => {
    await store.play('a.mid', 3000);
    await store.seek('b.mid', 900);
    await store.stop('b.mid');
    expect(store.positionFor('b.mid')).toBe(0);
    expect(mock.names()).not.toContain('stop');

    await store.stopIfActive('b.mid');
    expect(mock.names()).not.toContain('stop');
    await store.stopIfActive('a.mid');
    expect(mock.names()).toContain('stop');
    expect(store.isPlaying('a.mid')).toBe(false);
    expect(store.positionFor('a.mid')).toBe(0);
  });

  it('reports backend failures with toasts', async () => {
    const fail = () => Promise.reject('device lost');
    Object.assign(mock.api, {
      playMidiFile: fail,
      pauseMidiPlayback: fail,
      stopMidiPlayback: fail,
      setPlaybackRate: fail,
      setPlaybackLoop: fail,
    });
    const toast = TestBed.inject(ToastService);
    await store.play('a.mid', 0);
    expect(store.isPlaying('a.mid')).toBe(false);
    await store.pause();
    await store.stop();
    await store.setRate(0.5);
    expect(store.rate()).toBe(1);

    store.activeFile.set('a.mid');
    store.progress.set({ file_path: 'a.mid', current_ms: 0, duration_ms: 1000, is_playing: true });
    await store.setLoop('a.mid', 0, 500);
    expect(store.loop()).toBeNull();
    expect(toast.toasts().length).toBeGreaterThan(0);
    expect(toast.toasts().every((t) => t.kind === 'error')).toBe(true);
  });
});
