import { TestBed } from '@angular/core/testing';
import { PlaybackStore } from './playback.store';
import { TauriApiService } from './tauri-api.service';

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
});
