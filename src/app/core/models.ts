// IPC contract: exact mirror of `src-tauri/src/models.rs` (fields in snake_case).
// `invoke` arguments are in camelCase (Tauri v2 convention), e.g.
// invoke('start_recording', { sessionId, portId, bpm, metronomeOn, liveSynthOn }).

export interface MidiPortInfo {
  id: string;
  name: string;
  is_virtual: boolean;
}

export interface SessionDto {
  id: string;
  title: string;
  session_date: string;
  bpm: number;
  raw_midi_path: string | null;
  raw_duration_ms: number;
  markdown_notes: string;
  updated_at: string;
}

export interface SessionSummaryDto {
  id: string;
  title: string;
  session_date: string;
  bpm: number;
  raw_duration_ms: number;
  fragment_count: number;
  updated_at: string;
}

export interface TimelineCommentDto {
  id: string;
  fragment_id: string;
  timestamp_ms: number;
  content: string;
  created_at: string;
}

export interface FragmentDto {
  id: string;
  session_id: string;
  title: string;
  explanation: string;
  file_path: string;
  bpm: number;
  duration_ms: number;
  order_index: number;
  created_at: string;
  /** Piece of the repertoire this take belongs to (if any). */
  piece_id: string | null;
  /** Passage of the piece (free text); empty = the whole piece. */
  passage: string;
  comments: TimelineCommentDto[];
}

export interface SessionMediaDto {
  id: string;
  session_id: string;
  /** Absolute path (stored relative to the vault in the database). */
  local_path: string;
}

export interface SessionDetailDto {
  session: SessionDto;
  fragments: FragmentDto[];
  media: SessionMediaDto[];
  /** Number of raw-take trims that can be undone. */
  undo_depth: number;
  /** Fragment that the next undo would delete (it was extracted by the newest trim). */
  undo_fragment_id: string | null;
}

export interface ActivityBlock {
  start_ms: number;
  end_ms: number;
  note_count: number;
  velocity_avg: number;
}

export interface MidiActivityDto {
  file_path: string;
  duration_ms: number;
  blocks: ActivityBlock[];
}

export interface ExtractFragmentReq {
  session_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  explanation: string;
  piece_id?: string | null;
  passage?: string;
}

export interface FragmentCreatedResponse {
  fragment: FragmentDto;
  session: SessionDto;
}

export interface UndoTrimResult {
  session: SessionDto;
  /** Fragment deleted because the undone trim had extracted it. */
  removed_fragment_id: string | null;
}

export interface TimeRangeDto {
  start_ms: number;
  end_ms: number;
}

export interface NoteSpan {
  start_ms: number;
  end_ms: number;
  key: number;
  velocity: number;
}

/** Notes and sustain pedal of a `.mid` file, for the piano roll. */
export interface MidiNotesDto {
  file_path: string;
  duration_ms: number;
  /** Lowest and highest key played (21 and 108, an 88-key piano, if there are no notes). */
  min_key: number;
  max_key: number;
  /** Sorted by `start_ms`. */
  notes: NoteSpan[];
  /** Intervals with the sustain pedal down. */
  pedal: TimeRangeDto[];
}

export interface PracticeDayDto {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  duration_ms: number;
  sessions: number;
}

export interface PracticeStatsDto {
  /** Only the days with practice, sorted by date. */
  days: PracticeDayDto[];
  /** Weekly goal in minutes (0 = no goal). */
  weekly_goal_minutes: number;
}

export interface PieceDto {
  id: string;
  title: string;
  composer: string;
  notes: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface PieceSummaryDto {
  piece: PieceDto;
  take_count: number;
  /** Date of the most recent session with a take of the piece. */
  last_practiced: string | null;
  /** Passages already used in the piece's takes (sorted, without the empty one). */
  passages: string[];
}

export interface PieceTakeDto {
  fragment: FragmentDto;
  session_title: string;
  session_date: string;
}

export interface PieceDetailDto {
  piece: PieceDto;
  /** Sorted by passage and then chronologically. */
  takes: PieceTakeDto[];
}

/** A composition in the list of the composer. */
export interface CompositionSummaryDto {
  id: string;
  title: string;
  track_count: number;
  clip_count: number;
  /** End of the last clip (repeats included). */
  duration_ms: number;
  updated_at: string;
}

/** A clip: a window of a fragment placed on a track. The fragment's MIDI is never copied. */
export interface CompositionClipDto {
  /** Empty for a clip the backend has not stored yet. */
  id: string;
  fragment_id: string;
  /** Position on the composition's timeline. */
  start_ms: number;
  /** Start of the window inside the fragment. */
  trim_start_ms: number;
  /** Length of one repetition of the window. */
  length_ms: number;
  /** Times the window is played back to back (1 = once). */
  repeats: number;
  /** Semitones. */
  transpose: number;
  /**
   * Speed of the window in percent (100 = as recorded, pitch unchanged). `length_ms` and
   * `trim_start_ms` stay in the fragment's own time; each repetition lasts `length_ms × 100 / rate_pct`
   * on the timeline.
   */
  rate_pct: number;
  /** Read only: filled in from the fragment when loading, ignored when saving. */
  fragment_title: string;
  fragment_file_path: string;
  fragment_duration_ms: number;
  /** Read only: the fragment's tempo (a score's own, a recording's metronome setting). */
  fragment_bpm: number;
  /** Read only: the score the fragment was generated from, if it is one. */
  fragment_score_id: string | null;
}

/** A track: one MIDI channel with a General MIDI instrument. The array order is the track order. */
export interface CompositionTrackDto {
  id: string;
  name: string;
  /** General MIDI program (0-127). */
  program: number;
  /** MIDI channel volume (0-127). */
  volume: number;
  muted: boolean;
  solo: boolean;
  /** Whether the recorded sustain pedal (CC64) is played. */
  sustain: boolean;
  /** Index into the track palette. */
  color: number;
  /** Sorted by `start_ms`. */
  clips: CompositionClipDto[];
}

export interface CompositionDto {
  id: string;
  title: string;
  /** Tempo of the composition; `null` until it is set. Clips of a score follow it. */
  bpm: number | null;
  created_at: string;
  updated_at: string;
  tracks: CompositionTrackDto[];
}

/** Spelling of a black key. White keys have no accidental. */
export type Accidental = 'sharp' | 'flat';

/** A note on a staff of a score. Rests are not stored: they are the gaps between notes. */
export interface ScoreNoteDto {
  id: string;
  /** Start from the beginning of the score, in ticks (480 per quarter note). */
  tick: number;
  duration_ticks: number;
  /** Sounding MIDI key (21-108). */
  key: number;
  accidental: Accidental | null;
  /** Tied to the note of the same key that starts where this one ends (they sound as one note). */
  tie: boolean;
}

/** A slur over the notes of one staff, from the note `from` to the note `to` (which starts later). */
export interface ScoreSlurDto {
  id: string;
  from: string;
  to: string;
}

/** A piece written on a grand staff: treble clef (right hand) and bass clef (left hand). */
export interface ScoreDto {
  id: string;
  title: string;
  bpm: number;
  /** Time signature: `beats` notes of `1 / beat_unit` per bar. */
  beats: number;
  beat_unit: number;
  /** Bars, the pickup bar included. */
  bars: number;
  /** Length of a shorter first bar (a pickup or anacrusis), in ticks; 0 = the first bar is whole. */
  pickup_ticks: number;
  /**
   * Index of the bar that ends with a repeat sign (0 is the first bar, the pickup bar if there is one): after
   * it the score goes back to the start and plays through again. `null` = no repeat.
   */
  repeat_bar: number | null;
  treble: ScoreNoteDto[];
  bass: ScoreNoteDto[];
  /** Slurs (phrasing curves). Notation only: they do not change what is played. */
  slurs: ScoreSlurDto[];
  /** The library fragment generated from the score (`null` until it is first saved). */
  fragment_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Mixer state of a track, applied live while a composition plays. */
export interface TrackMixDto {
  volume: number;
  muted: boolean;
  solo: boolean;
}

/** A fragment as the composer's library shows it. */
export interface LibraryFragmentDto {
  id: string;
  title: string;
  file_path: string;
  duration_ms: number;
  session_id: string;
  session_title: string;
  session_date: string;
  piece_id: string | null;
  piece_title: string | null;
  passage: string;
  created_at: string;
  bpm: number;
  /** The score the fragment was generated from, if it is one (then `session_title` is the system session's name). */
  score_id: string | null;
}

/** A score in the list of the score editor. */
export interface ScoreSummaryDto {
  id: string;
  title: string;
  bpm: number;
  beats: number;
  beat_unit: number;
  bars: number;
  note_count: number;
  duration_ms: number;
  fragment_id: string | null;
  updated_at: string;
}

export interface SoundfontCandidate {
  path: string;
  name: string;
  size_bytes: number;
  is_builtin: boolean;
}

export interface SoundfontInfo {
  current_path: string;
  loading: boolean;
  candidates: SoundfontCandidate[];
}

export interface RecentVault {
  path: string;
  /** Folder name. */
  name: string;
  /** The folder exists and is still a vault. */
  available: boolean;
}

/** Open vault (if any), recent ones and warnings. */
export interface VaultInfo {
  /** Root of the open vault (absolute path), or null if there is none. */
  current: string | null;
  name: string | null;
  /** Most recent first; includes the open one. */
  recent: RecentVault[];
  /** Folder with data from the previous version (without vaults) that can be imported. */
  legacy_data_path: string | null;
  /** Warnings about the open vault (e.g. conflicting copies from Dropbox). */
  warnings: string[];
}

export interface VaultOpenResult {
  info: VaultInfo;
  /** false if it was not opened because it seems open on another computer (see lock_warning). */
  opened: boolean;
  /** Message asking for confirmation before opening with force = true. */
  lock_warning: string | null;
}

/** UI language. */
export interface LanguageInfo {
  /** Chosen by the user; null = automatic (the system language). */
  preference: string | null;
  /** Language in use. */
  effective: string;
  /** Language detected on the system (or the fallback if it is not available). */
  system: string;
}

/** What the "About" tab shows (comes from `Cargo.toml`). */
export interface AppInfo {
  name: string;
  version: string;
  /** Author names, without the email address. */
  authors: string[];
  /** SPDX identifier (`"MIT"`). */
  license: string;
  homepage: string;
  repository: string;
  tauri_version: string;
}

/** Links the "About" tab can open; the backend builds the URL. */
export type AppLink = 'homepage' | 'repository' | 'license' | 'gm_soundfont';

/** Payload of the `playback-progress` event (every 50 ms). */
export interface PlaybackProgress {
  file_path: string;
  current_ms: number;
  duration_ms: number;
  is_playing: boolean;
}

// ---------------------------------------------------------------------------
// Challenge mode
// ---------------------------------------------------------------------------

export type MelodySource = 'fragment' | 'import' | 'starter';

/** A reference melody: a frozen copy of a fragment or of an imported file, or a starter melody. */
export interface MelodyDto {
  id: string;
  title: string;
  source: MelodySource;
  /** Fragment it was copied from (informative: it may no longer exist). */
  source_fragment_id: string | null;
  /** Absolute path. */
  file_path: string;
  /** Original tempo: the one at 100 %. */
  bpm: number;
  duration_ms: number;
  note_count: number;
  created_at: string;
  updated_at: string;
}

export interface MelodySummaryDto {
  melody: MelodyDto;
  attempt_count: number;
  /** Best score among the completed attempts (at any tempo). */
  best_score: number | null;
  last_attempt_at: string | null;
  /** Accuracy (0-1) of the last completed attempts, oldest first (at most 12). */
  recent_accuracy: number[];
  /** Highest tempo with a completed attempt of at least 90 % accuracy. */
  mastered_tempo_pct: number | null;
}

/** A note in the melody's original time (the first one starts at 0). */
export interface NoteDto {
  key: number;
  start_ms: number;
  end_ms: number;
  velocity: number;
}

export type NoteStatus = 'perfect' | 'good' | 'missed';

export interface NoteOutcome {
  status: NoteStatus;
  /** Played minus expected time (negative = early); null if missed. */
  offset_ms: number | null;
}

export type PlayedErrorKind = 'wrong' | 'extra';

export interface PlayedError {
  /** In the attempt's timeline (scaled by the tempo), relative to the first note. */
  time_ms: number;
  kind: PlayedErrorKind;
  played_key: number;
  /** The closest note that was due (only for `wrong`). */
  expected_key: number | null;
}

export interface AttemptDetails {
  /** One per note of the melody, in the same order as `MelodyDetailDto.notes`. */
  notes: NoteOutcome[];
  errors: PlayedError[];
}

export interface AttemptSummaryDto {
  id: string;
  melody_id: string;
  created_at: string;
  tempo_pct: number;
  /** Effective BPM. */
  bpm: number;
  /** false if it was stopped before the end: it does not count for records or charts. */
  completed: boolean;
  /** 0-1000. */
  score: number;
  /** Fraction of notes hit, 0-1. */
  accuracy: number;
  hits: number;
  perfect: number;
  misses: number;
  wrong: number;
  extra: number;
  mean_offset_ms: number;
  mean_abs_offset_ms: number;
  latency_comp_ms: number;
  duration_ms: number;
}

export interface AttemptDto {
  summary: AttemptSummaryDto;
  played_midi_path: string | null;
  details: AttemptDetails;
}

export interface MelodyDetailDto {
  melody: MelodyDto;
  notes: NoteDto[];
  /** The notation the melody came from, if it came from a score (to draw it on a staff). */
  score: ScoreDto | null;
  /** Newest first. */
  attempts: AttemptDto[];
}

/** Returned by `start_challenge`. */
export interface ChallengeStarted {
  melody_id: string;
  tempo_pct: number;
  bpm: number;
  /** The first note is due this long after the start. */
  count_in_ms: number;
  latency_comp_ms: number;
  /** Half-width of the hit window. */
  window_ms: number;
}

export type ChallengeNoteKind = 'perfect' | 'good' | 'wrong' | 'extra';

/** Payload of `challenge-note`: a played note, already classified. */
export interface ChallengeNoteEvent {
  time_ms: number;
  key: number;
  kind: ChallengeNoteKind;
  expected_index: number | null;
  offset_ms: number | null;
}

/** Payload of `challenge-progress` (every 50 ms while a challenge runs). */
export interface ChallengeProgress {
  /** Negative during the count-in. */
  elapsed_ms: number;
  hits: number;
  misses: number;
  errors: number;
  /** Notes missed since the previous event. */
  missed: number[];
}

/** Payload of `challenge-finished` (the attempt ended on its own). */
export interface ChallengeFinished {
  attempt: AttemptDto | null;
  error: string | null;
}

/** Names of the Tauri events emitted by the backend. */
export const EVENT_PLAYBACK_PROGRESS = 'playback-progress';
export const EVENT_CHALLENGE_NOTE = 'challenge-note';
export const EVENT_CHALLENGE_PROGRESS = 'challenge-progress';
export const EVENT_CHALLENGE_FINISHED = 'challenge-finished';

/** Id of the MIDI simulator port (always present in `list_midi_ports`). */
export const SIMULATOR_PORT_ID = 'simulator';
