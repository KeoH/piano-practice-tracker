import { TestBed } from '@angular/core/testing';
import { CompositionStore } from './composition.store';
import type { CompositionDto, LibraryFragmentDto } from './models';
import { PlaybackStore } from './playback.store';
import { TauriApiService } from './tauri-api.service';

function fragment(id: string, duration: number): LibraryFragmentDto {
  return {
    id,
    title: id.toUpperCase(),
    file_path: `/v/midi/fragments/${id}.mid`,
    duration_ms: duration,
    session_id: 's',
    session_title: 'Monday',
    session_date: '2026-10-19',
    piece_id: null,
    piece_title: null,
    passage: '',
    created_at: '',
  };
}

function composition(): CompositionDto {
  return {
    id: 'c1',
    title: 'Arrangement',
    created_at: '',
    updated_at: '',
    tracks: [{ id: 't1', name: 'Track 1', program: 0, volume: 100, muted: false, solo: false, sustain: true, color: 0, clips: [] }],
  };
}

/** Mock of the IPC facade: saves echo the document back. */
function mockApi() {
  const saved: CompositionDto[] = [];
  const mixes: unknown[] = [];
  let failNextSave = false;
  return {
    saved,
    mixes,
    failSave: () => (failNextSave = true),
    api: {
      available: true,
      onPlaybackProgress: () => Promise.resolve(() => undefined),
      getCompositions: () => Promise.resolve([]),
      getComposition: () => Promise.resolve(composition()),
      createComposition: () => Promise.resolve(composition()),
      getLibraryFragments: () => Promise.resolve([]),
      getMidiNotes: () => Promise.reject('no notes in tests'),
      setCompositionMix: (_id: string, mix: unknown) => {
        mixes.push(mix);
        return Promise.resolve();
      },
      saveComposition: (doc: CompositionDto) => {
        if (failNextSave) {
          failNextSave = false;
          return Promise.reject('invalid');
        }
        saved.push(doc);
        return Promise.resolve({ ...doc, updated_at: 'now' });
      },
    },
  };
}

describe('CompositionStore', () => {
  let store: CompositionStore;
  let mock: ReturnType<typeof mockApi>;

  beforeEach(async () => {
    vi.useFakeTimers();
    mock = mockApi();
    TestBed.configureTestingModule({ providers: [{ provide: TauriApiService, useValue: mock.api }] });
    store = TestBed.inject(CompositionStore);
    await store.select('c1');
  });

  afterEach(() => vi.useRealTimers());

  const clips = (track = 0) => store.doc()!.tracks[track].clips;

  it('adds fragments after the clips they would overlap and selects them', () => {
    store.addFragment(fragment('a', 4_000), 0, 0);
    store.addFragment(fragment('b', 2_000), 0, 1_000);
    expect(clips().map((c) => [c.fragment_id, c.start_ms, c.length_ms])).toEqual([
      ['a', 0, 4_000],
      ['b', 4_000, 2_000],
    ]);
    expect(store.selectedClip()?.clip.fragment_id).toBe('b');
    expect(store.uses().get('a')).toBe(1);
    expect(store.duration()).toBe(6_000);
  });

  it('drops on a new track in a single undo step', () => {
    store.addFragment(fragment('a', 4_000), 1, 500);
    expect(store.doc()!.tracks.length).toBe(2);
    expect(store.doc()!.tracks[1]).toMatchObject({ name: 'Track 2', color: 1 });
    expect(clips(1)[0].start_ms).toBe(500);
    expect(store.activeTrack()).toBe(1);
    store.undo();
    expect(store.doc()!.tracks.length).toBe(1);
    expect(store.selectedClip()).toBeNull();
    store.redo();
    expect(clips(1).length).toBe(1);
  });

  it('saves a moment after the last edit, once', async () => {
    store.addFragment(fragment('a', 4_000), 0, 0);
    store.transposeBy(2);
    expect(mock.saved.length).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.saved.length).toBe(1);
    expect(mock.saved[0].tracks[0].clips[0].transpose).toBe(2);
    expect(store.doc()!.updated_at).toBe('now');
    expect(store.compositions()[0]).toMatchObject({ id: 'c1', clip_count: 1, duration_ms: 4_000 });
  });

  it('reloads the stored version when a save is rejected', async () => {
    store.addFragment(fragment('a', 4_000), 0, 0);
    mock.failSave();
    await vi.advanceTimersByTimeAsync(500);
    expect(clips()).toEqual([]);
    expect(store.canUndo()).toBe(false);
  });

  it('moves, copies and nudges clips without overlapping', () => {
    store.addFragment(fragment('a', 2_000), 0, 0);
    store.addFragment(fragment('b', 2_000), 0, 5_000);
    const a = clips()[0].id;
    store.moveClip(a, 0, 4_000);
    expect(clips().map((c) => c.start_ms)).toEqual([5_000, 7_000]); // after b
    store.addTrack();
    store.moveClip(a, 1, 1_000, true);
    expect(clips(1)[0].start_ms).toBe(1_000);
    expect(clips(1)[0].id).not.toBe(a);
    expect(clips(0).length).toBe(2);

    store.selectClip(clips(0)[0].id); // b at 5 s, a right after it
    store.nudgeSelected(1_000);
    expect(clips(0)[0].start_ms).toBe(5_000);
    store.nudgeSelected(-1_000);
    expect(clips(0)[0].start_ms).toBe(4_000);
  });

  it('splits at the playhead and duplicates', () => {
    store.addFragment(fragment('a', 4_000), 0, 0);
    vi.spyOn(TestBed.inject(PlaybackStore), 'positionFor').mockReturnValue(1_000);
    store.splitSelected();
    expect(clips().map((c) => [c.start_ms, c.trim_start_ms, c.length_ms])).toEqual([
      [0, 0, 1_000],
      [1_000, 1_000, 3_000],
    ]);
    expect(store.selectedClip()?.index).toBe(1);
    store.duplicateSelected();
    expect(clips().map((c) => c.start_ms)).toEqual([0, 1_000, 4_000]);
  });

  it('limits repeats to the room on the track', () => {
    store.addFragment(fragment('a', 1_000), 0, 0);
    store.addFragment(fragment('b', 1_000), 0, 3_000);
    store.selectClip(clips()[0].id);
    store.setRepeats(3);
    expect(clips()[0].repeats).toBe(3);
    store.setRepeats(4);
    expect(clips()[0].repeats).toBe(3);
  });

  it('makes a volume drag one undo step and sends the mix', () => {
    store.setVolume(0, 90, false);
    store.setVolume(0, 70, false);
    store.setVolume(0, 60, true);
    expect(store.doc()!.tracks[0].volume).toBe(60);
    expect(mock.mixes.at(-1)).toEqual([{ volume: 60, muted: false, solo: false }]);
    store.undo();
    expect(store.doc()!.tracks[0].volume).toBe(100);
    store.toggleSolo(0);
    expect(mock.mixes.at(-1)).toEqual([{ volume: 100, muted: false, solo: true }]);
  });

  it('removes a track and keeps the active one in range', () => {
    store.addTrack();
    store.addTrack();
    expect(store.activeTrack()).toBe(2);
    store.removeTrack(2);
    expect(store.doc()!.tracks.length).toBe(2);
    expect(store.activeTrack()).toBe(1);
  });
});
