import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { formatMs } from '../../core/format';
import type { MessageKey } from '../../core/i18n/languages';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore, type SessionTab } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { VaultStore } from '../../core/vault.store';
import { FragmentPlayerComponent } from '../fragment-player/fragment-player.component';
import { IconComponent } from '../icon/icon.component';
import { MarkdownEditorComponent } from '../markdown-editor/markdown-editor.component';
import { MidiSlicerComponent } from '../midi-slicer/midi-slicer.component';
import { RecorderDeckComponent } from '../recorder-deck/recorder-deck.component';
import { RichTextComponent } from '../rich-text/rich-text.component';
import { SessionHeaderComponent } from '../session-header/session-header.component';

const TABS: { id: SessionTab; label: MessageKey }[] = [
  { id: 'record', label: 'session.tabs.record' },
  { id: 'fragments', label: 'session.tabs.fragments' },
  { id: 'notes', label: 'session.tabs.notes' },
];

/**
 * Main area: the session header and tabs (record & trim, fragments, notes) or the home screen.
 * Tabs are hidden with `hidden` instead of being destroyed, to keep the slicer's selection, the
 * open fragments and the editor.
 */
@Component({
  selector: 'app-session-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IconComponent,
    SessionHeaderComponent,
    RecorderDeckComponent,
    MidiSlicerComponent,
    FragmentPlayerComponent,
    MarkdownEditorComponent,
    RichTextComponent,
    TranslatePipe,
    PluralPipe,
  ],
  template: `
    @if (store.session(); as s) {
      <div class="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 pt-8 pb-11 xl:px-11">
        <app-session-header />

        <div role="tablist" [attr.aria-label]="'session.tabs.label' | t" class="flex gap-1 overflow-x-auto border-b border-line" (keydown)="onTabKey($event)">
          @for (t of tabs; track t.id) {
            @let active = store.tab() === t.id;
            <button
              type="button"
              role="tab"
              [id]="'tab-' + t.id"
              [attr.aria-selected]="active"
              [attr.aria-controls]="'panel-' + t.id"
              [tabIndex]="active ? 0 : -1"
              class="-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3.5 text-sm whitespace-nowrap transition-colors"
              [class]="active ? 'border-accent font-semibold text-fg-strong' : 'border-transparent font-medium text-muted hover:text-fg'"
              (click)="store.tab.set(t.id)"
            >
              {{ t.label | t }}
              @if (t.id === 'fragments') {
                <span
                  class="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs"
                  [class]="active ? 'bg-accent/15 text-accent' : 'bg-ink-700 text-fg-soft'"
                >{{ store.fragments().length }}</span>
              }
            </button>
          }
        </div>

        <div id="panel-record" role="tabpanel" aria-labelledby="tab-record" class="flex flex-col gap-6" [hidden]="store.tab() !== 'record'">
          <app-recorder-deck />
          @if (s.raw_midi_path) {
            <app-midi-slicer [session]="s" [fragmentCount]="store.fragments().length" />
          } @else {
            <div class="flex items-center gap-4 rounded-2xl border border-dashed border-line-hover px-6 py-5 text-sm text-muted">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rec/15"><span class="dot h-3 w-3 bg-rec"></span></span>
              <p><app-rich-text [text]="'session.noRawTake' | t" /></p>
            </div>
          }
        </div>

        <div id="panel-fragments" role="tabpanel" aria-labelledby="tab-fragments" class="flex flex-col gap-5" [hidden]="store.tab() !== 'fragments'">
          @if (store.fragments().length) {
            <p class="text-sm text-muted">
              {{ 'session.fragmentCount' | tp: store.fragments().length }} ·
              <span class="tabular text-fg">{{ formatMs(fragmentsTotalMs()) }}</span> {{ 'session.fragmentsTotal' | t }}
            </p>
          }
          <div class="flex flex-col gap-3">
            @for (f of store.fragments(); track f.id; let i = $index) {
              <app-fragment-player [fragment]="f" [index]="i" />
            } @empty {
              <div class="flex flex-col items-start gap-4 rounded-2xl border border-dashed border-line-hover px-6 py-6 text-sm text-muted">
                <p><app-rich-text [text]="'session.noFragments' | t" /></p>
                <button type="button" class="btn" (click)="store.tab.set('record')">
                  <app-icon name="scissors" [size]="16" /> {{ 'session.goToRawTake' | t }}
                </button>
              </div>
            }
          </div>
        </div>

        <div id="panel-notes" role="tabpanel" aria-labelledby="tab-notes" [hidden]="store.tab() !== 'notes'">
          <app-markdown-editor [session]="s" />
        </div>
      </div>
    } @else if (store.detailLoading()) {
      <div class="flex h-full items-center justify-center text-sm text-faint">{{ 'session.loading' | t }}</div>
    } @else {
      <div class="flex min-h-full justify-center px-6 py-[clamp(32px,8vh,96px)] xl:px-11">
        <div class="flex w-full max-w-[820px] flex-col gap-9">
          <div class="flex flex-col items-start gap-4">
            <span class="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
              <app-icon name="piano" [size]="30" />
            </span>
            <h1 class="text-[38px] leading-tight font-semibold tracking-tight text-fg-strong">{{ 'home.title' | t }}</h1>
            <p class="max-w-[560px] text-base leading-relaxed text-muted">
              {{ 'home.subtitle' | t }}
            </p>
            <div class="mt-2 flex flex-wrap gap-3">
              <button type="button" class="btn btn-primary h-12 rounded-xl px-5 text-[15px]" (click)="newSession()" [disabled]="!api.available">
                <app-icon name="plus" [size]="18" /> {{ 'sidebar.newSession' | t }}
              </button>
              @if (lastSession(); as last) {
                <button type="button" class="btn h-12 max-w-full rounded-xl bg-ink-800 px-4 text-[15px]" (click)="store.select(last.id)">
                  <span class="truncate">{{ 'home.continue' | t: { title: last.title || ('common.untitled' | t) } }}</span>
                  <app-icon name="arrow-right" [size]="16" />
                </button>
              }
            </div>
          </div>

          <ol class="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            <li class="panel flex flex-col gap-2.5 p-5">
              <span class="flex items-center gap-2.5">
                <span class="flex h-9 w-9 items-center justify-center rounded-full bg-rec/15"><span class="dot h-3 w-3 bg-rec"></span></span>
                <span class="tabular text-xs text-faint">01</span>
              </span>
              <h2 class="text-[17px] font-semibold">{{ 'home.steps.record.title' | t }}</h2>
              <p class="text-sm leading-relaxed text-muted">{{ 'home.steps.record.text' | t }}</p>
            </li>
            <li class="panel flex flex-col gap-2.5 p-5">
              <span class="flex items-center gap-2.5">
                <span class="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 text-accent"><app-icon name="scissors" [size]="17" /></span>
                <span class="tabular text-xs text-faint">02</span>
              </span>
              <h2 class="text-[17px] font-semibold">{{ 'home.steps.trim.title' | t }}</h2>
              <p class="text-sm leading-relaxed text-muted">{{ 'home.steps.trim.text' | t }}</p>
            </li>
            <li class="panel flex flex-col gap-2.5 p-5">
              <span class="flex items-center gap-2.5">
                <span class="flex h-9 w-9 items-center justify-center rounded-full bg-ink-700 text-fg"><app-icon name="comment" [size]="17" /></span>
                <span class="tabular text-xs text-faint">03</span>
              </span>
              <h2 class="text-[17px] font-semibold">{{ 'home.steps.annotate.title' | t }}</h2>
              <p class="text-sm leading-relaxed text-muted">{{ 'home.steps.annotate.text' | t }}</p>
            </li>
          </ol>

          <div class="flex flex-wrap gap-x-6 gap-y-2.5 border-t border-line pt-5 text-[13px] text-muted">
            <span class="inline-flex items-center gap-2">
              <span class="dot" [class]="rec.selectedPort() && !rec.selectedPort()!.is_virtual ? 'bg-ok' : 'bg-faint'"></span>
              {{ rec.selectedPort() ? rec.portName(rec.selectedPort()!) : ('home.noMidiInput' | t) }}
            </span>
            <span class="inline-flex min-w-0 items-center gap-2" [title]="vault.root() ?? ''">
              <app-icon name="folder" [size]="15" class="text-faint" />
              <span class="truncate">{{ vault.name() ? ('home.vaultName' | t: { name: vault.name()! }) : ('sidebar.noVault' | t) }}</span>
            </span>
          </div>
        </div>
      </div>
    }
  `,
  host: { class: 'block h-full' },
})
export class SessionViewComponent {
  protected readonly store = inject(SessionStore);
  protected readonly rec = inject(RecordingStore);
  protected readonly vault = inject(VaultStore);
  protected readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  protected readonly tabs = TABS;
  protected readonly formatMs = formatMs;

  protected readonly fragmentsTotalMs = computed(() =>
    this.store.fragments().reduce((sum, f) => sum + f.duration_ms, 0),
  );
  /** Most recent session, for "Continue with…" on the home screen. */
  protected readonly lastSession = computed(() => {
    const all = this.store.sessions();
    return all.length
      ? [...all].sort((a, b) => (b.session_date || b.updated_at).localeCompare(a.session_date || a.updated_at))[0]
      : null;
  });

  protected newSession(): void {
    if (this.rec.isRecording()) {
      this.toast.warning(this.i18n.t('sidebar.stopToCreate'));
      return;
    }
    void this.store.create();
  }

  /** Left/right arrows, Home and End move between tabs. */
  protected onTabKey(ev: KeyboardEvent): void {
    const i = TABS.findIndex((t) => t.id === this.store.tab());
    let next = i;
    if (ev.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (ev.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = TABS.length - 1;
    else return;
    ev.preventDefault();
    this.store.tab.set(TABS[next].id);
    document.getElementById(`tab-${TABS[next].id}`)?.focus();
  }
}
