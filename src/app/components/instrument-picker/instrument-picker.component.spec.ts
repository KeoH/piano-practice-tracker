import { TestBed } from '@angular/core/testing';
import { composition, track } from '../../testing/fixtures';
import { type MockApi, mockApi } from '../../testing/mock-api';
import { CompositionStore } from '../../core/composition.store';
import { programKey } from '../../core/gm';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast.service';
import { VaultStore } from '../../core/vault.store';
import { InstrumentPickerComponent } from './instrument-picker.component';

describe('InstrumentPickerComponent', () => {
  let mock: MockApi;
  let i18n: I18nService;
  let store: CompositionStore;

  async function setup() {
    mock = mockApi({
      getComposition: () => Promise.resolve(composition({ tracks: [track({ name: 'Bass', program: 33, sustain: false })] })),
      saveComposition: (d) => Promise.resolve(d),
      getSoundfontPrograms: () => Promise.resolve([0, 32, 33, 40]),
      getSoundfontInfo: () => Promise.resolve({ current_path: '/usr/share/sounds/sf2/FluidR3_GM.sf2', loading: false, candidates: [] }),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    store = TestBed.inject(CompositionStore);
    await store.select('c1');
    store.pickerTrack.set(0);
    const fixture = TestBed.createComponent(InstrumentPickerComponent);
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const programButtons = () => [...el.querySelectorAll<HTMLButtonElement>('li button[aria-pressed]')];
    const button = (key: Parameters<I18nService['t']>[0]) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === i18n.t(key)) as HTMLButtonElement;
    return { fixture, el, programButtons, button };
  }

  it('opens on the family of the current program, with the missing ones disabled', async () => {
    const { el, programButtons } = await setup();
    expect(el.textContent).toContain('FluidR3_GM.sf2');
    expect(el.textContent).toContain(i18n.t(programKey(33)));
    const buttons = programButtons();
    expect(buttons).toHaveLength(8);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false', 'false', 'false', 'false', 'false']);
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, true, true, true, true, true, true]);
    expect(buttons[1].textContent).toContain('034');
  });

  it('searches across families and switches family', async () => {
    const { fixture, el, programButtons } = await setup();
    const search = el.querySelector('#picker-search') as HTMLInputElement;
    search.value = i18n.t(programKey(40)).toLowerCase();
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(programButtons().length).toBeGreaterThanOrEqual(1);
    expect(programButtons()[0].textContent).toContain(i18n.t(programKey(40)));

    search.value = 'zzzz';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(el.textContent).toContain(i18n.t('composer.picker.noMatches'));

    (el.querySelectorAll<HTMLButtonElement>('nav button')[0]).click();
    fixture.detectChanges();
    expect(search.value).toBe('');
    expect(programButtons()[0].textContent).toContain(i18n.t(programKey(0)));
  });

  it('applies the chosen program and pedal to the track', async () => {
    const { fixture, el, programButtons, button } = await setup();
    programButtons()[0].click();
    (el.querySelector('[role=switch]') as HTMLButtonElement).click();
    fixture.detectChanges();
    button('composer.picker.use').click();
    expect(store.doc()!.tracks[0]).toMatchObject({ program: 32, sustain: true });
    expect(store.pickerTrack()).toBeNull();
  });

  it('previews an instrument and reports a failure', async () => {
    const { el } = await setup();
    const previews = [...el.querySelectorAll<HTMLButtonElement>('li button:not([aria-pressed])')];
    previews[0].click();
    await vi.waitFor(() => expect(mock.argsOf('previewInstrument')).toEqual([32]));
    mock.set('previewInstrument', () => Promise.reject('busy'));
    previews[1].click();
    await vi.waitFor(() => expect(TestBed.inject(ToastService).toasts().at(-1)?.kind).toBe('error'));
  });

  it('closes with Escape, the backdrop or Settings', async () => {
    const { fixture, el, button } = await setup();
    el.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(store.pickerTrack()).toBeNull();

    store.pickerTrack.set(0);
    fixture.detectChanges();
    (el.querySelector('.fixed') as HTMLElement).click();
    expect(store.pickerTrack()).toBeNull();

    store.pickerTrack.set(0);
    fixture.detectChanges();
    button('composer.picker.changeInSettings').click();
    expect(TestBed.inject(VaultStore).settingsOpen()).toBe(true);
    expect(store.doc()!.tracks[0].program).toBe(33);
  });
});
