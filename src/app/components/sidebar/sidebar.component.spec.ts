import { TestBed } from '@angular/core/testing';
import { pieceSummary, summary, vaultInfo } from '../../testing/fixtures';
import { type MockApi, mockApi } from '../../testing/mock-api';
import { CompositionStore } from '../../core/composition.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { SIMULATOR_PORT_ID } from '../../core/models';
import { NavStore } from '../../core/nav.store';
import { PieceStore } from '../../core/piece.store';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { ToastService } from '../../core/toast.service';
import { VaultStore } from '../../core/vault.store';
import { SidebarComponent } from './sidebar.component';

describe('SidebarComponent', () => {
  let mock: MockApi;
  let i18n: I18nService;

  async function setup() {
    const today = new Date().toISOString();
    mock = mockApi({
      getSessions: () =>
        Promise.resolve([
          summary({ id: 'a', title: 'Today', session_date: today, fragment_count: 2 }),
          summary({ id: 'b', title: 'Long ago', session_date: '2025-03-01T10:00:00' }),
        ]),
      getPieces: () =>
        Promise.resolve([
          pieceSummary({ id: 'p1', title: 'Nocturne', composer: 'Chopin' }, { take_count: 3, last_practiced: today }),
          pieceSummary({ id: 'p2', title: 'Etude', archived: true }),
        ]),
      getCompositions: () =>
        Promise.resolve([{ id: 'c1', title: 'Duet', track_count: 2, clip_count: 4, duration_ms: 64_000, updated_at: today }]),
      getVaultInfo: () => Promise.resolve(vaultInfo()),
      createPiece: (title: string) => Promise.resolve(pieceSummary({ id: 'p9', title }).piece),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    await Promise.all([
      TestBed.inject(SessionStore).refreshList(),
      TestBed.inject(PieceStore).refreshList(),
      TestBed.inject(CompositionStore).refreshList(),
      TestBed.inject(VaultStore).init(),
    ]);
    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const render = () => fixture.detectChanges();
    const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
    return { fixture, el, render, button };
  }

  it('groups the sessions by date and opens one', async () => {
    const { el, button } = await setup();
    const headings = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings[0]).toBe(i18n.t('dates.thisWeek'));
    expect(headings[1]).toBe('March 2025');
    expect(el.textContent).toContain('2 fragments');
    expect(el.textContent).toContain('Vault');

    button('Long ago').click();
    await vi.waitFor(() => expect(TestBed.inject(SessionStore).selectedId()).toBe('b'));
  });

  it('filters the sessions and says when nothing matches', async () => {
    const { el, render } = await setup();
    const search = el.querySelector('#session-filter') as HTMLInputElement;
    search.value = 'zzz';
    search.dispatchEvent(new Event('input'));
    render();
    expect(el.textContent).toContain(i18n.t('sidebar.noMatches'));
  });

  it('does not switch or create sessions while recording another one', async () => {
    const { button } = await setup();
    TestBed.inject(RecordingStore).recordingSessionId.set('a');
    button('Long ago').click();
    button(i18n.t('sidebar.newSession')).click();
    const toasts = TestBed.inject(ToastService).toasts().map((t) => t.message);
    expect(toasts).toEqual([i18n.t('sidebar.stopToSwitch'), i18n.t('sidebar.stopToCreate')]);
    expect(mock.count('createSession')).toBe(0);
  });

  it('switches to the pieces view, with archived pieces apart, and creates one', async () => {
    const { el, render, button } = await setup();
    button(i18n.t('nav.pieces')).click();
    render();
    expect(TestBed.inject(NavStore).view()).toBe('pieces');
    const headings = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toEqual([i18n.t('pieces.activeGroup'), i18n.t('pieces.archivedGroup')]);
    expect(el.textContent).toContain('Chopin');

    button(i18n.t('pieces.new')).click();
    await vi.waitFor(() => expect(TestBed.inject(PieceStore).selectedId()).toBe('p9'));

    const search = el.querySelector('#piece-filter') as HTMLInputElement;
    search.value = 'nothing';
    search.dispatchEvent(new Event('input'));
    render();
    expect(el.textContent).toContain(i18n.t('pieces.noMatches'));
  });

  it('shows the compositions in the compose view', async () => {
    const { el, render, button } = await setup();
    button(i18n.t('nav.compose')).click();
    render();
    expect(el.textContent).toContain('Duet');
    expect(el.textContent).toContain('01:04');
    button('Duet').click();
    await vi.waitFor(() => expect(TestBed.inject(CompositionStore).selectedId()).toBe('c1'));
  });

  it('describes the chosen MIDI port and opens the settings', async () => {
    const { el, render, button } = await setup();
    const rec = TestBed.inject(RecordingStore);
    expect(el.textContent).toContain(i18n.t('sidebar.port.none'));

    rec.ports.set([{ id: SIMULATOR_PORT_ID, name: '', is_virtual: true }, { id: 'midir:P', name: 'Piano', is_virtual: false }]);
    rec.selectedPortId.set(SIMULATOR_PORT_ID);
    render();
    expect(el.textContent).toContain(i18n.t('sidebar.port.virtual'));
    const port = el.querySelector('#midi-port') as HTMLSelectElement;
    port.value = 'midir:P';
    port.dispatchEvent(new Event('change'));
    render();
    expect(el.textContent).toContain(i18n.t('sidebar.port.connected'));
    rec.selectedPortId.set('midir:Gone');
    render();
    expect(el.textContent).toContain(i18n.t('sidebar.port.notFound'));

    button(i18n.t('settings.title')).click();
    expect(TestBed.inject(VaultStore).settingsOpen()).toBe(true);
  });
});
