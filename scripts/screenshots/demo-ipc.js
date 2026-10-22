// Fake Tauri IPC with invented demo data, injected before the app loads so the screenshots show
// a populated vault without the desktop app. It answers the commands of `TauriApiService`; any
// other command resolves to `null`. Nothing here is real user data.
(() => {
  const DAY = 86_400_000;
  const today = new Date();
  today.setHours(19, 0, 0, 0);
  const iso = (d) => new Date(d).toISOString();
  const daysAgo = (n, hour = 19) => {
    const d = new Date(today.getTime() - n * DAY);
    d.setHours(hour, 5, 0, 0);
    return iso(d);
  };
  const dateOnly = (n) => {
    const d = new Date(today.getTime() - n * DAY);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // Deterministic pseudo-random numbers, so every run draws the same music.
  let seed = 7;
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);

  const SCALE = [0, 2, 4, 5, 7, 9, 11];
  const CHORDS = [0, 9, 5, 7, 2, 7, 0, 4]; // I vi IV V ii V I iii (as roots in C)

  /** A passage of `bars` 4/4 bars at `bpm`: an arpeggiated left hand and an eighth-note melody. */
  function passage(startMs, bars, bpm, transpose = 0) {
    const beat = 60_000 / bpm;
    const notes = [];
    const pedal = [];
    let degree = 4;
    for (let bar = 0; bar < bars; bar++) {
      const t0 = startMs + bar * 4 * beat;
      const root = 48 + CHORDS[bar % CHORDS.length] + transpose;
      pedal.push({ start_ms: Math.round(t0 + 20), end_ms: Math.round(t0 + 4 * beat - 60) });
      // Left hand: root, fifth, octave, tenth.
      [0, 7, 12, 16, 12, 7, 0, 7].forEach((step, i) => {
        const s = t0 + i * (beat / 2);
        notes.push({ start_ms: Math.round(s), end_ms: Math.round(s + beat * 0.9), key: root - 12 + step, velocity: 52 + Math.round(rand() * 16) });
      });
      // Right hand: a melody that walks the scale, with an occasional held note.
      for (let i = 0; i < 8; i++) {
        if (rand() < 0.12) continue;
        degree = Math.max(0, Math.min(13, degree + Math.round(rand() * 4) - 2));
        const key = 72 + transpose + SCALE[degree % 7] + 12 * Math.floor(degree / 7) - 5;
        const s = t0 + i * (beat / 2);
        const len = rand() < 0.2 ? beat * 1.4 : beat * 0.45;
        notes.push({ start_ms: Math.round(s), end_ms: Math.round(s + len), key, velocity: 70 + Math.round(rand() * 30) });
      }
    }
    return { notes, pedal, end: startMs + bars * 4 * beat };
  }

  /** A take made of passages separated by silences, as `{ notes, pedal, duration }`. */
  function take(sections, bpm) {
    const notes = [];
    const pedal = [];
    let t = 0;
    for (const [bars, gapMs, transpose] of sections) {
      const p = passage(t, bars, bpm, transpose);
      notes.push(...p.notes);
      pedal.push(...p.pedal);
      t = p.end + gapMs;
    }
    notes.sort((a, b) => a.start_ms - b.start_ms);
    return { notes, pedal, duration: Math.round(t) };
  }

  const files = {};
  const addFile = (path, music) => {
    files[path] = music;
    return path;
  };

  const VAULT = '/home/demo/Piano Vault';
  const raw = (id) => `${VAULT}/midi/raw/raw_session_${id}.mid`;
  const frag = (id) => `${VAULT}/midi/fragments/frag_${id}.mid`;

  // ---- Pieces ----
  const piece = (id, title, composer, created) => ({ id, title, composer, notes: '', archived: false, created_at: daysAgo(created), updated_at: daysAgo(1) });
  const pieces = [
    piece('p-nocturne', 'Nocturne in E-flat major, Op. 9 No. 2', 'Frédéric Chopin', 60),
    piece('p-gymno', 'Gymnopédie No. 1', 'Erik Satie', 45),
    piece('p-prelude', 'Prelude in C major, BWV 846', 'J. S. Bach', 30),
    piece('p-river', 'River Flows in You', 'Yiruma', 20),
  ];
  pieces[0].notes = 'Keep the left hand soft. Bars 13-16: let the ornaments breathe, no rush into the cadence.';
  pieces.push({ ...piece('p-czerny', 'Etude Op. 599 No. 20', 'Carl Czerny', 90), archived: true });

  // ---- Sessions and fragments ----
  const sessions = [];
  const details = {};
  const library = [];
  const sessionDefs = [
    ['s-today', 'Evening practice: Nocturne', 0, 72, [[12, 7000, 0], [16, 9000, 0], [10, 6000, 2], [14, 0, 0]]],
    ['s-1', 'Satie, slow and even', 1, 66, [[16, 8000, 0], [16, 0, 0]]],
    ['s-2', 'Bach prelude: first page', 2, 80, [[20, 5000, 0], [12, 0, 0]]],
    ['s-4', 'Scales and arpeggios', 4, 96, [[24, 0, 0]]],
    ['s-6', 'Nocturne, bars 1-12', 6, 70, [[12, 6000, 0], [12, 0, 0]]],
    ['s-9', 'Sight-reading', 9, 88, [[18, 0, 3]]],
    ['s-13', 'Yiruma with metronome', 13, 76, [[20, 0, 0]]],
    ['s-20', 'Bach prelude, hands separately', 20, 72, [[16, 0, 0]]],
  ];
  const fragmentDefs = {
    's-today': [
      ['f-noct-a', 'Opening theme', 'p-nocturne', 'Bars 1-4', 8, 0, [['Lovely legato here', 2400], ['Left hand a bit loud', 6100]]],
      ['f-noct-b', 'Ornament run, cleaner', 'p-nocturne', 'Bars 13-16', 8, 2, [['Better than yesterday', 3200]]],
      ['f-noct-c', 'Cadence to the reprise', 'p-nocturne', 'Bars 13-16', 6, 0, []],
    ],
    's-1': [
      ['f-gym-a', 'First phrase', 'p-gymno', 'Bars 1-8', 8, 0, [['Keep the tempo steady', 4000]]],
      ['f-gym-b', 'Full piece, second try', 'p-gymno', '', 12, 0, []],
    ],
    's-2': [['f-bach-a', 'Arpeggio pattern', 'p-prelude', 'Bars 1-11', 10, 0, []]],
    's-6': [
      ['f-noct-old', 'Opening theme (first try)', 'p-nocturne', 'Bars 1-4', 8, 0, [['Uneven eighths', 3000]]],
      ['f-noct-old2', 'Ornament run', 'p-nocturne', 'Bars 13-16', 8, 2, []],
    ],
    's-13': [['f-river', 'Main melody', 'p-river', 'Intro', 10, 0, []]],
  };

  for (const [id, title, ago, bpm, sections] of sessionDefs) {
    const music = take(sections, bpm);
    addFile(raw(id), music);
    const session = {
      id,
      title,
      session_date: daysAgo(ago),
      bpm,
      raw_midi_path: raw(id),
      raw_duration_ms: music.duration,
      markdown_notes: id === 's-today' ? '## Goals\n\n- Even left-hand arpeggios\n- **Bars 13-16** at 72 BPM\n' : '',
      updated_at: daysAgo(ago, 20),
    };
    const fragments = (fragmentDefs[id] ?? []).map(([fid, ftitle, pieceId, passageName, bars, transpose, comments], i) => {
      const m = take([[bars, 0, transpose]], bpm);
      addFile(frag(fid), m);
      const f = {
        id: fid,
        session_id: id,
        title: ftitle,
        explanation: '',
        file_path: frag(fid),
        bpm,
        duration_ms: m.duration,
        order_index: i,
        created_at: daysAgo(ago, 19),
        piece_id: pieceId,
        passage: passageName,
        comments: comments.map(([content, ts], j) => ({ id: `${fid}-c${j}`, fragment_id: fid, timestamp_ms: ts, content, created_at: daysAgo(ago, 19) })),
      };
      library.push({
        id: fid,
        title: ftitle,
        file_path: f.file_path,
        duration_ms: f.duration_ms,
        session_id: id,
        session_title: title,
        session_date: session.session_date,
        piece_id: pieceId,
        piece_title: pieces.find((p) => p.id === pieceId)?.title ?? null,
        passage: passageName,
        created_at: f.created_at,
      });
      return f;
    });
    details[id] = { session, fragments, media: [], undo_depth: id === 's-today' ? 2 : 0, undo_fragment_id: null };
    sessions.push({ id, title, session_date: session.session_date, bpm, raw_duration_ms: music.duration, fragment_count: fragments.length, updated_at: session.updated_at });
  }

  const allFragments = Object.values(details).flatMap((d) => d.fragments.map((f) => ({ f, s: d.session })));
  const pieceSummaries = () =>
    pieces.map((p) => {
      const takes = allFragments.filter(({ f }) => f.piece_id === p.id);
      return {
        piece: p,
        take_count: takes.length,
        last_practiced: takes.length ? takes.map(({ s }) => s.session_date).sort().at(-1) : null,
        passages: [...new Set(takes.map(({ f }) => f.passage).filter(Boolean))].sort(),
      };
    });
  const pieceDetail = (pieceId) => ({
    piece: pieces.find((p) => p.id === pieceId),
    takes: allFragments
      .filter(({ f }) => f.piece_id === pieceId)
      .sort((a, b) => a.f.passage.localeCompare(b.f.passage) || a.s.session_date.localeCompare(b.s.session_date))
      .map(({ f, s }) => ({ fragment: f, session_title: s.title, session_date: s.session_date })),
  });

  // ---- Composition ----
  const libById = Object.fromEntries(library.map((f) => [f.id, f]));
  const clip = (id, fragmentId, start, repeats = 1, transpose = 0) => {
    const f = libById[fragmentId];
    return {
      id,
      fragment_id: fragmentId,
      start_ms: start,
      trim_start_ms: 0,
      length_ms: f.duration_ms,
      repeats,
      transpose,
      fragment_title: f.title,
      fragment_file_path: f.file_path,
      fragment_duration_ms: f.duration_ms,
    };
  };
  const track = (id, name, program, color, clips, extra = {}) => ({ id, name, program, volume: 100, muted: false, solo: false, sustain: true, color, clips, ...extra });
  const len = (id) => libById[id].duration_ms;
  const composition = {
    id: 'c-medley',
    title: 'Nocturne medley',
    created_at: daysAgo(5),
    updated_at: daysAgo(0, 18),
    tracks: [
      track('t1', 'Piano', 0, 0, [clip('k1', 'f-noct-a', 0), clip('k2', 'f-noct-b', len('f-noct-a')), clip('k3', 'f-noct-c', len('f-noct-a') + len('f-noct-b'))]),
      track('t2', 'Strings', 48, 1, [clip('k4', 'f-gym-a', 4000, 2, -12)], { volume: 78 }),
      track('t3', 'Celesta', 8, 2, [clip('k5', 'f-bach-a', len('f-noct-a'), 1, 12)], { volume: 64 }),
      track('t4', 'Choir', 52, 3, [clip('k6', 'f-river', 2000)], { muted: true }),
    ],
  };
  const compositionSummary = {
    id: composition.id,
    title: composition.title,
    track_count: composition.tracks.length,
    clip_count: composition.tracks.reduce((n, t) => n + t.clips.length, 0),
    duration_ms: Math.max(...composition.tracks.flatMap((t) => t.clips.map((c) => c.start_ms + c.length_ms * c.repeats))),
    updated_at: composition.updated_at,
  };
  const compositions = [
    compositionSummary,
    { id: 'c-duet', title: 'Satie duet sketch', track_count: 2, clip_count: 3, duration_ms: 96_000, updated_at: daysAgo(8) },
  ];

  // ---- Practice history: most days of the last ~8 months ----
  const days = [];
  seed = 42;
  for (let n = 240; n >= 0; n--) {
    const streak = n <= 16; // an unbroken run up to today
    if (!streak && rand() < 0.35) continue;
    const minutes = Math.round(10 + rand() * 50 + (n % 7 === 6 ? 25 : 0));
    days.push({ date: dateOnly(n), duration_ms: minutes * 60_000, sessions: minutes > 40 ? 2 : 1 });
  }

  // ---- MIDI analysis of the fake files ----
  function activity(path) {
    const m = files[path] ?? { notes: [], duration: 0 };
    const n = 200;
    const size = Math.max(1, m.duration / n);
    const blocks = [];
    for (let i = 0; i < n; i++) {
      const s = i * size;
      const inside = m.notes.filter((x) => x.start_ms >= s && x.start_ms < s + size);
      if (!inside.length) continue;
      blocks.push({
        start_ms: Math.round(s),
        end_ms: Math.round(s + size),
        note_count: inside.length,
        velocity_avg: inside.reduce((t, x) => t + x.velocity, 0) / inside.length,
      });
    }
    return { file_path: path, duration_ms: m.duration, blocks };
  }
  function notes(path) {
    const m = files[path] ?? { notes: [], pedal: [], duration: 0 };
    const keys = m.notes.map((x) => x.key);
    return {
      file_path: path,
      duration_ms: m.duration,
      min_key: keys.length ? Math.min(...keys) : 21,
      max_key: keys.length ? Math.max(...keys) : 108,
      notes: m.notes,
      pedal: m.pedal,
    };
  }
  function segments(path) {
    const m = files[path];
    if (!m) return [];
    const out = [];
    let cur = null;
    for (const n of m.notes) {
      if (cur && n.start_ms - cur.end_ms < 3000) cur.end_ms = Math.max(cur.end_ms, n.end_ms);
      else {
        if (cur) out.push(cur);
        cur = { start_ms: n.start_ms, end_ms: n.end_ms };
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  const vaultInfo = {
    current: VAULT,
    name: 'Piano Vault',
    recent: [{ path: VAULT, name: 'Piano Vault', available: true }],
    legacy_data_path: null,
    warnings: [],
  };

  const handlers = {
    'plugin:event|listen': () => 1,
    get_language: () => ({ preference: null, effective: 'en', system: 'en' }),
    get_vault_info: () => vaultInfo,
    list_midi_ports: () => [
      { id: 'midir:Digital Piano', name: 'Digital Piano MIDI 1', is_virtual: false },
      { id: 'simulator', name: 'Simulator', is_virtual: true },
    ],
    get_sessions: () => sessions,
    get_session_detail: ({ sessionId }) => details[sessionId],
    get_midi_activity: ({ filePath }) => activity(filePath),
    get_midi_notes: ({ filePath }) => notes(filePath),
    suggest_midi_segments: ({ filePath }) => segments(filePath),
    get_pieces: () => pieceSummaries(),
    get_piece_detail: ({ pieceId }) => pieceDetail(pieceId),
    get_compositions: () => compositions,
    get_composition: () => composition,
    save_composition: ({ composition: doc }) => doc,
    get_library_fragments: () => library,
    count_composition_uses: () => 0,
    get_soundfont_programs: () => Array.from({ length: 128 }, (_, i) => i),
    get_soundfont_info: () => ({
      current_path: '/usr/share/sounds/sf2/FluidR3_GM.sf2',
      loading: false,
      candidates: [{ path: '/usr/share/sounds/sf2/FluidR3_GM.sf2', name: 'FluidR3_GM.sf2', size_bytes: 148_000_000, is_builtin: false }],
    }),
    get_practice_stats: () => ({ days, weekly_goal_minutes: 240 }),
    set_playback_rate: ({ rate }) => rate,
    get_app_info: () => ({ name: 'piano-tracker', version: '0.3.0', authors: [], license: 'MIT', homepage: '', repository: '', tauri_version: '2' }),
  };

  // The sidebar shows a connected keyboard rather than the simulator.
  try {
    localStorage.setItem('piano-tracker.port', 'midir:Digital Piano');
  } catch {
    // Without storage it shows the simulator.
  }

  let callbackId = 0;
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback: () => ++callbackId,
    unregisterCallback: () => undefined,
    convertFileSrc: (path) => path,
    invoke: async (cmd, args = {}) => (cmd in handlers ? handlers[cmd](args) : null),
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
})();
