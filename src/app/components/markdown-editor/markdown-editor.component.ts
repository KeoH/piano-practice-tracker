import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import type { MessageKey } from '../../core/i18n/languages';
import { PluralPipe, TranslatePipe } from '../../core/i18n/translate.pipe';
import { createMarkdownRenderer, markdownDestination } from '../../core/markdown';
import type { SessionDto } from '../../core/models';
import { SessionStore } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { ToastService } from '../../core/toast.service';
import { VaultStore } from '../../core/vault.store';
import { IconComponent } from '../icon/icon.component';

type EditorMode = 'edit' | 'preview' | 'split';
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const MODE_KEY = 'piano-tracker.md-mode';
const SAVE_DEBOUNCE_MS = 800;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MODES: { id: EditorMode; label: MessageKey }[] = [
  { id: 'edit', label: 'notes.modes.edit' },
  { id: 'split', label: 'notes.modes.split' },
  { id: 'preview', label: 'notes.modes.preview' },
];

/** Editor de notas Markdown de la sesión con autoguardado e imágenes pegadas/arrastradas. */
@Component({
  selector: 'app-markdown-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe, PluralPipe],
  templateUrl: './markdown-editor.component.html',
})
export class MarkdownEditorComponent {
  readonly session = input.required<SessionDto>();

  private readonly api = inject(TauriApiService);
  private readonly store = inject(SessionStore);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  protected readonly modes = MODES;
  protected readonly mode = signal<EditorMode>(readMode());
  protected readonly text = signal('');
  protected readonly saveState = signal<SaveState>('idle');
  protected readonly uploading = signal(0);
  protected readonly dragOver = signal(false);

  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private readonly vault = inject(VaultStore);
  private readonly render = createMarkdownRenderer((p) => this.vault.resolveAsset(p));
  protected readonly html = computed(() => this.render(this.text()));
  protected readonly stats = computed(() => {
    const t = this.text();
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    return { words, chars: t.length };
  });

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSession: SessionDto | null = null;

  constructor() {
    // Cambio de sesión: guarda lo pendiente de la anterior y carga el texto de la nueva
    effect(() => {
      const s = this.session();
      untracked(() => {
        if (this.lastSession && this.lastSession.id !== s.id) this.flushFor(this.lastSession);
        if (!this.lastSession || this.lastSession.id !== s.id) {
          this.text.set(s.markdown_notes ?? '');
          this.saveState.set('idle');
        }
        this.lastSession = s;
      });
    });

    inject(DestroyRef).onDestroy(() => {
      if (this.lastSession) this.flushFor(this.lastSession);
    });
  }

  protected setMode(m: EditorMode): void {
    this.mode.set(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* sin almacenamiento */
    }
  }

  protected onInput(value: string): void {
    this.text.set(value);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.saveState.set('dirty');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    this.saveTimer = null;
    const s = this.session();
    const text = this.text();
    if (text === s.markdown_notes) {
      this.saveState.set('saved');
      return;
    }
    this.saveState.set('saving');
    const ok = await this.store.saveFields({ markdown_notes: text });
    // Si se escribió más mientras guardaba, sigue "sucio"
    if (this.saveTimer) return;
    this.saveState.set(ok ? (this.text() === text ? 'saved' : 'dirty') : 'error');
  }

  /** Guarda inmediatamente el texto pendiente de una sesión que ya no es la actual. */
  private flushFor(prev: SessionDto): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const text = this.text();
    if (text === prev.markdown_notes) return;
    this.api
      .updateSession(prev.id, prev.title, prev.bpm, text)
      .catch((err) => this.toast.error(err, this.i18n.t('notes.errors.save')));
  }

  // ---- Imágenes: paste / drop ----
  protected onPaste(ev: ClipboardEvent): void {
    const items = ev.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    ev.preventDefault();
    void this.insertImages(files, true);
  }

  /** Imágenes elegidas con el botón «Insertar imagen». */
  protected onFilesPicked(input: HTMLInputElement): void {
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    input.value = '';
    if (files.length) void this.insertImages(files, false);
  }

  protected onDragOver(ev: DragEvent): void {
    if (ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      this.dragOver.set(true);
    }
  }

  protected onDrop(ev: DragEvent): void {
    this.dragOver.set(false);
    const files = Array.from(ev.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    ev.preventDefault();
    // Coloca el cursor donde se soltó, si el navegador lo permite
    void this.insertImages(files, false);
  }

  private async insertImages(files: File[], pasted: boolean): Promise<void> {
    if (!this.api.available) {
      this.toast.warning(this.i18n.t('notes.imagesNeedDesktop'));
      return;
    }
    const sessionId = this.session().id;
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) {
        this.toast.warning(this.i18n.t('notes.imageTooLarge', { name: file.name, max: MAX_IMAGE_BYTES / 1024 / 1024 }));
        continue;
      }
      this.uploading.update((n) => n + 1);
      try {
        const base64 = await readAsBase64(file);
        const name = imageFileName(file, pasted);
        // Ruta relativa a la bóveda (`media/…`): las notas siguen valiendo en otro equipo.
        const relPath = await this.api.saveSessionImage(sessionId, name, base64);
        if (this.session().id !== sessionId) continue;
        const alt = name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
        this.insertAtCursor(`![${alt}](${markdownDestination(relPath)})`);
      } catch (err) {
        this.toast.error(err, this.i18n.t('notes.errors.image'));
      } finally {
        this.uploading.update((n) => n - 1);
      }
    }
  }

  private insertAtCursor(snippet: string): void {
    const ta = this.textarea()?.nativeElement;
    const text = this.text();
    const start = ta ? ta.selectionStart : text.length;
    const end = ta ? ta.selectionEnd : text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const trail = after.startsWith('\n') ? '' : '\n';
    const insert = `${lead}${snippet}${trail}`;
    const next = before + insert + after;
    this.text.set(next);
    if (ta) {
      ta.value = next;
      const caret = start + insert.length;
      ta.setSelectionRange(caret, caret);
      ta.focus();
    }
    this.scheduleSave();
  }

  /** Tab inserta dos espacios en lugar de mover el foco (Escape + Tab para salir). */
  protected onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
      const ta = ev.target as HTMLTextAreaElement;
      ev.preventDefault();
      const { selectionStart: s, selectionEnd: e } = ta;
      const next = ta.value.slice(0, s) + '  ' + ta.value.slice(e);
      ta.value = next;
      ta.setSelectionRange(s + 2, s + 2);
      this.onInput(next);
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      if (this.saveTimer) clearTimeout(this.saveTimer);
      void this.save();
    }
  }
}

function readMode(): EditorMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'edit' || m === 'preview' || m === 'split') return m;
  } catch {
    /* sin almacenamiento */
  }
  return 'split';
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error(file.name));
    reader.readAsDataURL(file);
  });
}

function imageFileName(file: File, pasted: boolean): string {
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
  const original = file.name?.trim();
  if (!pasted && original) return original.replace(/[\\/:*?"<>|]/g, '_');
  if (original && !/^image\.\w+$/i.test(original)) return original.replace(/[\\/:*?"<>|]/g, '_');
  return `pasted-${Date.now()}.${ext}`;
}
