//! Motor de recorte y análisis MIDI (sección 4.2 de la especificación).
//!
//! Representación interna: lista de eventos de canal con tiempo absoluto en
//! microsegundos (`TimedMidiEvent`). Los metaeventos (tempo, nombre, etc.) se
//! descartan al leer: el tempo se usa para convertir ticks a tiempo real y al
//! escribir se inyecta un único meta `Tempo` según el BPM de la sesión.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use midly::num::{u15, u24, u28, u4, u7};
use midly::{Format, Header, MetaMessage, MidiMessage, Smf, Timing, TrackEvent, TrackEventKind};

use crate::models::{ActivityBlock, MidiActivityDto};

/// Resolución usada al escribir ficheros SMF.
pub const TICKS_PER_QUARTER: u16 = 480;
const DEFAULT_TEMPO_US_PER_QN: u32 = 500_000;
/// Duración mínima de un bloque de actividad.
const MIN_BLOCK_MS: u64 = 100;

/// Mensaje MIDI de canal crudo (NoteOn/NoteOff/CC/ProgramChange/PitchBend...) con tiempo absoluto.
#[derive(Clone, Debug, PartialEq)]
pub struct TimedMidiEvent {
    pub time_us: u64,
    pub bytes: Vec<u8>,
}

impl TimedMidiEvent {
    pub fn new(time_us: u64, bytes: Vec<u8>) -> Self {
        TimedMidiEvent { time_us, bytes }
    }
}

/// Resultado de `extract_fragment_and_trim`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SliceResult {
    pub fragment_duration_ms: u64,
    pub remaining_duration_ms: u64,
}

// ---------------------------------------------------------------------------
// Clasificación de mensajes
// ---------------------------------------------------------------------------

/// `(canal, nota, velocidad)` si es un NoteOn con velocidad > 0.
pub(crate) fn as_note_on(bytes: &[u8]) -> Option<(u8, u8, u8)> {
    if bytes.len() >= 3 && bytes[0] & 0xF0 == 0x90 && bytes[2] > 0 {
        Some((bytes[0] & 0x0F, bytes[1], bytes[2]))
    } else {
        None
    }
}

/// `(canal, nota)` si es un NoteOff (o NoteOn con velocidad 0).
pub(crate) fn as_note_off(bytes: &[u8]) -> Option<(u8, u8)> {
    if bytes.len() >= 3 && (bytes[0] & 0xF0 == 0x80 || (bytes[0] & 0xF0 == 0x90 && bytes[2] == 0)) {
        Some((bytes[0] & 0x0F, bytes[1]))
    } else {
        None
    }
}

/// `(canal, valor)` si es un CC64 (pedal de sustain).
pub(crate) fn as_sustain(bytes: &[u8]) -> Option<(u8, u8)> {
    if bytes.len() >= 3 && bytes[0] & 0xF0 == 0xB0 && bytes[1] == 64 {
        Some((bytes[0] & 0x0F, bytes[2]))
    } else {
        None
    }
}

fn channel_of(bytes: &[u8]) -> Option<u8> {
    match bytes.first() {
        Some(&s) if (0x80..0xF0).contains(&s) => Some(s & 0x0F),
        _ => None,
    }
}

pub(crate) fn note_off_msg(ch: u8, key: u8) -> Vec<u8> {
    vec![0x80 | (ch & 0x0F), key & 0x7F, 0]
}

pub(crate) fn sustain_msg(ch: u8, value: u8) -> Vec<u8> {
    vec![0xB0 | (ch & 0x0F), 64, value & 0x7F]
}

fn encode_message(channel: u8, message: &MidiMessage) -> Vec<u8> {
    let ch = channel & 0x0F;
    match *message {
        MidiMessage::NoteOff { key, vel } => vec![0x80 | ch, key.as_int(), vel.as_int()],
        MidiMessage::NoteOn { key, vel } => vec![0x90 | ch, key.as_int(), vel.as_int()],
        MidiMessage::Aftertouch { key, vel } => vec![0xA0 | ch, key.as_int(), vel.as_int()],
        MidiMessage::Controller { controller, value } => vec![0xB0 | ch, controller.as_int(), value.as_int()],
        MidiMessage::ProgramChange { program } => vec![0xC0 | ch, program.as_int()],
        MidiMessage::ChannelAftertouch { vel } => vec![0xD0 | ch, vel.as_int()],
        MidiMessage::PitchBend { bend } => {
            let v = bend.0.as_int();
            vec![0xE0 | ch, (v & 0x7F) as u8, ((v >> 7) & 0x7F) as u8]
        }
    }
}

fn decode_message(bytes: &[u8]) -> Option<(u8, MidiMessage)> {
    let status = *bytes.first()?;
    if !(0x80..0xF0).contains(&status) {
        return None;
    }
    let ch = status & 0x0F;
    let d = |i: usize| bytes.get(i).map(|b| u7::new(*b));
    let msg = match status & 0xF0 {
        0x80 => MidiMessage::NoteOff { key: d(1)?, vel: d(2)? },
        0x90 => MidiMessage::NoteOn { key: d(1)?, vel: d(2)? },
        0xA0 => MidiMessage::Aftertouch { key: d(1)?, vel: d(2)? },
        0xB0 => MidiMessage::Controller { controller: d(1)?, value: d(2)? },
        0xC0 => MidiMessage::ProgramChange { program: d(1)? },
        0xD0 => MidiMessage::ChannelAftertouch { vel: d(1)? },
        0xE0 => {
            let lsb = *bytes.get(1)? as u16 & 0x7F;
            let msb = *bytes.get(2)? as u16 & 0x7F;
            MidiMessage::PitchBend { bend: midly::PitchBend(midly::num::u14::new((msb << 7) | lsb)) }
        }
        _ => return None,
    };
    Some((ch, msg))
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

enum TickClock {
    /// Ticks por negra + mapa de tempos `(tick, us_por_negra, us_acumulados_en_tick)`.
    Metrical { tpq: u64, changes: Vec<(u64, u32, f64)> },
    /// Timecode SMPTE: microsegundos por tick fijos.
    Timecode { us_per_tick: f64 },
}

impl TickClock {
    fn tick_to_us(&self, tick: u64) -> u64 {
        match self {
            TickClock::Timecode { us_per_tick } => (tick as f64 * us_per_tick).round() as u64,
            TickClock::Metrical { tpq, changes } => {
                let idx = match changes.binary_search_by(|c| c.0.cmp(&tick)) {
                    Ok(i) => i,
                    Err(i) => i.saturating_sub(1),
                };
                let (ct, tempo, base) = changes.get(idx).copied().unwrap_or((0, DEFAULT_TEMPO_US_PER_QN, 0.0));
                let us = base + (tick.saturating_sub(ct)) as f64 * tempo as f64 / *tpq as f64;
                us.round() as u64
            }
        }
    }
}

/// Lee fichero completo y devuelve eventos + duración en microsegundos.
fn read_timed_events_us(path: &Path) -> Result<(Vec<TimedMidiEvent>, u64), String> {
    let data = std::fs::read(path).map_err(|e| format!("No se pudo leer {}: {e}", path.display()))?;
    let smf = Smf::parse(&data).map_err(|e| format!("Fichero MIDI inválido {}: {e}", path.display()))?;

    // Mapa de tempos de todas las pistas.
    let clock = match smf.header.timing {
        Timing::Timecode(fps, sub) => {
            let tps = fps.as_f32() as f64 * (sub.max(1)) as f64;
            TickClock::Timecode { us_per_tick: 1_000_000.0 / tps }
        }
        Timing::Metrical(tpq) => {
            let tpq = (tpq.as_int() as u64).max(1);
            let mut raw: Vec<(u64, u32)> = Vec::new();
            for track in &smf.tracks {
                let mut tick = 0u64;
                for ev in track {
                    tick += ev.delta.as_int() as u64;
                    if let TrackEventKind::Meta(MetaMessage::Tempo(t)) = ev.kind {
                        raw.push((tick, t.as_int().max(1)));
                    }
                }
            }
            raw.sort_by_key(|c| c.0); // estable: a igual tick gana el último
            let mut changes: Vec<(u64, u32, f64)> = vec![(0, DEFAULT_TEMPO_US_PER_QN, 0.0)];
            for (tick, tempo) in raw {
                let (lt, ltempo, lbase) = *changes.last().unwrap_or(&(0, DEFAULT_TEMPO_US_PER_QN, 0.0));
                if tick == lt {
                    if let Some(last) = changes.last_mut() {
                        last.1 = tempo;
                    }
                } else {
                    let base = lbase + (tick - lt) as f64 * ltempo as f64 / tpq as f64;
                    changes.push((tick, tempo, base));
                }
            }
            TickClock::Metrical { tpq, changes }
        }
    };

    let mut events: Vec<(u64, usize, usize, TimedMidiEvent)> = Vec::new();
    let mut max_us = 0u64;
    for (ti, track) in smf.tracks.iter().enumerate() {
        let mut tick = 0u64;
        for (ei, ev) in track.iter().enumerate() {
            tick += ev.delta.as_int() as u64;
            let us = clock.tick_to_us(tick);
            match ev.kind {
                TrackEventKind::Midi { channel, message } => {
                    max_us = max_us.max(us);
                    events.push((us, ti, ei, TimedMidiEvent::new(us, encode_message(channel.as_int(), &message))));
                }
                TrackEventKind::Meta(MetaMessage::EndOfTrack) => max_us = max_us.max(us),
                _ => {}
            }
        }
    }
    // Orden por tiempo; a igualdad, por pista y posición original (estable).
    events.sort_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)));
    Ok((events.into_iter().map(|e| e.3).collect(), max_us))
}

fn us_to_ms(us: u64) -> u64 {
    (us + 500) / 1000
}

/// Parsea un SMF (formato 0/1/2) respetando el mapa de tempos.
/// Devuelve eventos de canal con tiempo absoluto en µs y la duración en ms.
pub fn read_timed_events(path: &Path) -> Result<(Vec<TimedMidiEvent>, u64), String> {
    let (events, dur_us) = read_timed_events_us(path)?;
    Ok((events, us_to_ms(dur_us)))
}

pub fn midi_duration_ms(path: &Path) -> Result<u64, String> {
    read_timed_events(path).map(|(_, d)| d)
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

/// Escritura atómica: fichero temporal en el mismo directorio + rename.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear {}: {e}", parent.display()))?;
        }
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "out".into());
    let tmp: PathBuf = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("No se pudo escribir {}: {e}", path.display()));
    }
    Ok(())
}

fn tempo_for_bpm(bpm: u32) -> u32 {
    let bpm = bpm.clamp(4, 1000);
    60_000_000 / bpm
}

/// Escribe SMF formato 0 (480 TPQ) con `EndOfTrack` en `max(último evento, end_us)`.
fn write_smf_with_end(path: &Path, events: &[TimedMidiEvent], bpm: u32, end_us: Option<u64>) -> Result<(), String> {
    let tempo = tempo_for_bpm(bpm) as u128;
    let to_tick = |us: u64| -> u64 { ((us as u128 * TICKS_PER_QUARTER as u128 + tempo / 2) / tempo) as u64 };

    let mut sorted: Vec<&TimedMidiEvent> = events.iter().collect();
    sorted.sort_by_key(|e| e.time_us); // sort_by_key es estable

    let mut track: Vec<TrackEvent<'static>> = Vec::with_capacity(sorted.len() + 2);
    track.push(TrackEvent {
        delta: u28::new(0),
        kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(tempo as u32))),
    });
    let mut last_tick = 0u64;
    for ev in sorted {
        let Some((ch, message)) = decode_message(&ev.bytes) else {
            log::debug!("midi_slicer: evento ignorado al escribir: {:?}", ev.bytes);
            continue;
        };
        let tick = to_tick(ev.time_us).max(last_tick);
        let delta = (tick - last_tick).min(u28::max_value().as_int() as u64) as u32;
        track.push(TrackEvent { delta: u28::new(delta), kind: TrackEventKind::Midi { channel: u4::new(ch), message } });
        last_tick = tick;
    }
    let end_tick = end_us.map(to_tick).unwrap_or(0).max(last_tick);
    let delta = (end_tick - last_tick).min(u28::max_value().as_int() as u64) as u32;
    track.push(TrackEvent { delta: u28::new(delta), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });

    let mut smf = Smf::new(Header::new(Format::SingleTrack, Timing::Metrical(u15::new(TICKS_PER_QUARTER))));
    smf.tracks.push(track);
    let mut buf: Vec<u8> = Vec::new();
    smf.write_std(&mut buf).map_err(|e| format!("No se pudo serializar MIDI: {e}"))?;
    atomic_write(path, &buf)
}

/// Escribe SMF formato 0, 480 TPQ, meta `Tempo(60_000_000/bpm)` en t=0, eventos ordenados
/// de forma estable por tiempo y `EndOfTrack` tras el último. Escritura atómica.
pub fn write_smf(path: &Path, events: &[TimedMidiEvent], bpm: u32) -> Result<(), String> {
    write_smf_with_end(path, events, bpm, None)
}

// ---------------------------------------------------------------------------
// Análisis de actividad
// ---------------------------------------------------------------------------

pub fn analyze_midi_activity(path: &Path, max_blocks: usize) -> Result<MidiActivityDto, String> {
    let (events, duration_ms) = read_timed_events(path)?;
    let file_path = path.to_string_lossy().into_owned();
    if duration_ms == 0 || max_blocks == 0 {
        return Ok(MidiActivityDto { file_path, duration_ms, blocks: Vec::new() });
    }
    let n = ((duration_ms / MIN_BLOCK_MS).max(1) as usize).min(max_blocks).max(1);
    let bounds: Vec<u64> = (0..=n).map(|i| (duration_ms as u128 * i as u128 / n as u128) as u64).collect();
    let mut counts = vec![0u32; n];
    let mut vel_sum = vec![0u64; n];
    for ev in &events {
        if let Some((_, _, vel)) = as_note_on(&ev.bytes) {
            let t = ev.time_us as f64 / 1000.0;
            let mut idx = ((t / duration_ms as f64) * n as f64).floor() as usize;
            idx = idx.min(n - 1);
            // Corrige posibles desajustes de redondeo con los límites enteros.
            while idx > 0 && t < bounds[idx] as f64 {
                idx -= 1;
            }
            while idx + 1 < n && t >= bounds[idx + 1] as f64 {
                idx += 1;
            }
            counts[idx] += 1;
            vel_sum[idx] += vel as u64;
        }
    }
    let blocks = (0..n)
        .map(|i| ActivityBlock {
            start_ms: bounds[i],
            end_ms: bounds[i + 1],
            note_count: counts[i],
            velocity_avg: if counts[i] > 0 { vel_sum[i] as f32 / counts[i] as f32 } else { 0.0 },
        })
        .collect();
    Ok(MidiActivityDto { file_path, duration_ms, blocks })
}

// ---------------------------------------------------------------------------
// Recorte
// ---------------------------------------------------------------------------

fn validate_range(start_ms: u64, end_ms: u64, duration_ms: u64) -> Result<(u64, u64), String> {
    if start_ms >= end_ms {
        return Err(format!("Rango inválido: inicio ({start_ms} ms) debe ser menor que fin ({end_ms} ms)"));
    }
    let end = end_ms.min(duration_ms);
    if start_ms >= end {
        return Err(format!("Rango inválido: el inicio ({start_ms} ms) está fuera de la duración ({duration_ms} ms)"));
    }
    Ok((start_ms, end))
}

/// Construye el fragmento `[start, end)` normalizado a t=0.
fn build_fragment(events: &[TimedMidiEvent], start_us: u64, end_us: u64) -> Vec<TimedMidiEvent> {
    let span = end_us - start_us;
    // Estado del pedal justo antes de start.
    let mut pedal: HashMap<u8, u8> = HashMap::new();
    for ev in events.iter().filter(|e| e.time_us < start_us) {
        if let Some((ch, v)) = as_sustain(&ev.bytes) {
            pedal.insert(ch, v);
        }
    }
    let mut out: Vec<TimedMidiEvent> = Vec::new();
    let mut used: BTreeSet<u8> = BTreeSet::new();
    let mut pedal_chs: Vec<(u8, u8)> = pedal.into_iter().filter(|(_, v)| *v >= 64).collect();
    pedal_chs.sort();
    for (ch, v) in pedal_chs {
        out.push(TimedMidiEvent::new(0, sustain_msg(ch, v)));
        used.insert(ch);
    }

    // Notas abiertas dentro del fragmento, en orden de apertura.
    let mut open: Vec<(u8, u8)> = Vec::new();
    for ev in events.iter().filter(|e| e.time_us >= start_us && e.time_us < end_us) {
        let t = ev.time_us - start_us;
        if let Some((ch, key, _)) = as_note_on(&ev.bytes) {
            open.push((ch, key));
        } else if let Some((ch, key)) = as_note_off(&ev.bytes) {
            match open.iter().position(|n| *n == (ch, key)) {
                Some(pos) => {
                    open.remove(pos);
                }
                None => continue, // NoteOff huérfano (nota iniciada antes de start)
            }
        }
        if let Some(ch) = channel_of(&ev.bytes) {
            used.insert(ch);
        }
        out.push(TimedMidiEvent::new(t, ev.bytes.clone()));
    }
    // Cierre en t' = end - start.
    for (ch, key) in open {
        out.push(TimedMidiEvent::new(span, note_off_msg(ch, key)));
    }
    for ch in used {
        out.push(TimedMidiEvent::new(span, sustain_msg(ch, 0)));
    }
    out
}

/// Elimina `[start, end)` de la pista bruta y cierra el hueco.
fn build_trimmed(events: &[TimedMidiEvent], start_us: u64, end_us: u64) -> Vec<TimedMidiEvent> {
    let shift = end_us - start_us;
    let mut out: Vec<TimedMidiEvent> = Vec::new();
    let mut open: Vec<(u8, u8)> = Vec::new();
    let mut pedal: HashMap<u8, u8> = HashMap::new();

    for ev in events.iter().filter(|e| e.time_us < start_us) {
        if let Some((ch, key, _)) = as_note_on(&ev.bytes) {
            open.push((ch, key));
        } else if let Some((ch, key)) = as_note_off(&ev.bytes) {
            match open.iter().position(|n| *n == (ch, key)) {
                Some(pos) => {
                    open.remove(pos);
                }
                None => continue,
            }
        } else if let Some((ch, v)) = as_sustain(&ev.bytes) {
            pedal.insert(ch, v);
        }
        out.push(ev.clone());
    }
    // Cierre en start de notas y pedal abiertos antes del corte.
    for (ch, key) in open.drain(..) {
        out.push(TimedMidiEvent::new(start_us, note_off_msg(ch, key)));
    }
    let mut pedal_chs: Vec<u8> = pedal.iter().filter(|(_, v)| **v >= 64).map(|(c, _)| *c).collect();
    pedal_chs.sort();
    for ch in pedal_chs {
        out.push(TimedMidiEvent::new(start_us, sustain_msg(ch, 0)));
        pedal.insert(ch, 0);
    }
    // Eventos desde end (inclusive): desplazados; NoteOff solo si su NoteOn sobrevive.
    let mut last_t = start_us;
    for ev in events.iter().filter(|e| e.time_us >= end_us) {
        let t = ev.time_us - shift;
        if let Some((ch, key, _)) = as_note_on(&ev.bytes) {
            open.push((ch, key));
        } else if let Some((ch, key)) = as_note_off(&ev.bytes) {
            match open.iter().position(|n| *n == (ch, key)) {
                Some(pos) => {
                    open.remove(pos);
                }
                None => continue, // huérfano: su NoteOn fue eliminado
            }
        } else if let Some((ch, v)) = as_sustain(&ev.bytes) {
            pedal.insert(ch, v);
        }
        last_t = last_t.max(t);
        out.push(TimedMidiEvent::new(t, ev.bytes.clone()));
    }
    // Saneamiento: nada colgado al final del fichero.
    let tail = out.iter().map(|e| e.time_us).max().unwrap_or(0).max(last_t.min(start_us));
    for (ch, key) in open {
        out.push(TimedMidiEvent::new(tail, note_off_msg(ch, key)));
    }
    let mut pedal_chs: Vec<u8> = pedal.iter().filter(|(_, v)| **v >= 64).map(|(c, _)| *c).collect();
    pedal_chs.sort();
    for ch in pedal_chs {
        out.push(TimedMidiEvent::new(tail, sustain_msg(ch, 0)));
    }
    out
}

/// Extrae `[start_ms, end_ms)` a `dest` (normalizado a t=0) y elimina ese tramo de `source`.
pub fn extract_fragment_and_trim(
    source: &Path,
    start_ms: u64,
    end_ms: u64,
    dest: &Path,
    bpm: u32,
) -> Result<SliceResult, String> {
    let (events, dur_us) = read_timed_events_us(source)?;
    let duration_ms = us_to_ms(dur_us);
    let (start_ms, end_ms) = validate_range(start_ms, end_ms, duration_ms)?;
    let (start_us, end_us) = (start_ms * 1000, end_ms * 1000);

    let fragment = build_fragment(&events, start_us, end_us);
    write_smf_with_end(dest, &fragment, bpm, Some(end_us - start_us))?;

    let remaining_ms = duration_ms - (end_ms - start_ms);
    let trimmed = build_trimmed(&events, start_us, end_us);
    if let Err(e) = write_smf_with_end(source, &trimmed, bpm, Some(remaining_ms * 1000)) {
        let _ = std::fs::remove_file(dest);
        return Err(e);
    }
    Ok(SliceResult { fragment_duration_ms: end_ms - start_ms, remaining_duration_ms: remaining_ms })
}

/// Elimina `[start_ms, end_ms)` de `source` sin crear fragmento. Devuelve la nueva duración (ms).
pub fn discard_range(source: &Path, start_ms: u64, end_ms: u64, bpm: u32) -> Result<u64, String> {
    let (events, dur_us) = read_timed_events_us(source)?;
    let duration_ms = us_to_ms(dur_us);
    let (start_ms, end_ms) = validate_range(start_ms, end_ms, duration_ms)?;
    let remaining_ms = duration_ms - (end_ms - start_ms);
    let trimmed = build_trimmed(&events, start_ms * 1000, end_ms * 1000);
    write_smf_with_end(source, &trimmed, bpm, Some(remaining_ms * 1000))?;
    Ok(remaining_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note_on(ch: u8, key: u8, vel: u8) -> Vec<u8> {
        vec![0x90 | ch, key, vel]
    }

    /// Pista de 60 s: una nota cada 500 ms de 700 ms de duración (cruzan 10 s y 25 s),
    /// pedal pisado en 8 s y soltado en 27 s.
    fn build_test_track(path: &Path, bpm: u32) -> Vec<TimedMidiEvent> {
        let mut evs = Vec::new();
        evs.push(TimedMidiEvent::new(0, vec![0xC0, 0]));
        for i in 0..119u64 {
            let t = i * 500_000;
            let key = 60 + (i % 12) as u8;
            let vel = 40 + (i % 50) as u8;
            evs.push(TimedMidiEvent::new(t, note_on(0, key, vel)));
            evs.push(TimedMidiEvent::new(t + 700_000, note_off_msg(0, key)));
        }
        evs.push(TimedMidiEvent::new(8_000_000, sustain_msg(0, 127)));
        evs.push(TimedMidiEvent::new(27_000_000, sustain_msg(0, 0)));
        evs.push(TimedMidiEvent::new(60_000_000, sustain_msg(0, 0)));
        evs.sort_by_key(|e| e.time_us);
        write_smf(path, &evs, bpm).unwrap();
        evs
    }

    /// Comprueba que no hay notas colgadas ni NoteOff huérfanos y que el pedal termina en 0.
    fn assert_clean(events: &[TimedMidiEvent]) {
        let mut open: HashMap<(u8, u8), i32> = HashMap::new();
        let mut pedal: HashMap<u8, u8> = HashMap::new();
        for e in events {
            if let Some((ch, k, _)) = as_note_on(&e.bytes) {
                *open.entry((ch, k)).or_default() += 1;
            } else if let Some((ch, k)) = as_note_off(&e.bytes) {
                let c = open.entry((ch, k)).or_default();
                assert!(*c > 0, "NoteOff huérfano {:?} en {} us", e.bytes, e.time_us);
                *c -= 1;
            } else if let Some((ch, v)) = as_sustain(&e.bytes) {
                pedal.insert(ch, v);
            }
        }
        assert!(open.values().all(|c| *c == 0), "notas colgadas: {open:?}");
        assert!(pedal.values().all(|v| *v < 64), "pedal colgado: {pedal:?}");
    }

    fn approx(a: u64, b: u64) -> bool {
        a.abs_diff(b) <= 1
    }

    #[test]
    fn roundtrip_and_duration() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.mid");
        let src = build_test_track(&p, 120);
        let (evs, dur) = read_timed_events(&p).unwrap();
        assert_eq!(dur, 60_000);
        assert_eq!(evs.len(), src.len());
        assert_eq!(midi_duration_ms(&p).unwrap(), 60_000);
        for (a, b) in evs.iter().zip(src.iter()) {
            assert_eq!(a.bytes, b.bytes);
            assert!(a.time_us.abs_diff(b.time_us) <= 1000);
        }
    }

    #[test]
    fn extract_10_to_25_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw.mid");
        let frag = dir.path().join("frag.mid");
        let original = build_test_track(&raw, 120);
        let at30 = original.iter().find(|e| e.time_us == 30_000_000 && as_note_on(&e.bytes).is_some()).unwrap().clone();

        let r = extract_fragment_and_trim(&raw, 10_000, 25_000, &frag, 120).unwrap();
        assert_eq!(r.fragment_duration_ms, 15_000);
        assert_eq!(r.remaining_duration_ms, 45_000);

        let (fevs, fdur) = read_timed_events(&frag).unwrap();
        assert!(approx(fdur, 15_000), "fragmento dura {fdur}");
        assert_eq!(fevs[0].time_us, 0);
        let (ch, v) = as_sustain(&fevs[0].bytes).expect("primer evento CC64");
        assert_eq!(ch, 0);
        assert!(v >= 64);
        assert_clean(&fevs);
        assert!(fevs.iter().any(|e| as_note_on(&e.bytes).is_some()));
        assert!(approx(fevs.last().unwrap().time_us / 1000, 15_000));
        // La nota de 9.5 s (abierta antes de start) no aparece; la de 10 s sí, en t=0.
        assert!(fevs.iter().any(|e| e.time_us == 0 && as_note_on(&e.bytes).is_some()));

        let (revs, rdur) = read_timed_events(&raw).unwrap();
        assert!(approx(rdur, 45_000), "pista bruta dura {rdur}");
        assert_clean(&revs);
        let moved = revs
            .iter()
            .find(|e| e.bytes == at30.bytes && approx(e.time_us / 1000, 15_000))
            .expect("el evento de 30 s debe estar ahora en 15 s");
        assert!(as_note_on(&moved.bytes).is_some());
        assert_eq!(midi_duration_ms(&raw).unwrap(), rdur);
    }

    #[test]
    fn discard_range_shortens_track() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw.mid");
        build_test_track(&raw, 120);
        let d = discard_range(&raw, 5_000, 20_000, 120).unwrap();
        assert_eq!(d, 45_000);
        let (evs, dur) = read_timed_events(&raw).unwrap();
        assert!(approx(dur, 45_000));
        assert_clean(&evs);
        // Clamp: un fin más allá de la duración se recorta a la duración.
        let d2 = discard_range(&raw, 40_000, 999_999, 120).unwrap();
        assert_eq!(d2, 40_000);
        let (evs2, dur2) = read_timed_events(&raw).unwrap();
        assert!(approx(dur2, 40_000));
        assert_clean(&evs2);
    }

    #[test]
    fn invalid_ranges_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw.mid");
        let frag = dir.path().join("frag.mid");
        build_test_track(&raw, 120);
        assert!(extract_fragment_and_trim(&raw, 5_000, 5_000, &frag, 120).is_err());
        assert!(extract_fragment_and_trim(&raw, 6_000, 5_000, &frag, 120).is_err());
        assert!(extract_fragment_and_trim(&raw, 70_000, 80_000, &frag, 120).is_err());
        assert!(discard_range(&raw, 10, 1, 120).is_err());
        assert!(!frag.exists());
        assert_eq!(midi_duration_ms(&raw).unwrap(), 60_000);
        assert!(read_timed_events(&dir.path().join("nope.mid")).is_err());
    }

    #[test]
    fn activity_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("act.mid");
        // 0-2 s: 4 notas vel 100; 2-8 s: silencio; 8-10 s: 2 notas vel 50 y 70.
        let mut evs = Vec::new();
        for i in 0..4u64 {
            evs.push(TimedMidiEvent::new(i * 500_000, note_on(0, 60, 100)));
            evs.push(TimedMidiEvent::new(i * 500_000 + 400_000, note_off_msg(0, 60)));
        }
        evs.push(TimedMidiEvent::new(8_100_000, note_on(0, 64, 50)));
        evs.push(TimedMidiEvent::new(8_200_000, note_on(0, 67, 70)));
        evs.push(TimedMidiEvent::new(10_000_000, note_off_msg(0, 64)));
        evs.push(TimedMidiEvent::new(10_000_000, note_off_msg(0, 67)));
        write_smf(&p, &evs, 120).unwrap();

        let a = analyze_midi_activity(&p, 10).unwrap();
        assert_eq!(a.duration_ms, 10_000);
        assert_eq!(a.blocks.len(), 10);
        assert_eq!(a.blocks[0].start_ms, 0);
        assert_eq!(a.blocks[9].end_ms, 10_000);
        assert_eq!(a.blocks[0].note_count, 2);
        assert_eq!(a.blocks[1].note_count, 2);
        assert!((a.blocks[0].velocity_avg - 100.0).abs() < 1e-3);
        for b in &a.blocks[2..8] {
            assert_eq!(b.note_count, 0);
            assert_eq!(b.velocity_avg, 0.0);
        }
        assert_eq!(a.blocks[8].note_count, 2);
        assert!((a.blocks[8].velocity_avg - 60.0).abs() < 1e-3);
        let total: u32 = a.blocks.iter().map(|b| b.note_count).sum();
        assert_eq!(total, 6);

        // Con 200 bloques máximos y 10 s de duración → 100 bloques de 100 ms.
        let b = analyze_midi_activity(&p, 200).unwrap();
        assert_eq!(b.blocks.len(), 100);
        assert!(b.blocks.iter().all(|x| x.end_ms - x.start_ms == 100));

        // Fichero corto (250 ms) → 2 bloques; fichero vacío → sin bloques.
        let s = dir.path().join("short.mid");
        write_smf(&s, &[TimedMidiEvent::new(0, note_on(0, 60, 90)), TimedMidiEvent::new(250_000, note_off_msg(0, 60))], 120).unwrap();
        assert_eq!(analyze_midi_activity(&s, 200).unwrap().blocks.len(), 2);
        let e = dir.path().join("empty.mid");
        write_smf(&e, &[], 120).unwrap();
        let ea = analyze_midi_activity(&e, 200).unwrap();
        assert_eq!(ea.duration_ms, 0);
        assert!(ea.blocks.is_empty());
    }

    #[test]
    fn slicing_at_90_bpm() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw90.mid");
        let frag = dir.path().join("frag90.mid");
        build_test_track(&raw, 90);
        assert!(approx(midi_duration_ms(&raw).unwrap(), 60_000));
        let r = extract_fragment_and_trim(&raw, 10_000, 25_000, &frag, 90).unwrap();
        assert!(approx(r.remaining_duration_ms, 45_000));
        let (fevs, fdur) = read_timed_events(&frag).unwrap();
        assert!(approx(fdur, 15_000), "{fdur}");
        assert_clean(&fevs);
        let (revs, rdur) = read_timed_events(&raw).unwrap();
        assert!(approx(rdur, 45_000), "{rdur}");
        assert_clean(&revs);
    }

    #[test]
    fn reads_tempo_changes_across_tracks() {
        // Formato 1: pista 0 con tempo 120 → 60 BPM en el tick 960; pista 1 con notas.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("tempo.mid");
        let mut smf = Smf::new(Header::new(Format::Parallel, Timing::Metrical(u15::new(480))));
        smf.tracks.push(vec![
            TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(500_000))) },
            TrackEvent { delta: u28::new(960), kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(1_000_000))) },
            TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) },
        ]);
        let on = |key: u8| TrackEventKind::Midi {
            channel: u4::new(0),
            message: MidiMessage::NoteOn { key: u7::new(key), vel: u7::new(80) },
        };
        let off = |key: u8| TrackEventKind::Midi {
            channel: u4::new(0),
            message: MidiMessage::NoteOff { key: u7::new(key), vel: u7::new(0) },
        };
        smf.tracks.push(vec![
            TrackEvent { delta: u28::new(480), kind: on(60) },  // 0.5 s
            TrackEvent { delta: u28::new(960), kind: off(60) }, // tick 1440 → 1 s + 1 qn @60 = 2 s
            TrackEvent { delta: u28::new(480), kind: on(62) },  // tick 1920 → 3 s
            TrackEvent { delta: u28::new(960), kind: off(62) }, // tick 2880 → 5 s
            TrackEvent { delta: u28::new(480), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) }, // 6 s
        ]);
        let mut buf = Vec::new();
        smf.write_std(&mut buf).unwrap();
        std::fs::write(&p, buf).unwrap();

        let (evs, dur) = read_timed_events(&p).unwrap();
        let times: Vec<u64> = evs.iter().map(|e| e.time_us).collect();
        assert_eq!(times, vec![500_000, 2_000_000, 3_000_000, 5_000_000]);
        assert_eq!(dur, 6_000);

        // Re-escritura con BPM fijo conserva los tiempos reales.
        let frag = dir.path().join("tempo_frag.mid");
        let r = extract_fragment_and_trim(&p, 1_000, 4_000, &frag, 100).unwrap();
        assert_eq!(r.fragment_duration_ms, 3_000);
        assert_eq!(r.remaining_duration_ms, 3_000);
        let (fevs, _) = read_timed_events(&frag).unwrap();
        assert_clean(&fevs);
        // NoteOn de 62 en 3 s → 2 s en el fragmento; cerrado en 3 s.
        assert!(fevs.iter().any(|e| as_note_on(&e.bytes) == Some((0, 62, 80)) && approx(e.time_us / 1000, 2_000)));
        let (revs, rdur) = read_timed_events(&p).unwrap();
        assert!(approx(rdur, 3_000));
        assert_clean(&revs);
    }

    #[test]
    fn note_on_velocity_zero_is_note_off() {
        assert_eq!(as_note_off(&[0x93, 60, 0]), Some((3, 60)));
        assert_eq!(as_note_on(&[0x93, 60, 0]), None);
        assert_eq!(as_note_off(&[0x81, 61, 64]), Some((1, 61)));
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("v0.mid");
        write_smf(&p, &[TimedMidiEvent::new(0, note_on(0, 60, 90)), TimedMidiEvent::new(1_000_000, note_on(0, 60, 0)), TimedMidiEvent::new(2_000_000, vec![0xE0, 0x00, 0x40])], 120).unwrap();
        let frag = dir.path().join("f.mid");
        extract_fragment_and_trim(&p, 0, 1_500, &frag, 120).unwrap();
        let (fevs, _) = read_timed_events(&frag).unwrap();
        assert_clean(&fevs);
        let (revs, rdur) = read_timed_events(&p).unwrap();
        assert_eq!(rdur, 500);
        assert_eq!(revs.len(), 1); // solo el pitch bend
        assert_eq!(revs[0].bytes, vec![0xE0, 0x00, 0x40]);
    }
}
