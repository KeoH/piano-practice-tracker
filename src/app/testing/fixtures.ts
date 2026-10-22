import type {
  CompositionDto,
  CompositionTrackDto,
  LibraryFragmentDto,
  FragmentDto,
  PieceDetailDto,
  PieceDto,
  PieceSummaryDto,
  SessionDetailDto,
  SessionDto,
  SessionSummaryDto,
  TimelineCommentDto,
  VaultInfo,
} from '../core/models';

export function session(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 's1',
    title: 'Monday',
    session_date: '2026-10-19T18:00:00',
    bpm: 90,
    raw_midi_path: '/v/midi/raw/raw_session_s1.mid',
    raw_duration_ms: 60_000,
    markdown_notes: '',
    updated_at: '2026-10-19T18:30:00',
    ...over,
  };
}

export function summary(over: Partial<SessionSummaryDto> = {}): SessionSummaryDto {
  return {
    id: 's1',
    title: 'Monday',
    session_date: '2026-10-19T18:00:00',
    bpm: 90,
    raw_duration_ms: 60_000,
    fragment_count: 0,
    updated_at: '2026-10-19T18:30:00',
    ...over,
  };
}

export function comment(over: Partial<TimelineCommentDto> = {}): TimelineCommentDto {
  return { id: 'c1', fragment_id: 'f1', timestamp_ms: 1000, content: 'Rush here', created_at: '', ...over };
}

export function fragment(over: Partial<FragmentDto> = {}): FragmentDto {
  return {
    id: 'f1',
    session_id: 's1',
    title: 'Bars 1-8',
    explanation: '',
    file_path: '/v/midi/fragments/frag_f1.mid',
    bpm: 90,
    duration_ms: 8000,
    order_index: 0,
    created_at: '2026-10-19T18:10:00',
    piece_id: null,
    passage: '',
    comments: [],
    ...over,
  };
}

export function detail(over: Partial<SessionDetailDto> = {}): SessionDetailDto {
  return { session: session(), fragments: [], media: [], undo_depth: 0, undo_fragment_id: null, ...over };
}

export function piece(over: Partial<PieceDto> = {}): PieceDto {
  return {
    id: 'p1',
    title: 'Nocturne op. 9 no. 2',
    composer: 'Chopin',
    notes: '',
    archived: false,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

export function pieceSummary(over: Partial<PieceDto> = {}, extra: Partial<PieceSummaryDto> = {}): PieceSummaryDto {
  return { piece: piece(over), take_count: 0, last_practiced: null, passages: [], ...extra };
}

export function pieceDetail(over: Partial<PieceDetailDto> = {}): PieceDetailDto {
  return { piece: piece(), takes: [], ...over };
}

export function vaultInfo(over: Partial<VaultInfo> = {}): VaultInfo {
  return {
    current: '/home/me/Vault',
    name: 'Vault',
    recent: [{ path: '/home/me/Vault', name: 'Vault', available: true }],
    legacy_data_path: null,
    warnings: [],
    ...over,
  };
}

export function libraryFragment(over: Partial<LibraryFragmentDto> = {}): LibraryFragmentDto {
  return {
    id: 'f1',
    title: 'Bars 1-8',
    file_path: '/v/midi/fragments/frag_f1.mid',
    duration_ms: 4000,
    session_id: 's1',
    session_title: 'Monday',
    session_date: '2026-10-19',
    piece_id: null,
    piece_title: null,
    passage: '',
    created_at: '',
    ...over,
  };
}

export function track(over: Partial<CompositionTrackDto> = {}): CompositionTrackDto {
  return { id: 't1', name: 'Track 1', program: 0, volume: 100, muted: false, solo: false, sustain: true, color: 0, clips: [], ...over };
}

export function composition(over: Partial<CompositionDto> = {}): CompositionDto {
  return { id: 'c1', title: 'Arrangement', created_at: '', updated_at: '', tracks: [track()], ...over };
}
