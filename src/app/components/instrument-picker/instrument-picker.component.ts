import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { trackRgb } from '../../core/composition';
import { CompositionStore } from '../../core/composition.store';
import { GM_FAMILY_COUNT, GM_FAMILY_SIZE, familyKey, familyOf, programKey } from '../../core/gm';
import { I18nService } from '../../core/i18n/i18n.service';
import type { MessageKey } from '../../core/i18n/languages';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { PlaybackStore } from '../../core/playback.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { VaultStore } from '../../core/vault.store';
import { IconComponent } from '../icon/icon.component';

interface ProgramRow {
  program: number;
  name: MessageKey;
  /** Family, shown when searching across all of them. */
  family: MessageKey | null;
  available: boolean;
}

/**
 * Chooses the General MIDI instrument of a track: the 16 families and their 8 programs, a search
 * across all of them, a short preview of each one and whether the track plays the recorded
 * sustain pedal. Programs the active SoundFont lacks are disabled.
 */
@Component({
  selector: 'app-instrument-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe],
  template: `
    @if (track(); as t) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" (click)="close()">
        <div
          class="flex h-[min(700px,92vh)] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-ink-800 shadow-2xl shadow-black/60"
          role="dialog"
          aria-modal="true"
          aria-labelledby="picker-title"
          (click)="$event.stopPropagation()"
          (keydown.escape)="close()"
        >
          <div class="flex items-start gap-3 px-5 pt-[18px] pb-3.5">
            <span class="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px]" [style.background]="'rgba(' + rgb() + ', .14)'" [style.color]="'rgb(' + rgb() + ')'">
              <app-icon name="music" [size]="20" />
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
              <h2 id="picker-title" class="truncate text-base font-semibold text-fg-strong">{{ 'composer.picker.title' | t: { name: t.name } }}</h2>
              <span class="text-[12.5px] text-muted">
                {{ 'composer.picker.current' | t }} <span class="text-fg">{{ programKey(t.program) | t }}</span>
              </span>
            </div>
            <button type="button" class="btn btn-ghost btn-icon h-9 w-9" [attr.aria-label]="'composer.picker.close' | t" (click)="close()">
              <app-icon name="close" [size]="18" />
            </button>
          </div>

          <div class="relative px-5 pb-3">
            <app-icon name="search" [size]="16" class="pointer-events-none absolute top-3 left-8 text-faint" />
            <label for="picker-search" class="sr-only">{{ 'composer.picker.search' | t }}</label>
            <input
              #search
              id="picker-search"
              type="search"
              class="field pl-[38px]"
              [placeholder]="'composer.picker.search' | t"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
            />
          </div>

          <div class="flex min-h-0 flex-1 border-y border-line">
            <nav class="flex w-[190px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-ink-850 p-2" [attr.aria-label]="'composer.picker.families' | t">
              @for (f of families; track f.index) {
                @let current = !query() && family() === f.index;
                <button
                  type="button"
                  class="flex h-[34px] w-full shrink-0 items-center justify-between gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors"
                  [class]="current ? 'bg-ink-700 font-semibold text-fg-strong' : 'text-muted hover:bg-ink-750 hover:text-fg'"
                  [attr.aria-current]="current"
                  (click)="pickFamily(f.index)"
                >
                  <span class="truncate">{{ f.key | t }}</span>
                  @if (familyOf(program()) === f.index) {
                    <span class="dot bg-accent"></span>
                  }
                </button>
              }
            </nav>
            <ul class="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-2">
              @for (p of rows(); track p.program) {
                @let chosen = p.program === program();
                <li class="flex items-center gap-1">
                  <button
                    type="button"
                    class="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[9px] border px-2.5 text-left text-[13.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                    [class]="chosen ? 'border-accent/40 bg-accent/12 font-semibold text-fg-strong' : 'border-transparent text-fg-soft hover:bg-ink-750'"
                    [attr.aria-pressed]="chosen"
                    [disabled]="!p.available"
                    [title]="p.available ? '' : ('composer.picker.unavailable' | t)"
                    (click)="program.set(p.program)"
                  >
                    <span class="flex w-4 text-accent">
                      @if (chosen) {
                        <app-icon name="check" [size]="16" />
                      }
                    </span>
                    <span class="min-w-0 flex-1 truncate">
                      {{ p.name | t }}
                      @if (p.family) {
                        <span class="text-xs font-normal text-faint">· {{ p.family | t }}</span>
                      }
                    </span>
                    <span class="tabular text-[11px] text-faint">{{ number(p.program) }}</span>
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon h-10 w-10 hover:text-accent"
                    [disabled]="!p.available || !api.available"
                    [attr.aria-label]="'composer.picker.preview' | t: { name: (p.name | t) }"
                    [title]="'composer.picker.preview' | t: { name: (p.name | t) }"
                    (click)="preview(p.program)"
                  >
                    <app-icon name="play" [size]="15" />
                  </button>
                </li>
              } @empty {
                <li class="px-2.5 py-6 text-center text-[13px] text-faint">{{ 'composer.picker.noMatches' | t }}</li>
              }
            </ul>
          </div>

          <div class="flex flex-col gap-3.5 px-5 pt-3.5 pb-[18px]">
            <div class="flex items-center gap-3">
              <div class="flex flex-1 flex-col gap-0.5">
                <span id="picker-sustain" class="text-[13px] font-semibold text-fg">{{ 'composer.picker.sustain' | t }}</span>
                <span class="text-xs text-faint">{{ 'composer.picker.sustainHint' | t }}</span>
              </div>
              <button type="button" class="switch" role="switch" [attr.aria-checked]="sustain()" aria-labelledby="picker-sustain" (click)="sustain.set(!sustain())"></button>
            </div>
            <div class="flex flex-wrap items-center gap-2.5">
              <span class="min-w-0 flex-1 truncate text-xs text-faint">
                {{ 'composer.picker.soundfont' | t }} <span class="tabular text-muted">{{ soundfontName() }}</span> ·
                <button type="button" class="font-semibold text-accent hover:text-accent-hover" (click)="openSettings()">{{ 'composer.picker.changeInSettings' | t }}</button>
              </span>
              <button type="button" class="btn" (click)="close()">{{ 'common.cancel' | t }}</button>
              <button type="button" class="btn btn-primary" (click)="apply()">{{ 'composer.picker.use' | t }}</button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class InstrumentPickerComponent {
  protected readonly store = inject(CompositionStore);
  protected readonly api = inject(TauriApiService);
  private readonly playback = inject(PlaybackStore);
  private readonly vault = inject(VaultStore);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  protected readonly programKey = programKey;
  protected readonly familyOf = familyOf;
  protected readonly families = Array.from({ length: GM_FAMILY_COUNT }, (_, index) => ({ index, key: familyKey(index) }));

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');
  /** Programs of the active SoundFont (null = unknown: all are offered). */
  private readonly available = signal<Set<number> | null>(null);
  protected readonly soundfontName = signal('');
  protected readonly query = signal('');
  protected readonly family = signal(0);
  protected readonly program = signal(0);
  protected readonly sustain = signal(true);

  protected readonly track = computed(() => {
    const i = this.store.pickerTrack();
    return i === null ? null : (this.store.doc()?.tracks[i] ?? null);
  });
  protected readonly rgb = computed(() => {
    const t = this.track();
    return t ? trackRgb(t) : '233, 180, 76';
  });

  protected readonly rows = computed<ProgramRow[]>(() => {
    const available = this.available();
    const row = (program: number, withFamily: boolean): ProgramRow => ({
      program,
      name: programKey(program),
      family: withFamily ? familyKey(familyOf(program)) : null,
      available: !available || available.has(program),
    });
    const q = this.query().trim().toLowerCase();
    if (q) {
      const out: ProgramRow[] = [];
      for (let p = 0; p < GM_FAMILY_COUNT * GM_FAMILY_SIZE; p++) {
        const name = this.i18n.t(programKey(p)).toLowerCase();
        const fam = this.i18n.t(familyKey(familyOf(p))).toLowerCase();
        if (name.includes(q) || fam.includes(q)) out.push(row(p, true));
      }
      return out;
    }
    const f = this.family();
    return Array.from({ length: GM_FAMILY_SIZE }, (_, i) => row(f * GM_FAMILY_SIZE + i, false));
  });

  constructor() {
    const t = this.track();
    if (t) {
      this.program.set(t.program);
      this.family.set(familyOf(t.program));
      this.sustain.set(t.sustain);
    }
    afterNextRender(() => this.searchInput()?.nativeElement.focus());
    void this.loadSoundfont();
  }

  private async loadSoundfont(): Promise<void> {
    if (!this.api.available) return;
    try {
      const [programs, info] = await Promise.all([this.api.getSoundfontPrograms(), this.api.getSoundfontInfo()]);
      if (programs.length) this.available.set(new Set(programs));
      this.soundfontName.set(info.current_path.split('/').pop() ?? '');
    } catch {
      // Without the list every program is offered; the synthesizer falls back on its own.
    }
  }

  protected number(program: number): string {
    return String(program + 1).padStart(3, '0');
  }

  protected pickFamily(index: number): void {
    this.query.set('');
    this.family.set(index);
  }

  protected async preview(program: number): Promise<void> {
    try {
      if (this.store.playing()) await this.playback.pause();
      await this.api.previewInstrument(program);
    } catch (err) {
      this.toast.error(err, this.i18n.t('composer.picker.previewError'));
    }
  }

  protected apply(): void {
    const index = this.store.pickerTrack();
    if (index !== null) this.store.setInstrument(index, this.program(), this.sustain());
    this.close();
  }

  protected close(): void {
    this.store.pickerTrack.set(null);
  }

  protected openSettings(): void {
    this.close();
    this.vault.settingsOpen.set(true);
  }
}
