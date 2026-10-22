import { TestBed } from '@angular/core/testing';
import { composition, libraryFragment } from '../../testing/fixtures';
import { mockApi } from '../../testing/mock-api';
import { CompositionStore } from '../../core/composition.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { NavStore } from '../../core/nav.store';
import { SessionStore } from '../../core/session.store';
import { ClipInspectorComponent } from './clip-inspector.component';

describe('ClipInspectorComponent', () => {
  let store: CompositionStore;
  let i18n: I18nService;

  async function setup() {
    const doc = composition();
    const mock = mockApi({
      getComposition: () => Promise.resolve(doc),
      getLibraryFragments: () => Promise.resolve([libraryFragment({ id: 'f1', session_id: 's7' })]),
      getMidiNotes: () => Promise.reject('no notes'),
      saveComposition: (d) => Promise.resolve(d),
    });
    TestBed.configureTestingModule({ providers: [mock.provider] });
    i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    store = TestBed.inject(CompositionStore);
    await store.select('c1');
    await store.refreshLibrary();
    const fixture = TestBed.createComponent(ClipInspectorComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const click = (label: string) => {
      (el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click();
      fixture.detectChanges();
    };
    return { fixture, el, click };
  }

  it('shows the shortcuts while no clip is selected', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain(i18n.t('composer.inspector.none'));
  });

  it('describes the selected clip and edits its transposition and repeats', async () => {
    const { fixture, el, click } = await setup();
    store.addFragment(libraryFragment({ id: 'f1', title: 'Theme', duration_ms: 4000 }), 0, 0);
    fixture.detectChanges();
    expect(el.textContent).toContain('Theme');
    expect(el.textContent).toContain(i18n.t('composer.inspector.original'));

    click(i18n.t('composer.inspector.semitoneUp'));
    expect(store.selectedClip()?.clip.transpose).toBe(1);
    expect(el.querySelector('output')?.textContent).toContain('+1');
    click(i18n.t('composer.inspector.semitoneDown'));
    click(i18n.t('composer.inspector.semitoneDown'));
    expect(el.querySelector('output')?.textContent).toContain('−1');

    const repeatLess = el.querySelector(`[aria-label="${i18n.t('composer.inspector.repeatLess')}"]`) as HTMLButtonElement;
    expect(repeatLess.disabled).toBe(true);
    click(i18n.t('composer.inspector.repeatMore'));
    expect(store.selectedClip()?.clip.repeats).toBe(2);
    expect(el.textContent).toContain('00:08.0');
  });

  it('splits, duplicates and removes the clip', async () => {
    const { fixture, el } = await setup();
    store.addFragment(libraryFragment({ id: 'f1', duration_ms: 4000 }), 0, 0);
    await store.seek(2000);
    fixture.detectChanges();
    const button = (key: Parameters<I18nService['t']>[0]) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(i18n.t(key))) as HTMLButtonElement;

    button('composer.inspector.split').click();
    expect(store.doc()!.tracks[0].clips).toHaveLength(2);
    fixture.detectChanges();
    button('composer.inspector.duplicate').click();
    expect(store.doc()!.tracks[0].clips).toHaveLength(3);
    fixture.detectChanges();
    button('composer.inspector.remove').click();
    expect(store.doc()!.tracks[0].clips).toHaveLength(2);
  });

  it('opens the session the fragment comes from', async () => {
    const { fixture, el } = await setup();
    store.addFragment(libraryFragment({ id: 'f1' }), 0, 0);
    fixture.detectChanges();
    TestBed.inject(NavStore).view.set('compose');
    ([...el.querySelectorAll('button')].find((b) => b.textContent?.includes(i18n.t('composer.inspector.openSession'))) as HTMLButtonElement).click();
    expect(TestBed.inject(NavStore).view()).toBe('sessions');
    expect(TestBed.inject(SessionStore).tab()).toBe('fragments');
    expect(TestBed.inject(SessionStore).selectedId()).toBe('s7');
  });
});
