import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { UiPrefsStore } from '../../core/ui-prefs.store';
import { TimelineModeToggleComponent } from './timeline-mode-toggle.component';

describe('TimelineModeToggleComponent', () => {
  afterEach(() => localStorage.clear());

  it('switches between the piano roll and the density bars', () => {
    const i18n = TestBed.inject(I18nService);
    i18n.setLang('en');
    const prefs = TestBed.inject(UiPrefsStore);
    prefs.setTimelineMode('roll');
    const fixture = TestBed.createComponent(TimelineModeToggleComponent);
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    expect(button.getAttribute('aria-label')).toBe(i18n.t('timeline.showActivity'));

    button.click();
    fixture.detectChanges();
    expect(prefs.timelineMode()).toBe('activity');
    expect(button.getAttribute('aria-label')).toBe(i18n.t('timeline.showRoll'));
  });
});
