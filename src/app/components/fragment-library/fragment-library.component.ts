import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { CompositionStore } from '../../core/composition.store';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import type { LibraryFragmentDto } from '../../core/models';
import { ClipRollComponent } from '../clip-roll/clip-roll.component';
import { IconComponent } from '../icon/icon.component';

/** Brass accent, for the fragments' mini piano rolls. */
const ACCENT_RGB = '233, 180, 76';
const DRAG_THRESHOLD_PX = 4;
/** Piece filter value for the fragments without a piece. */
const NO_PIECE = '__none__';

interface LibraryGroup {
  title: string | null;
  items: LibraryFragmentDto[];
}

/**
 * Every recorded fragment of the vault, grouped by piece. A fragment is dragged onto the
 * timeline (the timeline places it) or, with a click or Enter, added at the playhead on the
 * active track.
 */
@Component({
  selector: 'app-fragment-library',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, ClipRollComponent, TranslatePipe, PluralPipe],
  host: {
    class: 'flex flex-col gap-2.5 panel p-3.5',
    '(window:pointermove)': 'pointerMove($event)',
    '(window:pointerup)': 'pointerUp()',
    '(window:pointercancel)': 'pointerUp()',
  },
  template: `
    <div class="flex flex-wrap items-center gap-2.5">
      <h2 class="text-sm font-semibold text-fg-strong">{{ 'composer.library.title' | t }}</h2>
      <span class="text-xs text-faint">{{ 'composer.library.hint' | t }}</span>
      <div class="ml-auto flex flex-wrap gap-2">
        <div class="relative w-[220px]">
          <app-icon name="search" [size]="15" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <label for="library-filter" class="sr-only">{{ 'composer.library.search' | t }}</label>
          <input
            id="library-filter"
            type="search"
            class="field h-9 pl-9"
            [placeholder]="'composer.library.search' | t"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>
        <label for="library-piece" class="sr-only">{{ 'composer.library.pieceFilter' | t }}</label>
        <select id="library-piece" class="field h-9 w-auto py-0" (change)="piece.set($any($event.target).value)">
          <option value="" [selected]="piece() === ''">{{ 'composer.library.allPieces' | t }}</option>
          @for (p of pieces(); track p.id) {
            <option [value]="p.id" [selected]="piece() === p.id">{{ p.title }}</option>
          }
          <option [value]="NO_PIECE" [selected]="piece() === NO_PIECE">{{ 'composer.library.noPiece' | t }}</option>
        </select>
      </div>
    </div>

    <div class="-mx-1 flex max-h-[246px] min-h-[120px] flex-col gap-2.5 overflow-y-auto px-1">
      @for (g of groups(); track g.title) {
        <section>
          <h3 class="flex items-baseline gap-2 px-2.5 pb-1 text-xs font-semibold text-faint">
            {{ g.title ?? ('composer.library.noPiece' | t) }}
            <span class="font-normal">{{ 'composer.library.count' | tp: g.items.length }}</span>
          </h3>
          <ul class="flex flex-col">
            @for (f of g.items; track f.id) {
              @let used = store.uses().get(f.id) ?? 0;
              <li>
                <button
                  type="button"
                  class="grid w-full cursor-grab touch-none grid-cols-[16px_72px_minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] border border-transparent px-2.5 py-2 text-left transition-colors select-none hover:border-line-strong hover:bg-ink-750"
                  [attr.aria-label]="'composer.library.add' | t: { title: f.title, duration: formatMs(f.duration_ms) }"
                  [title]="'composer.library.addHint' | t"
                  (pointerdown)="pointerDown($event, f)"
                  (click)="click(f)"
                >
                  <app-icon name="grip" [size]="16" class="text-faint" />
                  <app-clip-roll
                    class="relative h-[26px] rounded-md bg-ink-925"
                    [notes]="store.notes()[f.file_path] ?? null"
                    [length]="f.duration_ms"
                    [rgb]="accent"
                  />
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate text-[13px] font-medium text-fg">{{ f.title }}</span>
                    <span class="truncate text-xs text-faint">{{ f.passage || f.session_title }} · {{ i18n.shortDate(f.session_date) }}</span>
                  </span>
                  <span class="flex items-center gap-2">
                    @if (used) {
                      <span class="inline-flex h-[22px] items-center rounded-full border border-line-strong px-2 text-[11.5px] text-muted">
                        {{ 'composer.library.used' | tp: used }}
                      </span>
                    }
                    <span class="tabular text-xs text-fg-soft">{{ formatMs(f.duration_ms) }}</span>
                  </span>
                </button>
              </li>
            }
          </ul>
        </section>
      } @empty {
        <p class="px-2.5 py-6 text-center text-[13px] text-faint">
          @if (store.libraryLoading()) {
            {{ 'common.loading' | t }}
          } @else {
            {{ (store.library().length ? 'composer.library.noMatches' : 'composer.library.empty') | t }}
          }
        </p>
      }
    </div>
  `,
})
export class FragmentLibraryComponent {
  protected readonly store = inject(CompositionStore);
  protected readonly i18n = inject(I18nService);
  protected readonly formatMs = formatMs;
  protected readonly accent = ACCENT_RGB;
  protected readonly NO_PIECE = NO_PIECE;

  protected readonly query = signal('');
  /** Piece id, `NO_PIECE` or '' (all). */
  protected readonly piece = signal('');
  private press: { pointerId: number; x0: number; y0: number; fragment: LibraryFragmentDto } | null = null;
  /** A drag just ended on a row: its click must not add the fragment again. */
  private suppressClick = false;

  protected readonly pieces = computed(() => {
    const seen = new Map<string, string>();
    for (const f of this.store.library()) if (f.piece_id && f.piece_title) seen.set(f.piece_id, f.piece_title);
    return [...seen].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title));
  });

  private readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const piece = this.piece();
    return this.store.library().filter((f) => {
      if (piece === NO_PIECE ? f.piece_id !== null : piece && f.piece_id !== piece) return false;
      if (!q) return true;
      return [f.title, f.passage, f.session_title, f.piece_title ?? ''].some((s) => s.toLowerCase().includes(q));
    });
  });

  /** Pieces alphabetically, the fragments without a piece last. */
  protected readonly groups = computed<LibraryGroup[]>(() => {
    const byPiece = new Map<string | null, LibraryFragmentDto[]>();
    for (const f of this.filtered()) {
      const key = f.piece_title ?? null;
      byPiece.set(key, [...(byPiece.get(key) ?? []), f]);
    }
    return [...byPiece]
      .map(([title, items]) => ({ title, items }))
      .sort((a, b) => (a.title === null ? 1 : b.title === null ? -1 : a.title.localeCompare(b.title)));
  });

  constructor() {
    effect(() => {
      const files = this.filtered().map((f) => f.file_path);
      untracked(() => files.forEach((f) => this.store.ensureNotes(f)));
    });
  }

  protected pointerDown(ev: PointerEvent, fragment: LibraryFragmentDto): void {
    if (ev.button !== 0) return;
    this.press = { pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, fragment };
  }

  protected pointerMove(ev: PointerEvent): void {
    const p = this.press;
    if (!p || p.pointerId !== ev.pointerId || this.store.libraryDrag()) return;
    if (Math.hypot(ev.clientX - p.x0, ev.clientY - p.y0) < DRAG_THRESHOLD_PX) return;
    this.store.libraryDrag.set(p.fragment);
    this.suppressClick = true;
  }

  /** The timeline drops the fragment; here the press just ends. */
  protected pointerUp(): void {
    this.press = null;
    // The click (if the drag ended on the same row) comes right after; later ones count again.
    if (this.suppressClick) setTimeout(() => (this.suppressClick = false));
  }

  protected click(fragment: LibraryFragmentDto): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.store.addAtPlayhead(fragment);
  }
}
