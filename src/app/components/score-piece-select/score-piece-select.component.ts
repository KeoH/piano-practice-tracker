import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { NavStore } from '../../core/nav.store';
import { PieceStore } from '../../core/piece.store';
import { ScoreStore } from '../../core/score.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { IconComponent } from '../icon/icon.component';

const NEW_PIECE = '__new__';

/**
 * "Add to repertoire" for a score: a select with the pieces (an archived one only when it is the
 * current one), "not in the repertoire", and "new piece from this score", which creates a piece named
 * after the score in one step. The link is its own call: the editor's autosave never writes it.
 */
@Component({
  selector: 'app-score-piece-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe],
  host: { class: 'flex items-center gap-1.5' },
  template: `
    <label class="text-xs font-semibold text-faint" [for]="uid">{{ 'score.piece.label' | t }}</label>
    <select [id]="uid" class="field h-9 w-auto max-w-[220px] py-0 text-[13px]" [disabled]="!api.available" (change)="onChange($any($event.target))">
      <option value="" [selected]="!pieceId()">{{ 'score.piece.none' | t }}</option>
      @for (p of options(); track p.piece.id) {
        <option [value]="p.piece.id" [selected]="p.piece.id === pieceId()">{{ p.piece.title }}</option>
      }
      <option [value]="newPiece">{{ 'score.piece.new' | t }}</option>
    </select>
    @if (pieceId()) {
      <button type="button" class="btn btn-ghost btn-icon h-9 w-9" (click)="openPiece()" [attr.aria-label]="'score.piece.open' | t" [title]="'score.piece.open' | t">
        <app-icon name="arrow-right" [size]="16" />
      </button>
    }
  `,
})
export class ScorePieceSelectComponent {
  readonly scoreId = input.required<string>();

  protected readonly api = inject(TauriApiService);
  private readonly scores = inject(ScoreStore);
  private readonly pieces = inject(PieceStore);
  private readonly nav = inject(NavStore);

  protected readonly uid = `score-piece-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly newPiece = NEW_PIECE;

  protected readonly pieceId = computed(() => this.scores.scores().find((s) => s.id === this.scoreId())?.piece_id ?? null);
  protected readonly options = computed(() =>
    this.pieces.pieces().filter((p) => !p.piece.archived || p.piece.id === this.pieceId()),
  );

  protected onChange(select: HTMLSelectElement): void {
    const value = select.value;
    // The select shows what is stored; the stores update it when the call is done.
    select.value = this.pieceId() ?? '';
    if (value === NEW_PIECE) void this.scores.addToRepertoire(this.scoreId());
    else void this.scores.assignPiece(this.scoreId(), value || null);
  }

  protected openPiece(): void {
    const id = this.pieceId();
    if (!id) return;
    this.nav.view.set('pieces');
    void this.pieces.select(id);
  }
}
