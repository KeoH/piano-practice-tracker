import { TestBed } from '@angular/core/testing';
import { mockApi } from '../../testing/mock-api';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../core/toast.service';
import { AboutSettingsComponent } from './about-settings.component';

describe('AboutSettingsComponent', () => {
  it('shows the app info and opens its links', async () => {
    const mock = mockApi({
      getAppInfo: () =>
        Promise.resolve({
          name: 'piano-tracker',
          version: '0.3.0',
          authors: ['Jane Doe'],
          license: 'MIT',
          homepage: 'https://example.com',
          repository: 'https://example.com/repo',
          tauri_version: '2.9.0',
        }),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    TestBed.inject(I18nService).setLang('en');
    const fixture = TestBed.createComponent(AboutSettingsComponent);
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('0.3.0');
    expect(el.textContent).toContain('Jane Doe');
    expect(el.textContent).toContain('MIT');

    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
    buttons.forEach((b) => b.click());
    await fixture.whenStable();
    expect(mock.calls.filter((c) => c.cmd === 'openAppLink').map((c) => c.args[0])).toEqual(['homepage', 'repository', 'license']);

    mock.set('openAppLink', () => Promise.reject('no browser'));
    buttons[0].click();
    await fixture.whenStable();
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message).toContain('no browser');
  });
});
