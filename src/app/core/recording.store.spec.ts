import { TestBed } from '@angular/core/testing';
import { session } from '../testing/fixtures';
import { type MockApi, mockApi } from '../testing/mock-api';
import { I18nService } from './i18n/i18n.service';
import { SIMULATOR_PORT_ID } from './models';
import { BPM_MAX, BPM_MIN, RecordingStore } from './recording.store';
import { SessionStore } from './session.store';
import { ToastService } from './toast.service';

const ports = [
  { id: SIMULATOR_PORT_ID, name: 'Simulator', is_virtual: true },
  { id: 'midir:Digital Piano', name: 'Digital Piano', is_virtual: false },
];

describe('RecordingStore', () => {
  let store: RecordingStore;
  let mock: MockApi;

  function setup(overrides: Parameters<typeof mockApi>[0] = {}) {
    mock = mockApi({
      listMidiPorts: () => Promise.resolve(ports),
      stopRecording: () => Promise.resolve(session({ raw_duration_ms: 90_000 })),
      ...overrides,
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    store = TestBed.inject(RecordingStore);
  }

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('lists the ports and falls back to a physical one', async () => {
    localStorage.setItem('piano-tracker.port', 'midir:Gone');
    setup();
    await store.refreshPorts();
    expect(store.selectedPortId()).toBe('midir:Digital Piano');
    expect(store.selectedPort()?.name).toBe('Digital Piano');
    expect(localStorage.getItem('piano-tracker.port')).toBe('midir:Digital Piano');
    expect(store.portName(ports[0])).toBe(TestBed.inject(I18nService).t('recorder.simulatorPort'));
    expect(store.portName(ports[1])).toBe('Digital Piano');
  });

  it('keeps a saved port that still exists', async () => {
    localStorage.setItem('piano-tracker.port', SIMULATOR_PORT_ID);
    setup();
    await store.refreshPorts();
    expect(store.selectedPortId()).toBe(SIMULATOR_PORT_ID);
  });

  it('offers only the simulator without the backend', async () => {
    setup({ available: false });
    await store.refreshPorts();
    expect(store.ports().map((p) => p.id)).toEqual([SIMULATOR_PORT_ID]);
  });

  it('reports a failure listing the ports', async () => {
    setup({ listMidiPorts: () => Promise.reject('alsa') });
    await store.refreshPorts();
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message).toContain('alsa');
    expect(store.portsLoading()).toBe(false);
  });

  it('clamps the BPM and sends it debounced', () => {
    setup();
    store.setBpm(10);
    store.setBpm(300.4);
    store.setBpm(Number.NaN);
    expect(store.bpm()).toBe(BPM_MAX);
    expect(mock.count('updateLiveRecordingSettings')).toBe(0);
    vi.advanceTimersByTime(150);
    expect(mock.calls.filter((c) => c.cmd === 'updateLiveRecordingSettings').map((c) => c.args)).toEqual([[BPM_MAX, false, false]]);
    store.setBpm(BPM_MAX);
    vi.advanceTimersByTime(150);
    expect(mock.count('updateLiveRecordingSettings')).toBe(1);
    store.setBpm(1);
    expect(store.bpm()).toBe(BPM_MIN);
  });

  it('sends the toggles at once', () => {
    setup();
    store.toggleMetronome();
    store.toggleLiveSynth();
    expect(mock.argsOf('updateLiveRecordingSettings')).toEqual([120, true, true]);
  });

  it('takes the BPM from the session unless it is recording', async () => {
    setup();
    store.loadFromSession(session({ bpm: 72 }));
    expect(store.bpm()).toBe(72);
    await store.start('s1');
    store.loadFromSession(session({ bpm: 100 }));
    expect(store.bpm()).toBe(72);
  });

  it('records with a running timer and stops', async () => {
    setup();
    store.selectPort(SIMULATOR_PORT_ID);
    expect(await store.start('s1')).toBe(true);
    expect(mock.names()).toContain('stopMidiPlayback');
    expect(mock.argsOf('startRecording')).toEqual(['s1', SIMULATOR_PORT_ID, 120, false, false]);
    expect(store.isRecording()).toBe(true);
    expect(await store.start('s1')).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(store.elapsedMs()).toBeGreaterThan(0);

    const sessions = TestBed.inject(SessionStore);
    sessions.selectedId.set('s1');
    sessions.detail.set({ session: session(), fragments: [], media: [], undo_depth: 0, undo_fragment_id: null });
    await store.stopAndRefresh();
    expect(store.isRecording()).toBe(false);
    expect(mock.names()).toContain('getSessionDetail');
    expect(await store.stop()).toBeNull();
  });

  it('reports failures to start and stop', async () => {
    setup({ startRecording: () => Promise.reject('port busy') });
    expect(await store.start('s1')).toBe(false);
    expect(store.busy()).toBe(false);

    mock.set('startRecording', () => Promise.resolve());
    mock.set('stopRecording', () => Promise.reject('disk full'));
    await store.start('s1');
    await store.stopAndRefresh();
    expect(store.isRecording()).toBe(true);
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message).toContain('disk full');
  });
});
