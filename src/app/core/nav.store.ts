import { Injectable, signal } from '@angular/core';

/** Top-level views of the main area. */
export type AppView = 'sessions' | 'pieces' | 'compose' | 'stats';

@Injectable({ providedIn: 'root' })
export class NavStore {
  readonly view = signal<AppView>('sessions');
}
