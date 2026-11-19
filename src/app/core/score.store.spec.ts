import { TestBed } from '@angular/core/testing';
import { mockApi } from '../testing/mock-api';
import { I18nService } from './i18n/i18n.service';
import type { ScoreDto } from './models';
import { PlaybackStore } from './playback.store';
import { newScore, scoreKey } from './score';
import { ScoreStore } from './score.store';
import { ToastService } from './toast.service';

const empty = (): ScoreDto => newScore('s1', 'Étude', '2026-01-01T00:00:00Z');

describe('ScoreStore', () => {
  let store: ScoreStore;
  let mock: ReturnType<typeof mockApi>;
  let saved: ScoreDto[];
  let failNextSave = false;

  beforeEach(async () => {
    vi.useFakeTimers();
    saved = [];
    failNextSave = false;
    mock = mockApi({
      getScores: () => Promise.resolve([]),
      getScore: () => Promise.resolve(empty()),
      createScore: () => Promise.resolve(empty()),
      saveScore: (doc: ScoreDto) => {
        if (failNextSave) {
          failNextSave = false;
          return Promise.reject('invalid');
        }
        saved.push(doc);
        return Promise.resolve({ ...doc, fragment_id: doc.treble.length + doc.bass.length ? 'frag1' : null, updated_at: 'now' });
      },
      deleteScore: () => Promise.resolve(),
      playScore: () => Promise.resolve(),
      updateScorePlayback: () => Promise.resolve(),
      previewNote: () => Promise.resolve(),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(ScoreStore);
    await store.select('s1');
  });

  afterEach(() => vi.useRealTimers());

  const treble = () => store.doc()!.treble;
  const bass = () => store.doc()!.bass;

  it('opens a score and clears the selection and the history', () => {
    expect(store.doc()?.id).toBe('s1');
    expect(store.canUndo()).toBe(false);
    expect(store.key()).toBe(scoreKey('s1'));
  });

  it('places a note of the current value on a line of a staff and selects it', () => {
    expect(store.placeNote('treble', 0, 0)).toBe(true); // E4
    expect(treble()).toHaveLength(1);
    expect(treble()[0]).toMatchObject({ tick: 0, duration_ticks: 480, key: 64, accidental: null });
    expect(store.selectedNote()?.note.id).toBe(treble()[0].id);
    expect(mock.argsOf('previewNote')).toEqual([64]);
  });

  it('uses the chosen value, the dot and the accidental', () => {
    store.setKind('half');
    store.toggleDotted();
    expect(store.toolTicks()).toBe(1440);
    store.toggleAccidental('sharp');
    store.placeNote('treble', 0, -2); // C
    expect(treble()[0]).toMatchObject({ duration_ticks: 1440, key: 61, accidental: 'sharp' });
    store.setKind('whole'); // a whole note cannot be dotted
    expect(store.dotted()).toBe(false);
    expect(store.toolTicks()).toBe(1920);
  });

  it('refuses a note that does not fit and says so', () => {
    store.setKind('half');
    store.placeNote('treble', 0, 0);
    store.setKind('quarter');
    const toasts = TestBed.inject(ToastService);
    expect(store.placeNote('treble', 480, 2)).toBe(false); // inside the half note
    expect(toasts.toasts().at(-1)?.message ?? '').toContain('no room');
    expect(treble()).toHaveLength(1);
    expect(store.fits('treble', 960)).toBe(true);
    expect(store.fits('treble', 480)).toBe(false);
    expect(store.fits('bass', 480)).toBe(true);
  });

  it('adds a note where another starts as a chord, with the value of the others', () => {
    store.setKind('half');
    store.placeNote('treble', 0, 0); // E4
    store.setKind('eighth'); // the tool says eighth, but a chord has one value
    store.placeNote('treble', 0, 2); // G4
    store.placeNote('treble', 0, 4); // B4
    expect(treble().map((n) => [n.tick, n.duration_ticks, n.key])).toEqual([
      [0, 960, 64],
      [0, 960, 67],
      [0, 960, 71],
    ]);
    expect(store.fits('treble', 0)).toBe(true);
    expect(store.placeNote('treble', 0, 0)).toBe(false); // E4 again
  });

  it('ties the selected note, adding the note it joins, and unties it', () => {
    store.placeNote('treble', 3 * 480, 0); // E4 on beat 4
    store.toggleTieSelected();
    expect(treble().map((n) => [n.tick, n.tie])).toEqual([
      [1440, true],
      [1920, false], // the first beat of the next bar
    ]);
    expect(store.selectedNote()?.note.tie).toBe(true);
    store.toggleTieSelected();
    expect(treble()[0].tie).toBe(false);
    store.undo();
    expect(treble()[0].tie).toBe(true);
  });

  it('says so when a note cannot be tied', () => {
    store.setBars(1);
    store.placeNote('treble', 1440, 0); // the last beat of the only bar
    store.toggleTieSelected();
    expect(treble()[0].tie).toBe(false);
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message ?? '').toContain('tie');
  });

  it('does nothing to tie when no note is selected', () => {
    store.toggleTieSelected();
    expect(store.canUndo()).toBe(false);
  });

  it('sets a pickup, unless a bar line would cut a note', () => {
    store.setPickup(480);
    expect(store.doc()!.pickup_ticks).toBe(480);
    store.setPickup(0);
    store.setKind('half');
    store.placeNote('treble', 0, 0);
    store.setPickup(480); // the first bar would be one beat long
    expect(store.doc()!.pickup_ticks).toBe(0);
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message ?? '').toContain('pickup');
  });

  it('ends the score with the bar a pickup lacks, and gives it back when the pickup goes', () => {
    expect(store.doc()!.bars).toBe(4);
    store.setPickup(3 * 480); // a pickup of three beats in 4/4
    expect(store.doc()!.bars).toBe(5); // the closing bar is counted
    store.placeNote('treble', 3 * 480 + 1920 * 3, 0); // the first beat of the closing bar (one beat long)
    expect(treble()).toHaveLength(1);
    expect(store.fits('treble', 3 * 480 + 1920 * 3 + 480)).toBe(false); // past the end of the closing bar
    store.setPickup(0);
    expect(store.doc()!.bars).toBe(4);
  });

  it('keeps the closing bar of a pickup: the bars cannot go below two', () => {
    store.setPickup(480);
    expect(store.doc()!.bars).toBe(5);
    store.setBars(2); // the pickup and its closing bar
    expect(store.doc()!.bars).toBe(2);
    store.setBars(1);
    expect(store.doc()!.bars).toBe(2); // refused: the closing bar stays
  });

  it('puts notes in every 3/4 bar with the dotted half note, which the half-note grid could not reach', () => {
    store.setTimeSignature(3, 4);
    store.setKind('half');
    store.toggleDotted();
    for (const bar of [0, 1, 2, 3]) expect(store.fits('treble', bar * 1440)).toBe(true);
    expect(store.fits('treble', 960)).toBe(false); // it would cross the bar line
  });

  it('does not play the preview while the score is playing', async () => {
    store.placeNote('treble', 0, 0);
    mock.set('previewNote', () => Promise.resolve());
    const before = mock.count('previewNote');
    TestBed.inject(PlaybackStore).progress.set({ file_path: scoreKey('s1'), current_ms: 0, duration_ms: 4000, is_playing: true });
    store.placeNote('treble', 480, 2);
    expect(mock.count('previewNote')).toBe(before);
  });

  it('moves a note in time, pitch and hand, and ignores a move to where it already is', () => {
    store.placeNote('treble', 0, 0);
    const id = treble()[0].id;
    expect(store.moveTo(id, 'treble', 0, 0)).toBe(true);
    expect(store.canUndo()).toBe(true); // only the placement
    store.undo();
    store.redo();
    expect(store.moveTo(id, 'treble', 960, 4)).toBe(true);
    expect(treble()[0]).toMatchObject({ tick: 960, key: 71 });
    expect(store.moveTo(id, 'bass', 960, 4)).toBe(true);
    expect(treble()).toHaveLength(0);
    expect(bass()[0]).toMatchObject({ id, tick: 960 });
  });

  it('keeps the spelling of a black key when it moves to a line that can take it', () => {
    store.toggleAccidental('flat');
    store.placeNote('treble', 0, 1); // F♭ is not a key: stays F
    expect(treble()[0]).toMatchObject({ key: 65, accidental: null });
    store.placeNote('treble', 480, 3); // A♭
    const id = treble()[1].id;
    expect(treble()[1]).toMatchObject({ key: 68, accidental: 'flat' });
    store.moveTo(id, 'treble', 480, 4); // B♭
    expect(treble()[1]).toMatchObject({ key: 70, accidental: 'flat' });
  });

  it('changes the value of the selected note, or says there is no room', () => {
    store.placeNote('treble', 0, 0);
    store.placeNote('treble', 480, 0);
    store.selectNote(treble()[0].id);
    store.setKind('half');
    store.applyToolToSelected();
    expect(treble()[0].duration_ticks).toBe(480); // the next note is in the way
    expect(TestBed.inject(ToastService).toasts().length).toBeGreaterThan(0);
    store.setKind('eighth');
    store.applyToolToSelected();
    expect(treble()[0].duration_ticks).toBe(240);
  });

  describe('changing the value of a selected note from the palette', () => {
    /** The case that could not be done: a dotted half note tied to the one before, to become a plain half note. */
    function tiedDottedHalves() {
      store.setTimeSignature(3, 4);
      store.setKind('half');
      store.toggleDotted(); // the tool stays dotted from placing dotted half notes
      store.placeNote('treble', 0, 4); // bar 1
      store.toggleTieSelected(); // adds the dotted half note it ties to, in bar 2
      return treble();
    }

    it('shows the value of the selected note in the palette', () => {
      store.setTimeSignature(3, 4);
      store.setKind('half');
      store.toggleDotted();
      store.placeNote('treble', 0, 4);
      store.setKind('eighth');
      expect(store.dotted()).toBe(true);
      store.setKind('quarter');
      store.selectNote(null);
      store.selectNote(treble()[0].id);
      expect([store.kind(), store.dotted()]).toEqual(['half', true]);
    });

    /** The score of the screenshot: 4/4, a quarter, a dotted half tied over the bar line to another dotted half. */
    function fourFour() {
      store.setKind('quarter');
      store.placeNote('treble', 0, 4);
      store.setKind('half');
      store.toggleDotted();
      store.placeNote('treble', 480, 4); // dotted half on beat 2, to the end of the bar
      store.toggleTieSelected(); // adds the dotted half it ties to, on beat 1 of the next bar
      return treble();
    }

    it('4/4: the tail of a tie of dotted half notes becomes a plain half note', () => {
      const notes = fourFour();
      expect(notes.map((n) => [n.tick, n.duration_ticks, n.tie])).toEqual([
        [0, 480, false],
        [480, 1440, true],
        [1920, 1440, false],
      ]);
      store.selectNote(notes[2].id);
      store.toggleDotted();
      expect(treble().map((n) => n.duration_ticks)).toEqual([480, 1440, 960]);
      expect(treble()[1].tie).toBe(true);
    });

    it('4/4: choosing half for a selected dotted half note makes it a plain half note', () => {
      const notes = fourFour();
      store.selectNote(notes[2].id);
      store.chooseKind('half');
      expect(treble()[2].duration_ticks).toBe(960);
      expect([store.kind(), store.dotted()]).toEqual(['half', false]);
    });

    it('turns a dotted half note into a plain half note by undotting it', () => {
      const [a, b] = tiedDottedHalves();
      expect([a.duration_ticks, b.duration_ticks, a.tie]).toEqual([1440, 1440, true]);
      store.selectNote(b.id);
      expect(store.dotted()).toBe(true); // the dot button shows it
      store.toggleDotted();
      expect(treble().map((n) => n.duration_ticks)).toEqual([1440, 960]);
      expect(treble()[0].tie).toBe(true); // the tie holds: the note starts where the other ends
      expect([store.kind(), store.dotted()]).toEqual(['half', false]);
      expect(store.canUndo()).toBe(true);
    });

    it('changes the value as soon as another one is chosen, as a plain value, and dots it on request', () => {
      const [, b] = tiedDottedHalves();
      store.selectNote(b.id);
      store.chooseKind('quarter');
      expect(treble()[1].duration_ticks).toBe(480); // the dot is a separate choice
      store.toggleDotted();
      expect(treble()[1].duration_ticks).toBe(720);
      store.chooseKind('half');
      expect(treble()[1].duration_ticks).toBe(960);
    });

    it('does not edit a note that was just placed: the palette is for the next one', () => {
      store.placeNote('treble', 0, 0); // a quarter note, selected for the arrow keys
      store.chooseKind('half');
      store.toggleDotted();
      expect(treble()[0].duration_ticks).toBe(480);
      expect([store.kind(), store.dotted()]).toEqual(['half', true]);
      store.placeNote('treble', 480, 2);
      expect(treble().map((n) => n.duration_ticks)).toEqual([480, 1440]);
      // Clicking it makes the palette edit it.
      store.selectNote(treble()[0].id);
      store.chooseKind('eighth');
      expect(treble()[0].duration_ticks).toBe(240);
    });

    it('says so, and shows the real value again, when the new one does not fit', () => {
      store.setTimeSignature(3, 4);
      store.setKind('half');
      store.placeNote('treble', 1440 - 960, 4); // a half note on beats 2-3, the bar is full to the end
      store.selectNote(treble()[0].id);
      store.toggleDotted(); // a dotted half note would cross the bar line
      expect(treble()[0].duration_ticks).toBe(960);
      expect(store.dotted()).toBe(false);
      expect(TestBed.inject(ToastService).toasts().at(-1)?.message ?? '').toContain('no room');
    });

    it('does not touch the selected note when a value is dropped from the palette', () => {
      store.placeNote('treble', 0, 0); // quarter, selected
      store.setTool('half', true);
      expect(treble()[0].duration_ticks).toBe(480);
      expect([store.kind(), store.dotted()]).toEqual(['half', true]);
    });

    it('leaves the tool alone when nothing is selected', () => {
      store.chooseKind('eighth');
      store.toggleDotted();
      expect([store.kind(), store.dotted()]).toEqual(['eighth', true]);
      expect(store.canUndo()).toBe(false);
    });
  });

  it('shifts the selected note by lines and spaces and nudges it in time', () => {
    store.placeNote('treble', 480, 0);
    store.shiftSelected(1);
    expect(treble()[0].key).toBe(65);
    store.shiftSelected(-8); // F4 eight steps down is E3
    expect(treble()[0].key).toBe(52);
    store.nudgeSelected(-480);
    expect(treble()[0].tick).toBe(0);
    store.nudgeSelected(-480); // cannot go before the start
    expect(treble()[0].tick).toBe(0);
  });

  it('sharpens the selected note with the same shortcut that sets the tool', () => {
    store.placeNote('treble', 0, -2);
    store.toggleAccidental('sharp');
    expect(store.accidental()).toBe('sharp');
    expect(treble()[0]).toMatchObject({ key: 61, accidental: 'sharp' });
    store.toggleAccidental('sharp');
    expect(store.accidental()).toBeNull();
    expect(treble()[0]).toMatchObject({ key: 60, accidental: null });
  });

  it('removes the selected note and undoes and redoes the edits', () => {
    store.placeNote('treble', 0, 0);
    store.placeNote('treble', 480, 2);
    store.removeSelected();
    expect(treble()).toHaveLength(1);
    expect(store.selectedNoteId()).toBeNull();
    store.undo();
    expect(treble()).toHaveLength(2);
    store.undo();
    store.undo();
    expect(treble()).toHaveLength(0);
    expect(store.canUndo()).toBe(false);
    store.redo();
    expect(treble()).toHaveLength(1);
    expect(store.canRedo()).toBe(true);
  });

  it('edits the tempo and the bars, and refuses what would cut a note off', () => {
    store.setBpm(120);
    expect(store.doc()!.bpm).toBe(120);
    store.setBpm(5);
    expect(store.doc()!.bpm).toBe(120);
    store.setBars(6);
    expect(store.doc()!.bars).toBe(6);
    store.placeNote('treble', 5 * 1920, 0);
    store.setBars(3);
    expect(store.doc()!.bars).toBe(6);
    expect(TestBed.inject(ToastService).toasts().length).toBeGreaterThan(0);
  });

  it('changes the time signature unless a note would cross a bar line or fall off the end', () => {
    store.setTimeSignature(3, 4);
    expect(store.doc()!.beats).toBe(3);
    store.setKind('half');
    store.placeNote('treble', 480, 0); // beats 2-3 of the first 3/4 bar
    store.setTimeSignature(2, 4); // it would cross the bar line
    expect(store.doc()!.beats).toBe(3);
    store.setTimeSignature(4, 4); // it fits 4/4
    expect(store.doc()!.beats).toBe(4);
    store.setBars(1);
    store.setTimeSignature(2, 4);
    expect(store.doc()!.beats).toBe(4); // the half note would end past the only 2/4 bar
  });

  it('closes the score with a repeat sign and takes it away, undoably', () => {
    expect(store.doc()!.repeat).toBe(false);
    store.toggleRepeat();
    expect(store.doc()!.repeat).toBe(true);
    store.undo();
    expect(store.doc()!.repeat).toBe(false);
    store.redo();
    expect(store.doc()!.repeat).toBe(true);
  });

  it('saves the repeat sign and shows the second pass over the first', async () => {
    store.toggleRepeat();
    await vi.advanceTimersByTimeAsync(500);
    expect(saved[0].repeat).toBe(true);
    store.setBpm(120);
    const playback = TestBed.inject(PlaybackStore);
    // The score is 4 bars of 4/4 = 8 s at 120 BPM; 9 s into the player is 1 s into the repeat.
    playback.progress.set({ file_path: scoreKey('s1'), current_ms: 9000, duration_ms: 16000, is_playing: true });
    expect(store.positionTicks()).toBe(960);
  });

  it('renames only with text', () => {
    store.rename('  Prelude ');
    expect(store.doc()!.title).toBe('Prelude');
    store.rename('   ');
    expect(store.doc()!.title).toBe('Prelude');
  });

  it('saves a moment after the last edit, once, and keeps the stored fragment id', async () => {
    store.placeNote('treble', 0, 0);
    store.placeNote('treble', 480, 2);
    expect(saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toHaveLength(1);
    expect(saved[0].treble).toHaveLength(2);
    expect(store.doc()!.fragment_id).toBe('frag1');
    expect(store.scores()[0]).toMatchObject({ id: 's1', note_count: 2, fragment_id: 'frag1' });
  });

  it('keeps edits made while a save is in flight', async () => {
    let finish!: (d: ScoreDto) => void;
    mock.set('saveScore', (doc: ScoreDto) => {
      saved.push(doc);
      return new Promise<ScoreDto>((r) => (finish = r));
    });
    store.placeNote('treble', 0, 0);
    await vi.advanceTimersByTimeAsync(500);
    store.placeNote('treble', 480, 2); // while the first save is pending
    finish({ ...saved[0], fragment_id: 'frag1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(treble()).toHaveLength(2);
    expect(store.doc()!.fragment_id).toBe('frag1');
  });

  it('reloads the stored version when a save is rejected', async () => {
    store.placeNote('treble', 0, 0);
    failNextSave = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(treble()).toHaveLength(0); // back to what the vault has
    expect(store.canUndo()).toBe(false);
  });

  it('flushes pending edits before switching score', async () => {
    store.placeNote('treble', 0, 0);
    await store.select(null);
    expect(saved).toHaveLength(1);
    expect(store.doc()).toBeNull();
  });

  it('creates and deletes scores', async () => {
    await store.create();
    expect(mock.names()).toContain('createScore');
    expect(store.doc()?.id).toBe('s1');
    await store.remove('s1');
    expect(mock.argsOf('deleteScore')).toEqual(['s1']);
    expect(store.doc()).toBeNull();
  });

  it('plays the notes as they are in the editor and tells the player about edits', async () => {
    store.placeNote('treble', 0, 0);
    await store.togglePlay();
    expect(mock.argsOf('playScore')?.[0]).toMatchObject({ id: 's1' });
    expect((mock.argsOf('playScore')?.[0] as ScoreDto).treble).toHaveLength(1);
    store.placeNote('treble', 480, 2);
    expect(mock.count('updateScorePlayback')).toBe(1);
    expect((mock.argsOf('updateScorePlayback')?.[0] as ScoreDto).treble).toHaveLength(2);
  });

  it('seeks in ticks and follows the playhead', async () => {
    store.setBpm(120);
    const playback = TestBed.inject(PlaybackStore);
    playback.progress.set({ file_path: scoreKey('s1'), current_ms: 500, duration_ms: 4000, is_playing: true });
    playback.activeFile.set(scoreKey('s1'));
    expect(store.positionTicks()).toBe(480);
    expect(store.playing()).toBe(true);
    await store.seekToTick(960);
    expect(mock.argsOf('seekMidiPlayback')).toEqual([1000]);
  });

  it('plays even an empty score (the play button is what stays disabled)', async () => {
    await store.togglePlay();
    expect(mock.count('playScore')).toBe(1);
  });

  it('forgets everything when the vault changes', () => {
    store.placeNote('treble', 0, 0);
    store.reset();
    expect(store.doc()).toBeNull();
    expect(store.scores()).toEqual([]);
    expect(store.canUndo()).toBe(false);
  });
});
