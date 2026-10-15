import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ConfirmService } from '../../core/confirm.service';
import { formatLongDate, formatMs, plural } from '../../core/format';
import { RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { SyncStore } from '../../core/sync.store';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../icon/icon.component';

/** Cabecera de sesión: título editable, fecha, resumen (pista, fragmentos, copia) y menú de acciones. */
@Component({
  selector: 'app-session-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  templateUrl: './session-header.component.html',
  host: { '(document:pointerdown)': 'onDocumentPointer($event)' },
})
export class SessionHeaderComponent {
  protected readonly store = inject(SessionStore);
  protected readonly rec = inject(RecordingStore);
  private readonly sync = inject(SyncStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);

  protected readonly formatMs = formatMs;
  protected readonly formatLongDate = formatLongDate;
  protected readonly plural = plural;

  protected readonly session = this.store.session;
  protected readonly titleDraft = signal('');
  protected readonly menuOpen = signal(false);
  protected readonly isThisRecording = computed(
    () => !!this.session() && this.rec.recordingSessionId() === this.session()!.id,
  );

  /** Estado de guardado / copia en Drive de la sesión. */
  protected readonly syncChip = computed(() => {
    const s = this.session();
    if (this.store.savingCount() > 0) return { label: 'Guardando…', dot: 'bg-accent animate-pulse' };
    switch (s ? this.sync.cloudState(s.sync_status) : 'OFFLINE') {
      case 'SYNCED':
        return { label: 'Guardado en Drive', dot: 'bg-ok' };
      case 'PENDING':
        return { label: 'Pendiente de subir', dot: 'bg-accent' };
      case 'ERROR':
        return { label: 'Error al subir', dot: 'bg-rec' };
      default:
        return { label: 'Solo en este equipo', dot: 'bg-faint' };
    }
  });

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
      this.toast.warning('Detén la grabación antes de borrar la sesión');
      return;
    }
    const ok = await this.confirm.ask({
      title: 'Borrar sesión',
      message: `Se borrará «${s.title}» junto con su pista bruta, fragmentos, comentarios e imágenes.\nEsta acción no se puede deshacer.`,
      confirmLabel: 'Borrar sesión',
    });
    if (ok) await this.store.remove(s.id);
  }
}
