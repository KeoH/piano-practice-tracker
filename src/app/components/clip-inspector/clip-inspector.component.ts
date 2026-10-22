import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MAX_REPEATS, MAX_TRANSPOSE, clipEnd, maxRepeats, trackRgb } from '../../core/composition';
import { CompositionStore } from '../../core/composition.store';
import { formatMs } from '../../core/format';
import { programKey } from '../../core/gm';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { NavStore } from '../../core/nav.store';
import { SessionStore } from '../../core/session.store';
import { IconComponent } from '../icon/icon.component';

/** Details of the selected clip: where it is, its window, transposition and repeats, and actions. */
@Component({
  selector: 'app-clip-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe],
  host: { class: 'flex flex-col gap-3 panel px-4 py-3.5' },
  template: `
    @if (view(); as v) {
      <div class="flex items-start gap-2.5">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="text-xs font-semibold text-faint">{{ 'composer.inspector.title' | t }}</span>
          <span class="truncate text-base font-semibold text-fg-strong">{{ v.clip.fragment_title }}</span>
          <span class="flex items-center gap-1.5 text-[12.5px] text-muted">
            <span class="dot" [style.background]="'rgb(' + v.rgb + ')'"></span>
            <span class="truncate">{{ 'composer.inspector.track' | t: { track: v.trackName, instrument: (v.program | t) } }}</span>
          </span>
        </div>
        @if (v.sessionId) {
          <button type="button" class="btn btn-link h-8 px-1.5 text-[12.5px]" (click)="openSession(v.sessionId)">
            {{ 'composer.inspector.openSession' | t }} <app-icon name="external" [size]="13" />
          </button>
        }
      </div>

      <dl class="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <div>
          <dt class="label text-xs">{{ 'composer.inspector.start' | t }}</dt>
          <dd class="value">{{ formatMs(v.clip.start_ms, true) }}</dd>
        </div>
        <div>
          <dt class="label text-xs">{{ 'composer.inspector.length' | t }}</dt>
          <dd class="value">{{ formatMs(v.total, true) }}</dd>
        </div>
        <div>
          <dt class="label text-xs">{{ 'composer.inspector.trimStart' | t }}</dt>
          <dd class="value">{{ formatMs(v.clip.trim_start_ms, true) }}</dd>
        </div>
        <div>
          <dt class="label text-xs">{{ 'composer.inspector.trimEnd' | t }}</dt>
          <dd class="value">
            {{ 'composer.inspector.ofTotal' | t: { end: formatMs(v.clip.trim_start_ms + v.clip.length_ms, true), total: formatMs(v.clip.fragment_duration_ms, true) } }}
          </dd>
        </div>
        <div>
          <span class="label text-xs" id="transpose-label">{{ 'composer.inspector.transpose' | t }}</span>
          <div class="flex items-center gap-1.5" role="group" aria-labelledby="transpose-label">
            <button type="button" class="btn btn-icon h-[34px] w-[34px]" [disabled]="v.clip.transpose <= -maxTranspose" [attr.aria-label]="'composer.inspector.semitoneDown' | t" (click)="store.transposeBy(-1)">
              <app-icon name="minus" [size]="15" />
            </button>
            <output class="value flex-1 justify-center" aria-live="polite">{{ transposeLabel() }}</output>
            <button type="button" class="btn btn-icon h-[34px] w-[34px]" [disabled]="v.clip.transpose >= maxTranspose" [attr.aria-label]="'composer.inspector.semitoneUp' | t" (click)="store.transposeBy(1)">
              <app-icon name="plus" [size]="15" />
            </button>
          </div>
        </div>
        <div>
          <span class="label text-xs" id="repeats-label">{{ 'composer.inspector.repeats' | t }}</span>
          <div class="flex items-center gap-1.5" role="group" aria-labelledby="repeats-label">
            <button type="button" class="btn btn-icon h-[34px] w-[34px]" [disabled]="v.clip.repeats <= 1" [attr.aria-label]="'composer.inspector.repeatLess' | t" (click)="store.setRepeats(v.clip.repeats - 1)">
              <app-icon name="minus" [size]="15" />
            </button>
            <output class="value flex-1 justify-center" aria-live="polite">×{{ v.clip.repeats }}</output>
            <button type="button" class="btn btn-icon h-[34px] w-[34px]" [disabled]="v.clip.repeats >= v.maxRepeats" [attr.aria-label]="'composer.inspector.repeatMore' | t" (click)="store.setRepeats(v.clip.repeats + 1)">
              <app-icon name="plus" [size]="15" />
            </button>
          </div>
        </div>
      </dl>

      <div class="mt-auto flex flex-wrap gap-2">
        <button type="button" class="btn" (click)="store.splitSelected()" [title]="'composer.inspector.splitHint' | t">
          <app-icon name="scissors" [size]="15" /> {{ 'composer.inspector.split' | t }}
        </button>
        <button type="button" class="btn" (click)="store.duplicateSelected()"><app-icon name="copy" [size]="15" /> {{ 'composer.inspector.duplicate' | t }}</button>
        <button type="button" class="btn btn-danger ml-auto" (click)="store.removeSelected()"><app-icon name="trash" [size]="15" /> {{ 'composer.inspector.remove' | t }}</button>
      </div>
    } @else {
      <span class="text-xs font-semibold text-faint">{{ 'composer.inspector.title' | t }}</span>
      <p class="text-[13px] leading-relaxed text-muted">{{ 'composer.inspector.none' | t }}</p>
      <ul class="mt-auto flex flex-col gap-1.5 text-[12.5px] text-faint">
        <li><span class="kbd">S</span> {{ 'composer.shortcuts.split' | t }}</li>
        <li><span class="kbd">Ctrl D</span> {{ 'composer.shortcuts.duplicate' | t }}</li>
        <li><span class="kbd">Alt</span> {{ 'composer.shortcuts.copyDrag' | t }}</li>
      </ul>
    }
  `,
})
export class ClipInspectorComponent {
  protected readonly store = inject(CompositionStore);
  private readonly i18n = inject(I18nService);
  private readonly nav = inject(NavStore);
  private readonly sessions = inject(SessionStore);
  protected readonly formatMs = formatMs;
  protected readonly maxTranspose = MAX_TRANSPOSE;

  protected readonly view = computed(() => {
    const ref = this.store.selectedClip();
    const d = this.store.doc();
    if (!ref || !d) return null;
    const track = d.tracks[ref.track];
    return {
      clip: ref.clip,
      rgb: trackRgb(track),
      trackName: track.name,
      program: programKey(track.program),
      total: clipEnd(ref.clip) - ref.clip.start_ms,
      maxRepeats: Math.min(MAX_REPEATS, maxRepeats(ref.clip, this.store.spanOf(ref.clip.id))),
      sessionId: this.store.library().find((f) => f.id === ref.clip.fragment_id)?.session_id ?? null,
    };
  });

  protected readonly transposeLabel = computed(() => {
    const t = this.view()?.clip.transpose ?? 0;
    if (t === 0) return this.i18n.t('composer.inspector.original');
    return this.i18n.plural('composer.inspector.semitones', Math.abs(t), { sign: t > 0 ? '+' : '−' });
  });

  protected openSession(sessionId: string): void {
    this.nav.view.set('sessions');
    this.sessions.tab.set('fragments');
    void this.sessions.select(sessionId);
  }
}
