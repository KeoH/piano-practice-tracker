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

  it('remembers that the side menu is collapsed', () => {
    expect(TestBed.inject(UiPrefsStore).sidebarCollapsed()).toBe(false);
    TestBed.resetTestingModule();
    const prefs = TestBed.inject(UiPrefsStore);
    prefs.toggleSidebar();
    expect(prefs.sidebarCollapsed()).toBe(true);
    expect(localStorage.getItem('piano-tracker.sidebarCollapsed')).toBe('1');
    TestBed.resetTestingModule();
    expect(TestBed.inject(UiPrefsStore).sidebarCollapsed()).toBe(true); // a new session starts collapsed
    TestBed.inject(UiPrefsStore).toggleSidebar();
    expect(localStorage.getItem('piano-tracker.sidebarCollapsed')).toBe('0');
  });

  it('collapses the side menu for this session even without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const prefs = TestBed.inject(UiPrefsStore);
    expect(prefs.sidebarCollapsed()).toBe(false);
    prefs.toggleSidebar();
    expect(prefs.sidebarCollapsed()).toBe(true);
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
