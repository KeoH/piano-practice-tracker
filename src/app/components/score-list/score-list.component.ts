import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import { ScoreStore } from '../../core/score.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { IconComponent } from '../icon/icon.component';

/** Sidebar body of the Scores view: new button, search and the list of scores. */
@Component({
  selector: 'app-score-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe, PluralPipe],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="flex flex-col gap-2.5 px-4 pb-4">
      <button type="button" class="btn btn-primary btn-lg w-full" (click)="store.create()" [disabled]="!api.available">
        <app-icon name="plus" [size]="18" /> {{ 'score.new' | t }}
      </button>
      <div class="relative">
        <app-icon name="search" [size]="16" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
        <label for="score-filter" class="sr-only">{{ 'score.searchLabel' | t }}</label>
        <input
          id="score-filter"
          type="search"
          class="field bg-ink-850 pl-9"
          [placeholder]="'score.searchLabel' | t"
          [value]="store.filter()"
          (input)="store.filter.set($any($event.target).value)"
        />
      </div>
    </div>
    <nav class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-3" [attr.aria-label]="'score.listLabel' | t">
      <ul class="flex flex-col gap-0.5">
        @for (s of store.filteredScores(); track s.id) {
          @let active = store.selectedId() === s.id;
          <li>
            <button
              type="button"
              class="flex min-h-[52px] w-full items-center gap-2.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors"
              [class]="active ? 'border-line-hover bg-ink-700' : 'border-transparent hover:bg-ink-800'"
              [attr.aria-current]="active ? 'page' : null"
              (click)="store.select(s.id)"
            >
              <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span class="truncate text-sm font-medium" [class]="active ? 'text-fg-strong' : 'text-fg-soft'">{{ s.title || ('common.untitled' | t) }}</span>
                <span class="truncate text-xs whitespace-nowrap text-faint">
                  {{ 'score.listMeta' | t: { bpm: s.bpm, bars: ('score.bars' | tp: s.bars), notes: ('score.notes' | tp: s.note_count) } }}
                </span>
              </span>
            </button>
          </li>
        } @empty {
          @if (!store.listLoading()) {
            <li class="px-2.5 py-6 text-center text-[13px] leading-relaxed text-faint">
              {{ (store.filter() ? 'score.noMatches' : 'score.noScores') | t }}
            </li>
          }
        }
      </ul>
    </nav>
  `,
})
export class ScoreListComponent {
  protected readonly store = inject(ScoreStore);
  protected readonly api = inject(TauriApiService);
}
