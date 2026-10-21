import { Injectable, signal } from '@angular/core';

/** How a timeline draws the MIDI: notes (piano roll) or note density bars. */
export type TimelineMode = 'roll' | 'activity';

const KEY_TIMELINE_MODE = 'piano-tracker.timelineMode';

/**
 * View preferences of this machine (not vault data): kept in `localStorage`, which may be
 * unavailable, so every access is guarded and the defaults apply.
 */
@Injectable({ providedIn: 'root' })
export class UiPrefsStore {
  readonly timelineMode = signal<TimelineMode>(readMode());

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

function readMode(): TimelineMode {
  try {
    return localStorage.getItem(KEY_TIMELINE_MODE) === 'activity' ? 'activity' : 'roll';
  } catch {
    return 'roll';
  }
}
