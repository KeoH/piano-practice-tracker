import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { PieceStore } from '../../core/piece.store';

export interface PieceChoice {
  pieceId: string | null;
  passage: string;
}

const NEW_PIECE = '__new__';

/**
 * Piece + passage of a take: a select with the active pieces (and "New piece…", which creates it
 * inline) and a passage field that suggests the passages already used in that piece.
 */
@Component({
  selector: 'app-piece-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  host: { class: 'flex flex-col gap-3 sm:flex-row' },
  template: `
    <div class="min-w-0 flex-1">
      <label class="label" [for]="uid + '-piece'">{{ 'pieces.picker.piece' | t }}</label>
      @if (creating()) {
        <div class="flex gap-2">
          <input
            [id]="uid + '-piece'"
            class="field min-w-0"
            autofocus
            [placeholder]="'pieces.picker.newPlaceholder' | t"
            [value]="newTitle()"
            (input)="newTitle.set($any($event.target).value)"
            (keydown.enter)="$event.preventDefault(); createPiece()"
            (keydown.escape)="$event.stopPropagation(); creating.set(false)"
          />
          <button type="button" class="btn btn-primary" [disabled]="!newTitle().trim() || busy()" (click)="createPiece()">
            {{ 'pieces.picker.create' | t }}
          </button>
          <button type="button" class="btn btn-ghost" (click)="creating.set(false)">{{ 'common.cancel' | t }}</button>
        </div>
      } @else {
        <select [id]="uid + '-piece'" class="field" (change)="onPiece($any($event.target))">
          <option value="" [selected]="!pieceId()">{{ 'pieces.picker.none' | t }}</option>
          @for (p of options(); track p.piece.id) {
            <option [value]="p.piece.id" [selected]="p.piece.id === pieceId()">
              {{ p.piece.title }}{{ p.piece.composer ? ' · ' + p.piece.composer : '' }}
            </option>
          }
          <option [value]="newPiece">{{ 'pieces.picker.new' | t }}</option>
        </select>
      }
    </div>
    <div class="min-w-0 flex-1">
      <label class="label" [for]="uid + '-passage'">
        {{ 'pieces.picker.passage' | t }} <span class="font-normal text-faint">{{ 'common.optional' | t }}</span>
      </label>
      <input
        [id]="uid + '-passage'"
        class="field"
        [attr.list]="uid + '-passages'"
        [placeholder]="'pieces.picker.passagePlaceholder' | t"
        [disabled]="!pieceId()"
        [value]="passage()"
        (change)="changed.emit({ pieceId: pieceId(), passage: $any($event.target).value.trim() })"
      />
      <datalist [id]="uid + '-passages'">
        @for (p of passages(); track p) {
          <option [value]="p"></option>
        }
      </datalist>
    </div>
  `,
})
export class PiecePickerComponent {
  readonly pieceId = input<string | null>(null);
  readonly passage = input('');
  readonly changed = output<PieceChoice>();

  private readonly store = inject(PieceStore);
  private static nextId = 0;
  protected readonly uid = `piece-picker-${PiecePickerComponent.nextId++}`;
  protected readonly newPiece = NEW_PIECE;
  protected readonly creating = signal(false);
  protected readonly newTitle = signal('');
  protected readonly busy = signal(false);

  /** Active pieces, plus the current one even if it is archived. */
  protected readonly options = computed(() =>
    this.store.pieces().filter((p) => !p.piece.archived || p.piece.id === this.pieceId()),
  );
  protected readonly passages = computed(() => this.store.byId(this.pieceId())?.passages ?? []);

  protected onPiece(select: HTMLSelectElement): void {
    if (select.value === NEW_PIECE) {
      // Back to the current value until the new piece exists.
      select.value = this.pieceId() ?? '';
      this.newTitle.set('');
      this.creating.set(true);
      return;
    }
    const pieceId = select.value || null;
    this.changed.emit({ pieceId, passage: pieceId ? this.passage() : '' });
  }

  protected async createPiece(): Promise<void> {
    const title = this.newTitle().trim();
    if (!title || this.busy()) return;
    this.busy.set(true);
    const piece = await this.store.create(title);
    this.busy.set(false);
    if (!piece) return;
    this.creating.set(false);
    this.changed.emit({ pieceId: piece.id, passage: this.passage() });
  }
}
