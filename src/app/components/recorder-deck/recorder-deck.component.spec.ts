import { TestBed } from '@angular/core/testing';
import { detail, session } from '../../testing/fixtures';
import { type MockApi, flush, mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { SIMULATOR_PORT_ID } from '../../core/models';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { RecorderDeckComponent } from './recorder-deck.component';

describe('RecorderDeckComponent', () => {
  let mock: MockApi;
  let i18n: I18nService;
  let rec: RecordingStore;

  function setup() {
    mock = mockApi({
      stopRecording: () => Promise.resolve(session({ raw_duration_ms: 90_000 })),
      getSessionDetail: () => Promise.resolve(detail()),
      getSessions: () => Promise.resolve([]),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    const sessions = TestBed.inject(SessionStore);
    sessions.selectedId.set('s1');
    sessions.detail.set(detail({ session: session({ bpm: 72 }) }));
    rec = TestBed.inject(RecordingStore);
    const fixture = TestBed.createComponent(RecorderDeckComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const byLabel = (key: Parameters<I18nService['t']>[0]) => el.querySelector(`[aria-label="${i18n.t(key)}"]`) as HTMLButtonElement;
    return { fixture, el, byLabel };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('takes the tempo of the session and saves changes after a pause', async () => {
    const { fixture, byLabel, el } = setup();
    expect(rec.bpm()).toBe(72);
    byLabel('recorder.tempoUp').click();
    byLabel('recorder.tempoUp').click();
    byLabel('recorder.tempoDown').click();
    fixture.detectChanges();
    expect(rec.bpm()).toBe(73);
    await vi.advanceTimersByTimeAsync(600);
    expect(mock.argsOf('updateSession')).toEqual(['s1', 'Monday', 73, '']);

    const num = el.querySelector('#bpm-num') as HTMLInputElement;
    num.value = '500';
    num.dispatchEvent(new Event('input'));
    expect(rec.bpm()).toBe(73); // out of range while typing: ignored
    num.dispatchEvent(new Event('change'));
    expect(rec.bpm()).toBe(240);
    expect(num.value).toBe('240');
    num.value = '100';
    num.dispatchEvent(new Event('input'));
    expect(rec.bpm()).toBe(100);
  });

  it('toggles the metronome and the live monitoring', () => {
    const { fixture, el } = setup();
    const switches = [...el.querySelectorAll<HTMLButtonElement>('[role=switch]')];
    switches[0].click();
    switches[1].click();
    fixture.detectChanges();
    expect(rec.metronomeOn()).toBe(true);
    expect(rec.liveSynthOn()).toBe(true);
    expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'true']);
  });

  it('records and stops the session', async () => {
    const { fixture, byLabel } = setup();
    rec.ports.set([{ id: SIMULATOR_PORT_ID, name: '', is_virtual: true }]);
    rec.selectPort(SIMULATOR_PORT_ID);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(i18n.t('recorder.port.virtual'));

    byLabel('recorder.record').click();
    await flush();
    fixture.detectChanges();
    expect(mock.argsOf('startRecording')?.[0]).toBe('s1');
    expect(byLabel('recorder.stop').getAttribute('aria-pressed')).toBe('true');

    byLabel('recorder.stop').click();
    await flush(10);
    expect(mock.argsOf('stopRecording')).toEqual(['s1']);
    expect(rec.isRecording()).toBe(false);
  });

  it('cannot record while another session records', () => {
    const { fixture, byLabel } = setup();
    rec.recordingSessionId.set('other');
    fixture.detectChanges();
    expect(byLabel('recorder.record').disabled).toBe(true);
  });
});
