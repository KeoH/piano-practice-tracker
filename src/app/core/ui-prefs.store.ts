import { Injectable, signal } from '@angular/core';

/** How a timeline draws the MIDI: notes (piano roll) or note density bars. */
export type TimelineMode = 'roll' | 'activity';

const KEY_TIMELINE_MODE = 'piano-tracker.timelineMode';
const KEY_SIDEBAR_COLLAPSED = 'piano-tracker.sidebarCollapsed';

/**
 * View preferences of this machine (not vault data): kept in `localStorage`, which may be
 * unavailable, so every access is guarded and the defaults apply.
 */
@Injectable({ providedIn: 'root' })
export class UiPrefsStore {
  readonly timelineMode = signal<TimelineMode>(readMode());
  /** The app's side menu shows only its icons, to leave room for the content. */
  readonly sidebarCollapsed = signal(readFlag(KEY_SIDEBAR_COLLAPSED));

  toggleSidebar(): void {
    const next = !this.sidebarCollapsed();
    this.sidebarCollapsed.set(next);
    try {
      localStorage.setItem(KEY_SIDEBAR_COLLAPSED, next ? '1' : '0');
    } catch {
      // Without storage the preference only lasts this session.
    }
  }

  setTimelineMode(mode: TimelineMode): void {
    this.timelineMode.set(mode);
    try {
      localStorage.setItem(KEY_TIMELINE_MODE, mode);
    } catch {
      // Without storage the preference only lasts this session.
    }
  }

  toggleTimelineMode(): void {
    this.setTimelineMode(this.timelineMode() === 'roll' ? 'activity' : 'roll');
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function readMode(): TimelineMode {
  try {
    return localStorage.getItem(KEY_TIMELINE_MODE) === 'activity' ? 'activity' : 'roll';
  } catch {
    return 'roll';
  }
}
