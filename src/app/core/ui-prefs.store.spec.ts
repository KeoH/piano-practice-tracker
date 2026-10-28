import { TestBed } from '@angular/core/testing';
import { UiPrefsStore } from './ui-prefs.store';

describe('UiPrefsStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('remembers the timeline mode', () => {
    localStorage.setItem('piano-tracker.timelineMode', 'activity');
    const prefs = TestBed.inject(UiPrefsStore);
    expect(prefs.timelineMode()).toBe('activity');
    prefs.toggleTimelineMode();
    expect(prefs.timelineMode()).toBe('roll');
    expect(localStorage.getItem('piano-tracker.timelineMode')).toBe('roll');
  });

  it('falls back to the piano roll without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const prefs = TestBed.inject(UiPrefsStore);
    expect(prefs.timelineMode()).toBe('roll');
    prefs.setTimelineMode('activity');
    expect(prefs.timelineMode()).toBe('activity');
  });
});
