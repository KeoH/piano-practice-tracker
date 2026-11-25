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
  host: { class: 'flex min-h-0 flex-1 flex-col', '(keydown.escape)': 'store.picking() && store.setPicking(false)' },
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
      @if (!store.picking()) {
        <button type="button" class="btn w-full" (click)="store.setPicking(true)" [disabled]="!api.available || !store.scores().length" [title]="'score.pickHint' | t">
          <app-icon name="download" [size]="15" /> {{ 'score.pick' | t }}
        </button>
      }
    </div>
    <nav class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-3" [attr.aria-label]="'score.listLabel' | t">
      <ul class="flex flex-col gap-0.5">
        @for (s of store.filteredScores(); track s.id) {
          @let active = store.selectedId() === s.id;
          <li>
            @let pos = store.pickedPosition(s.id);
            <button
              type="button"
              class="flex min-h-[52px] w-full items-center gap-2.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors disabled:opacity-50"
              [class]="(store.picking() ? pos > 0 : active) ? 'border-line-hover bg-ink-700' : 'border-transparent hover:bg-ink-800'"
              [attr.aria-current]="!store.picking() && active ? 'page' : null"
              [attr.aria-pressed]="store.picking() ? pos > 0 : null"
              [disabled]="store.picking() && !s.note_count && !pos"
              (click)="store.picking() ? store.togglePicked(s.id) : store.select(s.id)"
            >
              @if (store.picking()) {
                <span
                  class="tabular flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-semibold"
                  [class]="pos > 0 ? 'border-accent bg-accent text-on-accent' : 'border-line-strong text-transparent'"
                  aria-hidden="true"
                >
                  {{ pos > 0 ? pos : '·' }}
                </span>
              }
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
    @if (store.picking()) {
      <div class="flex flex-col gap-2 border-t border-line px-4 py-3">
        <p class="text-xs text-faint">{{ 'score.pickInfo' | t }}</p>
        <button type="button" class="btn btn-primary w-full" [disabled]="!store.picked().length || store.exportingPicked()" (click)="store.exportPicked()">
          <app-icon name="download" [size]="15" />
          @if (store.exportingPicked()) {
            {{ 'export.exporting' | t }}
          } @else {
            {{ 'score.pickExport' | tp: store.picked().length }}
          }
        </button>
        <button type="button" class="btn btn-ghost w-full" (click)="store.setPicking(false)">{{ 'score.pickCancel' | t }}</button>
      </div>
    }
  `,
})
export class ScoreListComponent {
  protected readonly store = inject(ScoreStore);
  protected readonly api = inject(TauriApiService);
}
