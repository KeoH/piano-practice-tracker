import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { formatMs } from '../../core/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { TranslatePipe } from '../../core/i18n/translate.pipe';
import { BPM_MAX, BPM_MIN, RecordingStore } from '../../core/recording.store';
import { SessionStore } from '../../core/session.store';
import { TauriApiService } from '../../core/tauri-api.service';
import { IconComponent } from '../icon/icon.component';

/** Recording panel: record/stop button with timer, MIDI input, tempo, metronome and monitoring. */
@Component({
  selector: 'app-recorder-deck',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslatePipe],
  templateUrl: './recorder-deck.component.html',
})
export class RecorderDeckComponent {
  private readonly store = inject(SessionStore);
  protected readonly rec = inject(RecordingStore);
  protected readonly api = inject(TauriApiService);
  private readonly i18n = inject(I18nService);

  protected readonly BPM_MIN = BPM_MIN;
  protected readonly BPM_MAX = BPM_MAX;
  protected readonly formatMs = formatMs;

  protected readonly session = this.store.session;
  protected readonly isThisRecording = computed(
    () => !!this.session() && this.rec.recordingSessionId() === this.session()!.id,
  );
  protected readonly otherRecording = computed(() => this.rec.isRecording() && !this.isThisRecording());
  protected readonly hasRaw = computed(() => !!this.session()?.raw_midi_path);
  protected readonly portStatus = computed(() => {
    const p = this.rec.selectedPort();
    if (!p) return { label: this.i18n.t(this.rec.ports().length ? 'recorder.port.choose' : 'sidebar.port.none'), ok: false };
    if (p.is_virtual) return { label: this.i18n.t('recorder.port.virtual'), ok: false };
    return { label: this.i18n.t('sidebar.port.connected'), ok: true };
  });

  private bpmSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // When the session changes, sync the BPM with the one saved in it
    let lastId: string | null = null;
    effect(() => {
      const s = this.session();
      const id = s?.id ?? null;
      if (id !== lastId) {
        lastId = id;
        untracked(() => this.rec.loadFromSession(s));
      }
    });
  }

  protected onBpmInput(raw: string): void {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < BPM_MIN || v > BPM_MAX) return;
    this.rec.setBpm(v);
    this.scheduleBpmSave();
  }

  protected onBpmCommit(el: HTMLInputElement): void {
    const v = Number(el.value);
    if (Number.isFinite(v)) this.rec.setBpm(v);
    el.value = String(this.rec.bpm());
    this.scheduleBpmSave();
  }

  protected nudgeBpm(delta: number): void {
    this.rec.setBpm(this.rec.bpm() + delta);
    this.scheduleBpmSave();
  }

  private scheduleBpmSave(): void {
    if (this.bpmSaveTimer) clearTimeout(this.bpmSaveTimer);
    this.bpmSaveTimer = setTimeout(() => {
      const s = this.session();
      if (s && s.bpm !== this.rec.bpm()) void this.store.saveFields({ bpm: this.rec.bpm() });
    }, 600);
  }

  protected async toggleRecording(): Promise<void> {
    const s = this.session();
    if (!s) return;
    if (this.isThisRecording()) await this.rec.stopAndRefresh();
    else if (!this.rec.isRecording()) await this.rec.start(s.id);
  }
}
