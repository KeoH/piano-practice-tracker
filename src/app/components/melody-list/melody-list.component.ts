import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChallengeStore } from '../../core/challenge.store';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import { TauriApiService } from '../../core/tauri-api.service';
import { IconComponent } from '../icon/icon.component';

/** Sidebar body of the Challenges view: import button and the melody list. */
@Component({
  selector: 'app-melody-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe, PluralPipe],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="flex flex-col gap-2.5 px-4 pb-4">
      <button type="button" class="btn btn-primary btn-lg w-full" (click)="store.importMidi()" [disabled]="!api.available || store.isRunning()">
        <app-icon name="upload" [size]="18" /> {{ 'challenge.import' | t }}
      </button>
      <button type="button" class="btn btn-ghost w-full" (click)="store.addStarters()" [disabled]="!api.available || store.isRunning()">
        <app-icon name="music" [size]="16" /> {{ 'challenge.starters.add' | t }}
      </button>
    </div>
    <nav class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-3" [attr.aria-label]="'challenge.listLabel' | t">
      <h2 class="px-2.5 pb-1.5 text-xs font-semibold text-faint">{{ 'challenge.listTitle' | t }}</h2>
      @if (store.listLoading() && !store.melodies().length) {
        <p class="px-2.5 py-4 text-[13px] text-faint">{{ 'common.loading' | t }}</p>
      }
      <ul class="flex flex-col gap-0.5">
        @for (s of store.melodies(); track s.melody.id) {
          @let active = store.selectedId() === s.melody.id;
          <li>
            <button
              type="button"
              class="flex min-h-[52px] w-full items-center gap-2.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors"
              [class]="active ? 'border-line-hover bg-ink-700' : 'border-transparent hover:bg-ink-800'"
              [attr.aria-current]="active ? 'page' : null"
              (click)="store.select(s.melody.id)"
            >
              <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span class="truncate text-sm font-medium" [class]="active ? 'text-fg-strong' : 'text-fg-soft'">{{ s.melody.title || ('common.untitled' | t) }}</span>
                <span class="flex gap-1.5 text-xs whitespace-nowrap text-faint">
                  <span>{{ 'challenge.attemptCount' | tp: s.attempt_count }}</span>
                  <span aria-hidden="true">·</span>
                  <span class="tabular text-[11.5px]">{{ formatMs(s.melody.duration_ms) }}</span>
                </span>
              </span>
              @if (s.best_score !== null) {
                <span class="tabular flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent" [title]="'challenge.bestScore' | t">
                  <app-icon name="trophy" [size]="12" />{{ s.best_score }}
                </span>
              }
            </button>
          </li>
        } @empty {
          @if (!store.listLoading()) {
            <li class="px-2.5 py-6 text-center text-[13px] leading-relaxed text-faint">{{ 'challenge.listEmpty' | t }}</li>
          }
        }
      </ul>
    </nav>
  `,
})
export class MelodyListComponent {
  protected readonly store = inject(ChallengeStore);
  protected readonly api = inject(TauriApiService);
  protected readonly i18n = inject(I18nService);
  protected readonly formatMs = formatMs;
}
