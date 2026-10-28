import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { bestAttempt, clampTempo, effectiveBpm, hitsUpTo } from './challenge-stats';
import { ConfirmService } from './confirm.service';
import { I18nService } from './i18n/i18n.service';
import type {
  AttemptDto,
  ChallengeFinished,
  ChallengeNoteEvent,
  ChallengeNoteKind,
  ChallengeProgress,
  ChallengeStarted,
  FragmentDto,
  MelodyDetailDto,
  MelodyDto,
  MelodySummaryDto,
  NoteStatus,
} from './models';
import { PlaybackStore } from './playback.store';
import { RecordingStore } from './recording.store';
import { TauriApiService } from './tauri-api.service';
import { ToastService } from './toast.service';

export type ChallengePhase = 'idle' | 'countin' | 'playing' | 'result';

/** A played note that hit nothing (drawn as a mark on the piano roll). */
export interface PlayedMark {
  time_ms: number;
  key: number;
  kind: ChallengeNoteKind;
}

const TEMPO_KEY = 'piano-tracker.challenge-tempo';
/** The local clock is corrected when it drifts this much from the backend's. */
const CLOCK_TOLERANCE_MS = 25;

/**
 * Challenge mode: melody library, the selected melody with its attempts, and the attempt in
 * progress (count-in, live note states, ghost of the record and the result).
 */
@Injectable({ providedIn: 'root' })
export class ChallengeStore {
  private readonly api = inject(TauriApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly confirm = inject(ConfirmService);
  private readonly playback = inject(PlaybackStore);
  private readonly recording = inject(RecordingStore);

  readonly melodies = signal<MelodySummaryDto[]>([]);
  readonly listLoading = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly detail = signal<MelodyDetailDto | null>(null);
  readonly detailLoading = signal(false);

  readonly tempoPct = signal(100);
  readonly metronomeOn = signal(true);
  readonly guideOn = signal(false);
  readonly liveSynthOn = signal(false);

  readonly phase = signal<ChallengePhase>('idle');
  readonly busy = signal(false);
  /** The attempt in progress (or the last one, while its result is shown). */
  readonly run = signal<ChallengeStarted | null>(null);
  readonly noteStates = signal<(NoteStatus | null)[]>([]);
  readonly marks = signal<PlayedMark[]>([]);
  readonly progress = signal<ChallengeProgress | null>(null);
  readonly result = signal<AttemptDto | null>(null);
  /** Record at the attempt's tempo when it started (the ghost). */
  readonly rival = signal<AttemptDto | null>(null);
  /** Attempt before the current one. */
  readonly previous = signal<AttemptDto | null>(null);

  readonly melody = computed<MelodyDto | null>(() => this.detail()?.melody ?? null);
  readonly notes = computed(() => this.detail()?.notes ?? []);
  readonly attempts = computed(() => this.detail()?.attempts ?? []);
  readonly isRunning = computed(() => this.phase() === 'countin' || this.phase() === 'playing');
  /** Best completed attempt at the chosen tempo. */
  readonly record = computed(() => bestAttempt(this.attempts(), this.tempoPct()));
  readonly bpm = computed(() => effectiveBpm(this.melody()?.bpm ?? 120, this.tempoPct()));
  readonly isNewRecord = computed(() => {
    const r = this.result();
    if (!r?.summary.completed) return false;
    const rival = this.rival();
    return !rival || r.summary.score > rival.summary.score;
  });

  /**
   * Notes hit now minus those the record had hit at the same moment. Only notes whose window has
   * closed are compared, so it does not flicker while a note can still be played.
   */
  readonly ghostDelta = computed<number | null>(() => {
    const rival = this.rival();
    const p = this.progress();
    const run = this.run();
    if (!rival || !p || !run) return null;
    const at = p.elapsed_ms - run.window_ms;
    if (at < 0) return 0;
    const mine = hitsUpTo(this.notes(), this.noteStates(), run.tempo_pct, at);
    const theirs = hitsUpTo(this.notes(), rival.details.notes.map((n) => n.status), rival.summary.tempo_pct, at);
    return mine - theirs;
  });

  private startedAt = 0;
  private detailRequest = 0;
  private listening = false;
  /**
   * The user's playback speed while "Listen" plays the melody at the challenge tempo (the speed
   * is global in the backend); restored as soon as that preview stops.
   */
  private savedRate: number | null = null;

  constructor() {
    effect(() => {
      const m = this.melody();
      const playing = !!m && this.playback.isPlaying(m.file_path);
      if (!playing && this.savedRate !== null) untracked(() => void this.restoreRate());
    });
  }

  async init(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await Promise.all([
      this.api.onChallengeNote((e) => this.onNote(e)),
      this.api.onChallengeProgress((p) => this.onProgress(p)),
      this.api.onChallengeFinished((f) => void this.onFinished(f)),
    ]);
  }

  /** Attempt timeline for the piano roll (ms; negative during the count-in). */
  clock(): number {
    const run = this.run();
    if (!run) return 0;
    return performance.now() - this.startedAt - run.count_in_ms - run.latency_comp_ms;
  }

  /** Clears everything (when switching vaults). */
  reset(): void {
    this.detailRequest++;
    this.melodies.set([]);
    this.selectedId.set(null);
    this.detail.set(null);
    this.clearAttempt();
  }

  async refreshList(): Promise<void> {
    if (!this.api.available) return;
    this.listLoading.set(true);
    try {
      this.melodies.set(await this.api.getMelodies());
    } catch (err) {
      this.toast.error(err, this.i18n.t('challenge.errors.loadList'));
    } finally {
      this.listLoading.set(false);
    }
  }

  async select(id: string | null): Promise<void> {
    if (this.isRunning()) {
      this.toast.warning(this.i18n.t('challenge.stopFirst'));
      return;
    }
    if (id === this.selectedId() && this.detail()) return;
    this.selectedId.set(id);
    this.detail.set(null);
    this.clearAttempt();
    if (id) {
      this.tempoPct.set(readTempos()[id] ?? 100);
      await this.reloadDetail();
    }
  }

  async reloadDetail(): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    const request = ++this.detailRequest;
    this.detailLoading.set(true);
    try {
      const d = await this.api.getMelodyDetail(id);
      if (request === this.detailRequest) this.detail.set(d);
    } catch (err) {
      if (request === this.detailRequest) this.toast.error(err, this.i18n.t('challenge.errors.loadDetail'));
    } finally {
      if (request === this.detailRequest) this.detailLoading.set(false);
    }
  }

  setTempo(pct: number): void {
    if (this.isRunning() || !Number.isFinite(pct)) return;
    const next = clampTempo(pct);
    this.tempoPct.set(next);
    const id = this.selectedId();
    if (id) writeTempos({ ...readTempos(), [id]: next });
  }

  // ---- Library ----

  async importMidi(): Promise<void> {
    try {
      const path = await this.api.pickMidiFile();
      if (!path) return;
      const m = await this.api.importMelody(path);
      await this.refreshList();
      await this.select(m.id);
      this.toast.success(this.i18n.t('challenge.imported', { title: m.title }));
    } catch (err) {
      this.toast.error(err, this.i18n.t('challenge.errors.import'));
    }
  }

  /** Adds the starter melodies that are missing (they are added on their own to a new vault). */
  async addStarters(): Promise<void> {
    try {
      const added = await this.api.addStarterMelodies();
      await this.refreshList();
      if (added.length) {
        this.toast.success(this.i18n.plural('challenge.starters.added', added.length));
        if (!this.selectedId()) await this.select(added[0].id);
      } else {
        this.toast.info(this.i18n.t('challenge.starters.none'));
      }
    } catch (err) {
      this.toast.error(err, this.i18n.t('challenge.errors.starters'));
    }
  }

  /** Turns a fragment into a challenge; returns the new melody. */
  async createFromFragment(f: FragmentDto): Promise<MelodyDto | null> {
    try {
      const m = await this.api.createMelodyFromFragment(f.id);
      await this.refreshList();
      this.toast.success(this.i18n.t('challenge.created', { title: m.title }));
      return m;
    } catch (err) {
      this.toast.error(err, this.i18n.t('challenge.errors.create'));
      return null;
    }
  }

  async rename(title: string): Promise<void> {
    const m = this.melody();
    const t = title.trim();
    if (!m || !t || t === m.title) return;
    try {
      const updated = await this.api.renameMelody(m.id, t);
      this.detail.update((d) => (d ? { ...d, melody: updated } : d));
      this.melodies.update((list) => list.map((s) => (s.melody.id === updated.id ? { ...s, melody: updated } : s)));
    } catch (err) {
      this.toast.error(err, this.i18n.t('challenge.errors.rename'));
    }
  }

  async removeMelody(): Promise<void> {
    const m = this.melody();
    if (!m || this.isRunning()) return;
    const ok = await this.confirm.ask({
      title: this.i18n.t('challenge.delete'),
      message: this.i18n.plural('challenge.deleteMessage', this.attempts().length, { title: m.title }),
      confirmLabel: this.i18n.t('challenge.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.playback.stopIfActive(m.file_path);
      await this.api.deleteMelody(m.id);
      this.selectedId.set(null);
      this.detail.set(null);
      this.clearAttempt();
      await this.refreshList();
      this.toast.success(this.i18n.t('challenge.deleted'));
    } catch (err) {
      this.toast.error(err, this.i18n.t('challenge.errors.delete'));
    }
  }

  async removeAttempt(a: AttemptDto): Promise<void> {
    const ok = await this.confirm.ask({
      title: this.i18n.t('challenge.history.delete'),
      message: this.i18n.t('challenge.history.deleteMessage', { date: this.i18n.dateTime(new Date(a.summary.created_at)) }),
      confirmLabel: this.i18n.t('challenge.history.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.deleteAttempt(a.summary.id);
      if (this.result()?.summary.id === a.summary.id) this.dismissResult();
      await this.reloadDetail();
      void this.refreshList();
    } catch (err) {
      this.toast.error(err, this.i18n.t('challenge.errors.deleteAttempt'));
    }
  }

  // ---- Listening to the reference ----

  isPreviewing(): boolean {
    const m = this.melody();
    return !!m && this.playback.isPlaying(m.file_path);
  }

  async togglePreview(): Promise<void> {
    const m = this.melody();
    if (!m || this.isRunning()) return;
    if (this.isPreviewing()) {
      await this.playback.pause();
      return;
    }
    const userRate = this.savedRate ?? this.playback.rate();
    try {
      await this.api.setPlaybackRate(this.tempoPct() / 100);
    } catch (err) {
      this.toast.error(err, this.i18n.t('playback.errors.rate'));
      return;
    }
    await this.playback.play(m.file_path);
    // Set after `play`, so the effect does not restore it before the preview has started.
    this.savedRate = userRate;
    if (!this.playback.isPlaying(m.file_path)) await this.restoreRate();
  }

  private async restoreRate(): Promise<void> {
    const rate = this.savedRate;
    this.savedRate = null;
    if (rate === null) return;
    try {
      await this.api.setPlaybackRate(rate);
    } catch (err) {
      console.warn('Could not restore the playback speed:', err);
    }
  }

  // ---- The attempt ----

  async start(): Promise<void> {
    const d = this.detail();
    if (!d || this.isRunning() || this.busy()) return;
    if (this.recording.isRecording()) {
      this.toast.warning(this.i18n.t('challenge.stopRecordingFirst'));
      return;
    }
    this.busy.set(true);
    try {
      await this.playback.stop();
      await this.restoreRate();
      this.rival.set(bestAttempt(d.attempts, this.tempoPct()));
      this.previous.set(d.attempts[0] ?? null);
      this.result.set(null);
      this.noteStates.set(d.notes.map(() => null));
      this.marks.set([]);
      this.progress.set(null);
      const started = await this.api.startChallenge(
        d.melody.id,
        this.recording.selectedPortId(),
        this.tempoPct(),
        this.metronomeOn(),
        this.guideOn(),
        this.liveSynthOn(),
      );
      this.startedAt = performance.now();
      this.run.set(started);
      this.phase.set('countin');
    } catch (err) {
      this.phase.set('idle');
      this.toast.error(err, this.i18n.t('challenge.errors.start'));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Stops by hand: the attempt is kept as not completed (unless nothing was played). The result
   * arrives through `challenge-finished`, like when it ends on its own.
   */
  async stop(): Promise<void> {
    if (!this.isRunning() || this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.stopChallenge();
    } catch (err) {
      this.toast.error(err, this.i18n.t('challenge.errors.stop'));
    } finally {
      this.busy.set(false);
    }
  }

  dismissResult(): void {
    if (this.isRunning()) return;
    this.clearAttempt();
  }

  private clearAttempt(): void {
    this.phase.set('idle');
    this.run.set(null);
    this.result.set(null);
    this.progress.set(null);
    this.noteStates.set([]);
    this.marks.set([]);
    this.rival.set(null);
  }

  private onNote(e: ChallengeNoteEvent): void {
    if (!this.isRunning()) return;
    const idx = e.expected_index;
    if (idx !== null && (e.kind === 'perfect' || e.kind === 'good')) {
      this.noteStates.update((s) => s.map((v, i) => (i === idx ? e.kind : v)) as (NoteStatus | null)[]);
    } else {
      this.marks.update((m) => [...m, { time_ms: e.time_ms, key: e.key, kind: e.kind }]);
    }
  }

  private onProgress(p: ChallengeProgress): void {
    const run = this.run();
    if (!this.isRunning() || !run) return;
    // The backend clock wins: if the local one drifted (the start reply came late), move it.
    const drift = this.clock() - p.elapsed_ms;
    if (Math.abs(drift) > CLOCK_TOLERANCE_MS) this.startedAt += drift;
    this.progress.set(p);
    if (p.elapsed_ms >= 0 && this.phase() === 'countin') this.phase.set('playing');
    if (p.missed.length) {
      const missed = new Set(p.missed);
      this.noteStates.update((s) => s.map((v, i) => (missed.has(i) ? 'missed' : v)));
    }
  }

  private async onFinished(f: ChallengeFinished): Promise<void> {
    if (!this.isRunning()) return;
    if (f.error) this.toast.error(f.error, this.i18n.t('challenge.errors.save'));
    await this.finish(f.attempt);
  }

  private async finish(attempt: AttemptDto | null): Promise<void> {
    if (!attempt) {
      this.clearAttempt();
      return;
    }
    // The final states come from the saved attempt (the live ones may have missed an event).
    this.noteStates.set(attempt.details.notes.map((n) => n.status));
    this.result.set(attempt);
    this.phase.set('result');
    if (this.isNewRecord()) this.toast.success(this.i18n.t('challenge.result.newRecordToast', { score: attempt.summary.score }));
    await this.reloadDetail();
    void this.refreshList();
  }
}

function readTempos(): Record<string, number> {
  try {
    const raw = localStorage.getItem(TEMPO_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeTempos(map: Record<string, number>): void {
  try {
    localStorage.setItem(TEMPO_KEY, JSON.stringify(map));
  } catch {
    // Not remembered without storage.
  }
}
