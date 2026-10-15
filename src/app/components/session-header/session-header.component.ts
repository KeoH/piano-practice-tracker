import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ConfirmService } from '../../core/confirm.service';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';

/** Cabecera de sesión: título editable, fecha, resumen (pista, fragmentos, guardado) y menú de acciones. */
@Component({
  selector: 'app-session-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe, PluralPipe],
  templateUrl: './session-header.component.html',
  host: { '(document:pointerdown)': 'onDocumentPointer($event)' },
})
export class SessionHeaderComponent {
  protected readonly store = inject(SessionStore);
  protected readonly rec = inject(RecordingStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly formatMs = formatMs;

  protected readonly session = this.store.session;
  protected readonly titleDraft = signal('');
  protected readonly menuOpen = signal(false);
  protected readonly isThisRecording = computed(
    () => !!this.session() && this.rec.recordingSessionId() === this.session()!.id,
  );

  /** Estado de guardado de la sesión en la bóveda. */
  protected readonly saveChip = computed(() =>
    this.store.savingCount() > 0
      ? { label: this.i18n.t('header.saving'), dot: 'bg-accent animate-pulse' }
      : { label: this.i18n.t('header.saved'), dot: 'bg-ok' },
  );

  private readonly menuWrap = viewChild<ElementRef<HTMLElement>>('menuWrap');
  private readonly firstItem = viewChild<ElementRef<HTMLButtonElement>>('firstItem');

  constructor() {
    // Al cambiar de sesión: reinicia el borrador del título y cierra el menú
    let lastId: string | null = null;
    effect(() => {
      const s = this.session();
      const id = s?.id ?? null;
      if (id !== lastId) {
        lastId = id;
        untracked(() => {
          this.titleDraft.set(s?.title ?? '');
          this.menuOpen.set(false);
        });
      }
    });

    // Lleva el foco a la primera opción al abrir el menú
    effect(() => {
      const item = this.firstItem();
      if (item) queueMicrotask(() => item.nativeElement.focus());
    });
  }

  protected onDocumentPointer(ev: PointerEvent): void {
    if (!this.menuOpen()) return;
    const wrap = this.menuWrap()?.nativeElement;
    if (wrap && !wrap.contains(ev.target as Node)) this.menuOpen.set(false);
  }

  protected commitTitle(input?: HTMLInputElement): void {
    const s = this.session();
    if (!s) return;
    const t = this.titleDraft().trim();
    if (!t) {
      this.titleDraft.set(s.title);
      return;
    }
    if (t !== s.title) void this.store.saveFields({ title: t });
    input?.blur();
  }

  protected cancelTitle(input: HTMLInputElement): void {
    this.titleDraft.set(this.session()?.title ?? '');
    input.blur();
  }

  protected async deleteSession(): Promise<void> {
    this.menuOpen.set(false);
    const s = this.session();
    if (!s) return;
    if (this.isThisRecording()) {
      this.toast.warning(this.i18n.t('header.stopToDelete'));
      return;
    }
    const ok = await this.confirm.ask({
      title: this.i18n.t('header.deleteTitle'),
      message: this.i18n.t('header.deleteMessage', { title: s.title }),
      confirmLabel: this.i18n.t('header.deleteTitle'),
    });
    if (ok) await this.store.remove(s.id);
  }
}
