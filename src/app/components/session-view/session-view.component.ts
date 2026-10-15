import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { formatMs, plural } from '../../core/format';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore, type SessionTab } from '../../core/session.store';
import { SyncStore } from '../../core/sync.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { FragmentPlayerComponent } from '../fragment-player/fragment-player.component';
import { IconComponent } from '../icon/icon.component';
import { MarkdownEditorComponent } from '../markdown-editor/markdown-editor.component';
import { MidiSlicerComponent } from '../midi-slicer/midi-slicer.component';
import { RecorderDeckComponent } from '../recorder-deck/recorder-deck.component';
import { SessionHeaderComponent } from '../session-header/session-header.component';

const TABS: { id: SessionTab; label: string }[] = [
  { id: 'record', label: 'Grabar y recortar' },
  { id: 'fragments', label: 'Fragmentos' },
  { id: 'notes', label: 'Notas' },
];

/**
 * Área principal: cabecera y pestañas de la sesión (grabar y recortar, fragmentos, notas) o la
 * pantalla de inicio. Las pestañas se ocultan con `hidden` en lugar de destruirse, para conservar
 * la selección del recortador, los fragmentos abiertos y el editor.
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
  ],
  template: `
    @if (store.session(); as s) {
      <div class="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 pt-8 pb-11 xl:px-11">
        <app-session-header />

        <div role="tablist" aria-label="Secciones de la sesión" class="flex gap-1 overflow-x-auto border-b border-line" (keydown)="onTabKey($event)">
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
              {{ t.label }}
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
              <p>Aún no hay pista bruta. Pulsa <span class="font-semibold text-fg">Grabar</span> y toca: después podrás quedarte con los mejores pasajes como fragmentos.</p>
            </div>
          }
        </div>

        <div id="panel-fragments" role="tabpanel" aria-labelledby="tab-fragments" class="flex flex-col gap-5" [hidden]="store.tab() !== 'fragments'">
          @if (store.fragments().length) {
            <p class="text-sm text-muted">
              {{ plural(store.fragments().length, 'fragmento', 'fragmentos') }} ·
              <span class="tabular text-fg">{{ formatMs(fragmentsTotalMs()) }}</span> en total. Abre uno para escucharlo y dejar comentarios en el
              segundo exacto.
            </p>
          }
          <div class="flex flex-col gap-3">
            @for (f of store.fragments(); track f.id; let i = $index) {
              <app-fragment-player [fragment]="f" [index]="i" />
            } @empty {
              <div class="flex flex-col items-start gap-4 rounded-2xl border border-dashed border-line-hover px-6 py-6 text-sm text-muted">
                <p>
                  Sin fragmentos todavía. En <span class="font-semibold text-fg">Grabar y recortar</span>, selecciona un pasaje de la pista bruta y
                  pulsa <span class="font-semibold text-fg">Extraer fragmento</span>.
                </p>
                <button type="button" class="btn" (click)="store.tab.set('record')">
                  <app-icon name="scissors" [size]="16" /> Ir a la pista bruta
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
      <div class="flex h-full items-center justify-center text-sm text-faint">Cargando sesión…</div>
    } @else {
      <div class="flex min-h-full justify-center px-6 py-[clamp(32px,8vh,96px)] xl:px-11">
        <div class="flex w-full max-w-[820px] flex-col gap-9">
          <div class="flex flex-col items-start gap-4">
            <span class="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
              <app-icon name="piano" [size]="30" />
            </span>
            <h1 class="text-[38px] leading-tight font-semibold tracking-tight text-fg-strong">¿Qué vas a practicar hoy?</h1>
            <p class="max-w-[560px] text-base leading-relaxed text-muted">
              Graba con tu teclado USB, quédate con los pasajes que importan y anota lo que quieres mejorar.
            </p>
            <div class="mt-2 flex flex-wrap gap-3">
              <button type="button" class="btn btn-primary h-12 rounded-xl px-5 text-[15px]" (click)="newSession()" [disabled]="!api.available">
                <app-icon name="plus" [size]="18" /> Nueva sesión
              </button>
              @if (lastSession(); as last) {
                <button type="button" class="btn h-12 max-w-full rounded-xl bg-ink-800 px-4 text-[15px]" (click)="store.select(last.id)">
                  <span class="truncate">Seguir con «{{ last.title || 'Sin título' }}»</span>
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
              <h2 class="text-[17px] font-semibold">Graba</h2>
              <p class="text-sm leading-relaxed text-muted">Pulsa Grabar y toca. Puedes parar y seguir: cada toma se añade al final de la pista bruta.</p>
            </li>
            <li class="panel flex flex-col gap-2.5 p-5">
              <span class="flex items-center gap-2.5">
                <span class="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 text-accent"><app-icon name="scissors" [size]="17" /></span>
                <span class="tabular text-xs text-faint">02</span>
              </span>
              <h2 class="text-[17px] font-semibold">Recorta</h2>
              <p class="text-sm leading-relaxed text-muted">Selecciona un pasaje en la pista y guárdalo como fragmento. Lo que sobra, descártalo.</p>
            </li>
            <li class="panel flex flex-col gap-2.5 p-5">
              <span class="flex items-center gap-2.5">
                <span class="flex h-9 w-9 items-center justify-center rounded-full bg-ink-700 text-fg"><app-icon name="comment" [size]="17" /></span>
                <span class="tabular text-xs text-faint">03</span>
              </span>
              <h2 class="text-[17px] font-semibold">Anota</h2>
              <p class="text-sm leading-relaxed text-muted">Deja comentarios en el segundo exacto de cada fragmento y apuntes con imágenes en las notas.</p>
            </li>
          </ol>

          <div class="flex flex-wrap gap-x-6 gap-y-2.5 border-t border-line pt-5 text-[13px] text-muted">
            <span class="inline-flex items-center gap-2">
              <span class="dot" [class]="rec.selectedPort() && !rec.selectedPort()!.is_virtual ? 'bg-ok' : 'bg-faint'"></span>
              {{ rec.selectedPort()?.name ?? 'Sin entrada MIDI' }}
            </span>
            <span class="inline-flex items-center gap-2">
              <span class="dot" [class]="sync.summary().tone === 'ok' ? 'bg-ok' : sync.summary().tone === 'err' ? 'bg-rec' : 'bg-faint'"></span>
              {{ sync.summary().label }}
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
  protected readonly sync = inject(SyncStore);
  protected readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);

  protected readonly tabs = TABS;
  protected readonly formatMs = formatMs;
  protected readonly plural = plural;

  protected readonly fragmentsTotalMs = computed(() =>
    this.store.fragments().reduce((sum, f) => sum + f.duration_ms, 0),
  );
  /** Sesión más reciente, para «Seguir con…» en la pantalla de inicio. */
  protected readonly lastSession = computed(() => {
    const all = this.store.sessions();
    return all.length
      ? [...all].sort((a, b) => (b.session_date || b.updated_at).localeCompare(a.session_date || a.updated_at))[0]
      : null;
  });

  protected newSession(): void {
    if (this.rec.isRecording()) {
      this.toast.warning('Detén la grabación antes de crear otra sesión');
      return;
    }
    void this.store.create();
  }

  /** Flechas izquierda/derecha, Inicio y Fin mueven entre pestañas. */
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
