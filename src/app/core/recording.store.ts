import { Injectable, computed, inject, signal } from '@angular/core';
import { clamp } from './format';
import { SIMULATOR_PORT_ID, type MidiPortInfo, type SessionDto } from './models';
import { PlaybackStore } from './playback.store';
import { SessionStore } from './session.store';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

const PORT_KEY = 'piano-tracker.port';

export const BPM_MIN = 40;
export const BPM_MAX = 240;

/** Estado de grabación, puerto MIDI, BPM y toggles de metrónomo/sintetizador en vivo. */
@Injectable({ providedIn: 'root' })
export class RecordingStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly playback = inject(PlaybackStore);
  private readonly sessions = inject(SessionStore);

  readonly ports = signal<MidiPortInfo[]>([]);
  readonly portsLoading = signal(false);
  readonly selectedPortId = signal<string>(readStored(PORT_KEY) ?? SIMULATOR_PORT_ID);

  readonly bpm = signal(120);
  readonly metronomeOn = signal(false);
  readonly liveSynthOn = signal(false);

  /** Sesión que se está grabando (null = no se graba). */
  readonly recordingSessionId = signal<string | null>(null);
  readonly busy = signal(false);
  readonly elapsedMs = signal(0);
  readonly isRecording = computed(() => this.recordingSessionId() !== null);

  readonly selectedPort = computed(
    () => this.ports().find((p) => p.id === this.selectedPortId()) ?? null,
  );

  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;

  async refreshPorts(): Promise<void> {
    if (!this.api.available) {
      this.ports.set([{ id: SIMULATOR_PORT_ID, name: 'Simulador MIDI', is_virtual: true }]);
      return;
    }
    this.portsLoading.set(true);
    try {
      const ports = await this.api.listMidiPorts();
      this.ports.set(ports);
      if (!ports.some((p) => p.id === this.selectedPortId())) {
        const fallback = ports.find((p) => !p.is_virtual) ?? ports[0];
        if (fallback) this.selectPort(fallback.id);
      }
    } catch (err) {
      this.toast.error(err, 'No se pudieron listar los puertos MIDI');
    } finally {
      this.portsLoading.set(false);
    }
  }

  selectPort(id: string): void {
    this.selectedPortId.set(id);
    writeStored(PORT_KEY, id);
  }

  /** Sincroniza el BPM con la sesión seleccionada (si no se está grabando). */
  loadFromSession(s: SessionDto | null): void {
    if (s && !this.isRecording()) this.setBpm(s.bpm);
  }

  setBpm(v: number): void {
    if (!Number.isFinite(v)) return;
    const next = clamp(Math.round(v), BPM_MIN, BPM_MAX);
    if (next === this.bpm()) return;
    this.bpm.set(next);
    this.pushLiveSettings(true);
  }

  toggleMetronome(): void {
    this.metronomeOn.update((v) => !v);
    this.pushLiveSettings(false);
  }

  toggleLiveSynth(): void {
    this.liveSynthOn.update((v) => !v);
    this.pushLiveSettings(false);
  }

  /** Envía `update_live_recording_settings` (también sin grabar: metrónomo de previsualización). */
  private pushLiveSettings(debounce: boolean): void {
    if (!this.api.available) return;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    const send = () => {
      this.liveTimer = null;
      this.api
        .updateLiveRecordingSettings(this.bpm(), this.metronomeOn(), this.liveSynthOn())
        .catch((err) => this.toast.error(err, 'No se pudieron aplicar los ajustes'));
    };
    if (debounce) this.liveTimer = setTimeout(send, 150);
    else send();
  }

  async start(sessionId: string): Promise<boolean> {
    if (this.isRecording() || this.busy()) return false;
    this.busy.set(true);
    try {
      await this.playback.stop();
      await this.api.startRecording(
        sessionId,
        this.selectedPortId(),
        this.bpm(),
        this.metronomeOn(),
        this.liveSynthOn(),
      );
      this.recordingSessionId.set(sessionId);
      this.startedAt = performance.now();
      this.elapsedMs.set(0);
      this.timer = setInterval(() => this.elapsedMs.set(performance.now() - this.startedAt), 100);
      return true;
    } catch (err) {
      this.toast.error(err, 'No se pudo iniciar la grabación');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async stop(): Promise<SessionDto | null> {
    const sessionId = this.recordingSessionId();
    if (!sessionId || this.busy()) return null;
    this.busy.set(true);
    try {
      const s = await this.api.stopRecording(sessionId);
      this.clearTimer();
      this.recordingSessionId.set(null);
      return s;
    } catch (err) {
      this.toast.error(err, 'No se pudo detener la grabación');
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  /** Detiene la grabación y recarga la sesión con la pista bruta ampliada. */
  async stopAndRefresh(): Promise<void> {
    const updated = await this.stop();
    if (!updated) return;
    this.sessions.applySession(updated);
    await this.sessions.reloadDetail();
    void this.sessions.refreshList();
    this.toast.success('Grabación guardada');
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* almacenamiento no disponible */
  }
}
