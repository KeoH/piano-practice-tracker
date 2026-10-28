import { TestBed } from '@angular/core/testing';
import { type MockApi, mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import type { SoundfontInfo } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { SoundfontSettingsComponent } from './soundfont-settings.component';

const builtin = { path: '/home/me/.local/share/piano-tracker/assets/default_piano.sf2', name: 'default_piano.sf2', size_bytes: 300 * 1024, is_builtin: true };
const fluid = { path: '/usr/share/sounds/sf2/FluidR3_GM.sf2', name: 'FluidR3_GM.sf2', size_bytes: 148 * 1024 * 1024, is_builtin: false };

describe('SoundfontSettingsComponent', () => {
  let mock: MockApi;
  let i18n: I18nService;

  async function setup(info: SoundfontInfo, fakeTimers = false) {
    mock = mockApi({
      getSoundfontInfo: () => Promise.resolve(info),
      setSoundfont: (path: string) => Promise.resolve({ ...info, current_path: path }),
      pickSoundfontFile: () => Promise.resolve('/home/me/Music/Salamander.sf2'),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    const fixture = TestBed.createComponent(SoundfontSettingsComponent);
    // With fake timers whenStable() would wait for the change detection scheduler forever.
    if (fakeTimers) await vi.advanceTimersByTimeAsync(1);
    else await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const button = (key: Parameters<I18nService['t']>[0]) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(i18n.t(key))) as HTMLButtonElement;
    return { fixture, el, button };
  }

  it('lists the SoundFonts with their size and switches to another one', async () => {
    const { fixture, el } = await setup({ current_path: builtin.path, loading: false, candidates: [builtin, fluid] });
    expect(el.textContent).toContain('FluidR3_GM.sf2');
    expect(el.textContent).toContain('148.0 MB');
    expect(el.textContent).toContain(i18n.t('settings.sound.systemSamples'));
    expect(el.textContent).not.toContain(i18n.t('settings.sound.onlyBuiltinTitle'));

    const radios = [...el.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    radios[0].dispatchEvent(new Event('change')); // already the current one
    radios[1].dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(mock.calls.filter((c) => c.cmd === 'setSoundfont').map((c) => c.args)).toEqual([[fluid.path]]);
    expect(TestBed.inject(ToastService).toasts().at(-1)?.kind).toBe('success');
  });

  it('suggests a GM SoundFont when only the built-in one exists, and picks a file', async () => {
    const { fixture, el, button } = await setup({ current_path: builtin.path, loading: false, candidates: [builtin] });
    expect(el.textContent).toContain(i18n.t('settings.sound.onlyBuiltinTitle'));
    button('settings.sound.pick').click();
    await fixture.whenStable();
    expect(mock.argsOf('setSoundfont')).toEqual(['/home/me/Music/Salamander.sf2']);
    fixture.detectChanges();
    expect(el.textContent).toContain('Salamander.sf2');
  });

  it('polls while the preferred SoundFont is loading', async () => {
    vi.useFakeTimers();
    try {
      const { fixture, el } = await setup({ current_path: fluid.path, loading: true, candidates: [builtin, fluid] }, true);
      expect(el.textContent).toContain(i18n.t('settings.sound.loading'));
      await vi.advanceTimersByTimeAsync(700);
      expect(mock.count('getSoundfontInfo')).toBe(2);
      mock.set('getSoundfontInfo', () => Promise.resolve({ current_path: fluid.path, loading: false, candidates: [builtin, fluid] }));
      await vi.advanceTimersByTimeAsync(700);
      await vi.advanceTimersByTimeAsync(2100);
      expect(mock.count('getSoundfontInfo')).toBe(3);
      fixture.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports failures', async () => {
    const { fixture, button } = await setup({ current_path: builtin.path, loading: false, candidates: [builtin, fluid] });
    mock.set('pickSoundfontFile', () => Promise.reject('no portal'));
    button('settings.sound.pick').click();
    await fixture.whenStable();
    mock.set('pickSoundfontFile', () => Promise.resolve('/bad.sf2'));
    mock.set('setSoundfont', () => Promise.reject('not a SoundFont'));
    button('settings.sound.pick').click();
    await fixture.whenStable();
    expect(TestBed.inject(ToastService).toasts().map((t) => t.kind)).toEqual(['error', 'error']);
  });
});
