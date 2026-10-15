//! Generador de un SoundFont 2 de piano acústico compacto, sintetizado en memoria.
//!
//! Garantiza que `rustysynth` funcione 100% offline desde el primer arranque
//! (TASKS 1.3). El fichero resultante contiene un único preset "Acoustic Piano"
//! (banco 0, programa 0) con 7 muestras (una por octava, raíces C1..C7) sintetizadas
//! de forma aditiva con parciales inarmónicos (B·n²), decaimiento por parcial más
//! rápido en agudos, transitorio de martillo con ruido y bucle sin discontinuidad
//! en la parte sostenida.

use std::f64::consts::PI;
use std::io::Cursor;
use std::path::{Path, PathBuf};

/// Frecuencia de muestreo de las muestras generadas.
const SAMPLE_RATE: u32 = 44_100;
/// Notas raíz (MIDI) de cada muestra: C1, C2, ..., C7.
const ROOT_KEYS: [u8; 7] = [24, 36, 48, 60, 72, 84, 96];
/// Puntos de ceros de guarda tras cada muestra (exigidos por la especificación SF2).
const GUARD_POINTS: usize = 46;
/// Duración objetivo del bucle (s). Fija la resolución de frecuencia de los parciales (1/LOOP_SECS Hz).
const LOOP_SECS: f64 = 0.5;

const PRESET_NAME: &str = "Acoustic Piano";
const INSTRUMENT_NAME: &str = "Piano";

// Generadores SF2 usados.
const GEN_REVERB_SEND: u16 = 16;
const GEN_ATTACK_VOL_ENV: u16 = 34;
const GEN_DECAY_VOL_ENV: u16 = 36;
const GEN_SUSTAIN_VOL_ENV: u16 = 37;
const GEN_RELEASE_VOL_ENV: u16 = 38;
const GEN_KEYNUM_TO_VOL_ENV_DECAY: u16 = 40;
const GEN_INSTRUMENT: u16 = 41;
const GEN_KEY_RANGE: u16 = 43;
const GEN_SAMPLE_ID: u16 = 53;
const GEN_SAMPLE_MODES: u16 = 54;
const GEN_OVERRIDING_ROOT_KEY: u16 = 58;

struct SynthSample {
    name: String,
    data: Vec<i16>,
    loop_start: usize,
    loop_end: usize,
    root: u8,
    pitch_correction: i8,
}

/// Generador pseudoaleatorio determinista (xorshift) para el ruido del martillo.
struct XorShift(u64);
impl XorShift {
    fn next_f64(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
    }
}

fn key_to_hz(key: f64) -> f64 {
    440.0 * 2f64.powf((key - 69.0) / 12.0)
}

/// Sintetiza la muestra de una nota raíz.
fn synth_sample(root: u8, max_shift_semitones: f64) -> SynthSample {
    let sr = SAMPLE_RATE as f64;
    let f0 = key_to_hz(root as f64);
    // Bucle de longitud L con un número entero de periodos de la fundamental:
    // todos los parciales se cuantizan a múltiplos de sr/L → la zona de bucle es periódica.
    let periods = (LOOP_SECS * f0).round().max(1.0);
    let loop_len = (periods * sr / f0).round() as usize;
    let df = sr / loop_len as f64;
    let f1 = periods * df;
    let cents = 1200.0 * (f1 / f0).log2();
    let pitch_correction = (-cents).round().clamp(-99.0, 99.0) as i8;

    let lowness = (96.0 - root as f64) / 72.0; // 1 en C1, 0 en C7
    let attack_secs = 0.3 + 0.5 * lowness;
    let nominal_loop_start = (attack_secs * sr) as usize;
    let max_freq = (0.42 * sr) / 2f64.powf(max_shift_semitones / 12.0);
    let inharm_b = 1.0e-4 * 2f64.powf((root as f64 - 24.0) / 18.0);
    let tau_base = 1.4 * 2f64.powf(-(root as f64 - 60.0) / 24.0);
    let tilt = 0.9 + 0.6 * (1.0 - lowness);

    struct Partial {
        freq: f64,
        amp: f64,
        tau: f64,
        phase: f64,
    }
    let mut rng = XorShift(0x9E37_79B9_7F4A_7C15 ^ root as u64);
    let mut partials: Vec<Partial> = Vec::new();
    let mut last_bin = 0i64;
    for n in 1..=40u32 {
        let nf = n as f64;
        let ideal = nf * f1 * (1.0 + inharm_b * nf * nf).sqrt();
        if ideal >= max_freq {
            break;
        }
        let bin = ((ideal / df).round() as i64).max(last_bin + 1);
        last_bin = bin;
        let freq = bin as f64 * df;
        if freq >= max_freq {
            break;
        }
        // Espectro: caída ~1/n^tilt con muesca por posición del martillo.
        let amp = nf.powf(-tilt) * (0.55 + 0.45 * (PI * nf / 7.3).sin().abs());
        let tau = tau_base / (1.0 + 0.28 * (nf - 1.0));
        partials.push(Partial { freq, amp, tau, phase: (rng.next_f64() + 1.0) * PI });
        // Segunda cuerda ligeramente desafinada (un paso de rejilla) → batido suave.
        if n <= 6 {
            let freq2 = (bin + 1) as f64 * df;
            if freq2 < max_freq {
                partials.push(Partial { freq: freq2, amp: amp * 0.18, tau, phase: (rng.next_f64() + 1.0) * PI });
            }
        }
    }

    // Render en f64: tramo de ataque (amplitudes decayendo) + tramo estacionario periódico.
    let render_len = nominal_loop_start + loop_len + (sr / f0) as usize + 16;
    let freeze_t = nominal_loop_start as f64 / sr;
    let mut buf = vec![0f64; render_len];
    for p in &partials {
        let w = 2.0 * PI * p.freq / sr;
        let frozen = p.amp * (-freeze_t / p.tau).exp();
        let decay_per_sample = (-1.0 / (p.tau * sr)).exp();
        let mut a = p.amp;
        // Oscilador por recurrencia de rotación (más rápido que sin() por muestra),
        // re-sincronizado periódicamente para evitar deriva numérica.
        let (mut s, mut c) = p.phase.sin_cos();
        let (sw, cw) = w.sin_cos();
        for (i, out) in buf.iter_mut().enumerate() {
            if i % 4096 == 0 {
                let ph = p.phase + w * i as f64;
                s = ph.sin();
                c = ph.cos();
            }
            let amp = if i < nominal_loop_start { a } else { frozen };
            *out += amp * s;
            let ns = s * cw + c * sw;
            c = c * cw - s * sw;
            s = ns;
            a *= decay_per_sample;
        }
    }
    // Transitorio del martillo: ruido filtrado con envolvente muy corta (< 60 ms).
    let mut lp = 0.0;
    let cutoff = (0.08 + 0.5 * (1.0 - lowness)).min(0.6);
    let transient_len = (0.06 * sr) as usize;
    for (i, out) in buf.iter_mut().take(transient_len).enumerate() {
        let t = i as f64 / sr;
        lp += cutoff * (rng.next_f64() - lp);
        let env = 0.35 * (-t / 0.004).exp() * (1.0 - i as f64 / transient_len as f64);
        *out += env * lp;
    }
    // Fundido de entrada de 1 ms para evitar clics por fase inicial.
    let ramp = (0.001 * sr) as usize;
    for (i, out) in buf.iter_mut().take(ramp).enumerate() {
        *out *= i as f64 / ramp as f64;
    }

    // Inicio de bucle en un cruce por cero ascendente dentro del primer periodo estacionario.
    let period = (sr / f0).ceil() as usize + 1;
    let mut loop_start = nominal_loop_start;
    let mut best = f64::MAX;
    for i in nominal_loop_start..(nominal_loop_start + period).min(render_len - loop_len - 9) {
        if buf[i] <= 0.0 && buf[i + 1] > 0.0 {
            let v = buf[i].abs().min(buf[i + 1].abs());
            if v < best {
                best = v;
                loop_start = if buf[i].abs() <= buf[i + 1].abs() { i } else { i + 1 };
            }
        }
    }
    let loop_end = loop_start + loop_len;
    let end = loop_end + 8; // unos puntos tras el bucle (iguales al inicio por periodicidad)
    buf.truncate(end);

    let peak = buf.iter().fold(0.0f64, |m, v| m.max(v.abs())).max(1e-9);
    let gain = 0.85 * i16::MAX as f64 / peak;
    let data = buf.iter().map(|v| (v * gain).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16).collect();

    let octave = root as i32 / 12 - 1;
    SynthSample { name: format!("Piano C{octave}"), data, loop_start, loop_end, root, pitch_correction }
}

// ---------------------------------------------------------------------------
// Serialización RIFF
// ---------------------------------------------------------------------------

fn chunk(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 9);
    out.extend_from_slice(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
    out
}

fn list(kind: &[u8; 4], subchunks: &[Vec<u8>]) -> Vec<u8> {
    let mut body = kind.to_vec();
    for c in subchunks {
        body.extend_from_slice(c);
    }
    chunk(b"LIST", &body)
}

/// Cadena terminada en cero y de longitud par.
fn zstr(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    if v.len() % 2 == 1 {
        v.push(0);
    }
    v
}

/// Nombre de longitud fija (20 bytes, terminado en cero).
fn name20(s: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    for (o, b) in out.iter_mut().zip(s.bytes().take(19)) {
        *o = b;
    }
    out
}

fn push_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn push_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn push_gen(v: &mut Vec<u8>, gen: u16, amount: u16) {
    push_u16(v, gen);
    push_u16(v, amount);
}

/// Genera un SoundFont 2 válido en memoria con el preset "Acoustic Piano" (banco 0, programa 0).
pub fn build_piano_sf2() -> Vec<u8> {
    // --- Muestras -------------------------------------------------------
    let n = ROOT_KEYS.len();
    let mut samples = Vec::with_capacity(n);
    let mut ranges = Vec::with_capacity(n);
    for (i, &root) in ROOT_KEYS.iter().enumerate() {
        let lo: u8 = if i == 0 { 0 } else { root - 6 };
        let hi: u8 = if i + 1 == n { 127 } else { root + 5 };
        // La última muestra cubre hasta 127, pero se limita el espectro pensando en C8 (108).
        let max_shift = (hi.min(108) as f64 - root as f64).max(0.0);
        samples.push(synth_sample(root, max_shift));
        ranges.push((lo, hi));
    }

    let mut smpl: Vec<u8> = Vec::new();
    let mut shdr: Vec<u8> = Vec::new();
    let mut offset: u32 = 0;
    for s in &samples {
        for v in &s.data {
            smpl.extend_from_slice(&v.to_le_bytes());
        }
        smpl.extend(std::iter::repeat(0u8).take(GUARD_POINTS * 2));
        let start = offset;
        let end = offset + s.data.len() as u32;
        shdr.extend_from_slice(&name20(&s.name));
        push_u32(&mut shdr, start);
        push_u32(&mut shdr, end);
        push_u32(&mut shdr, start + s.loop_start as u32);
        push_u32(&mut shdr, start + s.loop_end as u32);
        push_u32(&mut shdr, SAMPLE_RATE);
        shdr.push(s.root);
        shdr.push(s.pitch_correction as u8);
        push_u16(&mut shdr, 0); // sampleLink
        push_u16(&mut shdr, 1); // monoSample
        offset = end + GUARD_POINTS as u32;
    }
    shdr.extend_from_slice(&name20("EOS"));
    shdr.extend(std::iter::repeat(0u8).take(26));

    // --- Instrumento ----------------------------------------------------
    let mut igen: Vec<u8> = Vec::new();
    let mut ibag: Vec<u8> = Vec::new();
    let mut gen_count: u16 = 0;
    // Zona global: envolvente de volumen tipo piano.
    push_u16(&mut ibag, gen_count);
    push_u16(&mut ibag, 0);
    let global: [(u16, i16); 6] = [
        (GEN_REVERB_SEND, 150),             // 15 % de reverberación
        (GEN_ATTACK_VOL_ENV, -10_000),      // ~3 ms
        (GEN_DECAY_VOL_ENV, 4_600),         // ~14 s en C4
        (GEN_SUSTAIN_VOL_ENV, 1_000),       // 100 dB: la nota se extingue sola como un piano
        (GEN_RELEASE_VOL_ENV, -1_200),      // ~0.5 s
        (GEN_KEYNUM_TO_VOL_ENV_DECAY, 60),  // agudos decaen más rápido (×1.5 por octava)
    ];
    for (g, a) in global {
        push_gen(&mut igen, g, a as u16);
        gen_count += 1;
    }
    for (i, s) in samples.iter().enumerate() {
        push_u16(&mut ibag, gen_count);
        push_u16(&mut ibag, 0);
        let (lo, hi) = ranges[i];
        push_gen(&mut igen, GEN_KEY_RANGE, lo as u16 | ((hi as u16) << 8));
        push_gen(&mut igen, GEN_OVERRIDING_ROOT_KEY, s.root as u16);
        push_gen(&mut igen, GEN_SAMPLE_MODES, 1);
        push_gen(&mut igen, GEN_SAMPLE_ID, i as u16);
        gen_count += 4;
    }
    push_u16(&mut ibag, gen_count); // terminal
    push_u16(&mut ibag, 0);
    push_gen(&mut igen, 0, 0); // terminal

    let mut inst: Vec<u8> = Vec::new();
    inst.extend_from_slice(&name20(INSTRUMENT_NAME));
    push_u16(&mut inst, 0);
    inst.extend_from_slice(&name20("EOI"));
    push_u16(&mut inst, (n + 1) as u16);

    // --- Preset ---------------------------------------------------------
    let mut phdr: Vec<u8> = Vec::new();
    for (name, preset, bank, bag) in [(PRESET_NAME, 0u16, 0u16, 0u16), ("EOP", 0, 0, 1)] {
        phdr.extend_from_slice(&name20(name));
        push_u16(&mut phdr, preset);
        push_u16(&mut phdr, bank);
        push_u16(&mut phdr, bag);
        push_u32(&mut phdr, 0);
        push_u32(&mut phdr, 0);
        push_u32(&mut phdr, 0);
    }
    let mut pbag: Vec<u8> = Vec::new();
    push_u16(&mut pbag, 0);
    push_u16(&mut pbag, 0);
    push_u16(&mut pbag, 1); // terminal
    push_u16(&mut pbag, 0);
    let mut pgen: Vec<u8> = Vec::new();
    push_gen(&mut pgen, GEN_INSTRUMENT, 0);
    push_gen(&mut pgen, 0, 0); // terminal
    let modulator_terminal = vec![0u8; 10];

    // --- Ensamblado -----------------------------------------------------
    let mut ifil = Vec::new();
    push_u16(&mut ifil, 2);
    push_u16(&mut ifil, 1);
    let info = list(
        b"INFO",
        &[
            chunk(b"ifil", &ifil),
            chunk(b"isng", &zstr("EMU8000")),
            chunk(b"INAM", &zstr("Piano Tracker Acoustic Piano")),
            chunk(b"ISFT", &zstr("piano-tracker sf2_builder")),
        ],
    );
    let sdta = list(b"sdta", &[chunk(b"smpl", &smpl)]);
    let pdta = list(
        b"pdta",
        &[
            chunk(b"phdr", &phdr),
            chunk(b"pbag", &pbag),
            chunk(b"pmod", &modulator_terminal),
            chunk(b"pgen", &pgen),
            chunk(b"inst", &inst),
            chunk(b"ibag", &ibag),
            chunk(b"imod", &modulator_terminal),
            chunk(b"igen", &igen),
            chunk(b"shdr", &shdr),
        ],
    );
    let mut body = b"sfbk".to_vec();
    body.extend_from_slice(&info);
    body.extend_from_slice(&sdta);
    body.extend_from_slice(&pdta);
    chunk(b"RIFF", &body)
}

/// `true` si los bytes son un SoundFont que `rustysynth` puede cargar y tiene al menos un preset.
pub fn is_valid_soundfont(bytes: &[u8]) -> bool {
    match rustysynth::SoundFont::new(&mut Cursor::new(bytes)) {
        Ok(sf) => !sf.get_presets().is_empty(),
        Err(_) => false,
    }
}

/// Garantiza que existe un SoundFont válido en `path`. Si no existe o `rustysynth` no puede
/// cargarlo, genera uno con `build_piano_sf2` y lo escribe de forma atómica (tmp + rename).
pub fn ensure_soundfont(path: &Path) -> Result<PathBuf, String> {
    if path.is_file() {
        match std::fs::read(path) {
            Ok(bytes) if is_valid_soundfont(&bytes) => return Ok(path.to_path_buf()),
            Ok(_) => log::warn!("SoundFont inválido en {}: se regenera", path.display()),
            Err(e) => log::warn!("No se pudo leer {}: {e}; se regenera", path.display()),
        }
    }
    let bytes = build_piano_sf2();
    crate::midi_slicer::atomic_write(path, &bytes)?;
    log::info!("SoundFont de piano generado en {} ({} bytes)", path.display(), bytes.len());
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};
    use std::sync::{Arc, OnceLock};

    fn sf2() -> &'static Vec<u8> {
        static CELL: OnceLock<Vec<u8>> = OnceLock::new();
        CELL.get_or_init(build_piano_sf2)
    }

    fn synth() -> Synthesizer {
        let sf = Arc::new(SoundFont::new(&mut Cursor::new(sf2())).unwrap());
        Synthesizer::new(&sf, &SynthesizerSettings::new(44_100)).unwrap()
    }

    fn render(s: &mut Synthesizer, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut l = vec![0f32; frames];
        let mut r = vec![0f32; frames];
        s.render(&mut l, &mut r);
        (l, r)
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    #[test]
    fn soundfont_loads_with_expected_structure() {
        let bytes = sf2();
        println!("SF2 generado: {} bytes", bytes.len());
        assert!(bytes.len() < 3 * 1024 * 1024, "SF2 demasiado grande: {}", bytes.len());
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"sfbk");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize, bytes.len() - 8);
        let sf = SoundFont::new(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(sf.get_presets().len(), 1);
        let p = &sf.get_presets()[0];
        assert_eq!(p.get_name(), PRESET_NAME);
        assert_eq!(p.get_bank_number(), 0);
        assert_eq!(p.get_patch_number(), 0);
        assert_eq!(sf.get_instruments().len(), 1);
        assert_eq!(sf.get_instruments()[0].get_regions().len(), ROOT_KEYS.len());
        assert_eq!(sf.get_sample_headers().len(), ROOT_KEYS.len());
        for h in sf.get_sample_headers() {
            assert!(h.get_start() < h.get_start_loop());
            assert!(h.get_start_loop() < h.get_end_loop());
            assert!(h.get_end_loop() < h.get_end());
            // 46 ceros de guarda tras cada muestra.
            let wave = sf.get_wave_data();
            let end = h.get_end() as usize;
            assert!(wave[end..end + GUARD_POINTS].iter().all(|v| *v == 0));
        }
        assert!(is_valid_soundfont(bytes));
        assert!(!is_valid_soundfont(b"RIFF\0\0\0\0junk"));
    }

    #[test]
    fn renders_audible_note_and_releases_to_silence() {
        let mut s = synth();
        s.note_on(0, 60, 100);
        let (l, r) = render(&mut s, 22_050);
        assert!(rms(&l) > 0.01 && rms(&r) > 0.01, "rms={}", rms(&l));
        assert!(l.iter().chain(r.iter()).all(|v| v.is_finite() && v.abs() <= 1.0));
        s.note_off(0, 60);
        let _ = render(&mut s, 88_200);
        let (l, r) = render(&mut s, 4_410);
        let peak = l.iter().chain(r.iter()).fold(0f32, |m, v| m.max(v.abs()));
        assert!(peak < 1e-3, "peak tras release = {peak}");
    }

    #[test]
    fn sustained_notes_loop_without_dying_early_and_pitch_is_correct() {
        // A4 (69): estimación de f0 por autocorrelación ≈ 440 Hz.
        let mut s = synth();
        s.note_on(0, 69, 100);
        let _ = render(&mut s, 44_100); // pasa el ataque y entra en el bucle
        let (l, _) = render(&mut s, 8_192);
        assert!(rms(&l) > 0.003, "la nota sostenida debe seguir sonando (bucle), rms={}", rms(&l));
        let best_lag = (60..200)
            .max_by(|a, b| {
                let ca: f32 = (0..4096).map(|i| l[i] * l[i + a]).sum();
                let cb: f32 = (0..4096).map(|i| l[i] * l[i + b]).sum();
                ca.partial_cmp(&cb).unwrap()
            })
            .unwrap();
        let f = 44_100.0 / best_lag as f32;
        assert!((f - 440.0).abs() < 8.0, "f0 estimada {f}");
        // Nota extrema grave y aguda también suenan.
        for key in [21, 108] {
            let mut s = synth();
            s.note_on(0, key, 90);
            let (l, _) = render(&mut s, 11_025);
            assert!(rms(&l) > 0.005, "key {key} rms={}", rms(&l));
        }
    }

    #[test]
    fn ensure_soundfont_creates_and_keeps_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("assets").join("default_piano.sf2");
        let p = ensure_soundfont(&path).unwrap();
        assert_eq!(p, path);
        assert!(path.is_file());
        let bytes = std::fs::read(&path).unwrap();
        assert!(is_valid_soundfont(&bytes));
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        ensure_soundfont(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), mtime, "no debe reescribir");
        // Un fichero corrupto se regenera.
        std::fs::write(&path, b"no soy un sf2").unwrap();
        ensure_soundfont(&path).unwrap();
        assert!(is_valid_soundfont(&std::fs::read(&path).unwrap()));
        // No quedan temporales.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
    }
}
