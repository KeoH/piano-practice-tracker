import { TestBed } from '@angular/core/testing';
import { detail, session } from '../../testing/fixtures';
import { type MockApi, flush, mockApi } from '../../testing/mock-api';
import { ConfirmService } from '../../core/confirm.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { ToastService } from '../../core/toast.service';
import { SessionHeaderComponent } from './session-header.component';

describe('SessionHeaderComponent', () => {
  let mock: MockApi;
  let store: SessionStore;
  let i18n: I18nService;

  function setup() {
    mock = mockApi({ countCompositionUses: () => Promise.resolve(2), getSessions: () => Promise.resolve([]) });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    store = TestBed.inject(SessionStore);
    store.selectedId.set('s1');
    store.detail.set(detail({ session: session({ title: 'Monday', raw_duration_ms: 125_000 }) }));
    const fixture = TestBed.createComponent(SessionHeaderComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    return { fixture, el, title: () => el.querySelector('#session-title') as HTMLInputElement };
  }

  it('shows the title, the take length and the save state', () => {
    const { fixture, el, title } = setup();
    expect(title().value).toBe('Monday');
    expect(el.textContent).toContain('02:05');
    expect(el.textContent).toContain(i18n.t('header.saved'));
    store.savingCount.set(1);
    fixture.detectChanges();
    expect(el.textContent).toContain(i18n.t('header.saving'));
  });

  it('renames on Enter, ignores an empty title and restores it on Escape', async () => {
    const { fixture, title } = setup();
    const type = (text: string, key: string) => {
      title().value = text;
      title().dispatchEvent(new Event('input'));
      fixture.detectChanges();
      title().dispatchEvent(new KeyboardEvent('keydown', { key }));
      fixture.detectChanges();
    };
    type('Tuesday', 'Enter');
    await flush();
    expect(mock.argsOf('updateSession')).toEqual(['s1', 'Tuesday', 90, '']);

    type('   ', 'Enter');
    expect(title().value).toBe('Tuesday');
    type('Draft', 'Escape');
    expect(title().value).toBe('Tuesday');
    expect(mock.count('updateSession')).toBe(1);
  });

  it('deletes the session after confirming, mentioning the compositions that use it', async () => {
    const { fixture, el } = setup();
    (el.querySelector('[aria-haspopup=menu]') as HTMLButtonElement).click();
    fixture.detectChanges();
    (el.querySelector('[role=menuitem]') as HTMLButtonElement).click();
    await flush();
    const confirm = TestBed.inject(ConfirmService);
    expect(confirm.current()?.message).toContain(i18n.plural('composer.usedIn', 2));
    confirm.answer(true);
    await vi.waitFor(() => expect(mock.argsOf('deleteSession')).toEqual(['s1']));
  });

  it('closes the menu on an outside click and refuses to delete while recording', async () => {
    const { fixture, el } = setup();
    const menuButton = el.querySelector('[aria-haspopup=menu]') as HTMLButtonElement;
    menuButton.click();
    fixture.detectChanges();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('[role=menu]')).toBeNull();

    TestBed.inject(RecordingStore).recordingSessionId.set('s1');
    menuButton.click();
    fixture.detectChanges();
    expect(el.textContent).toContain(i18n.t('header.recording'));
    (el.querySelector('[role=menuitem]') as HTMLButtonElement).click();
    await flush();
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message).toBe(i18n.t('header.stopToDelete'));
    expect(TestBed.inject(ConfirmService).current()).toBeNull();
  });
});
