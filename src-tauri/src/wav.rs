//! 16-bit PCM WAV writer, streamed: samples are written as they are rendered (a long take does
//! not fit in memory as `f32`), and the RIFF sizes are patched when finishing. It writes to a
//! temporary file next to the destination and renames it at the end, like the MIDI files.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const HEADER_LEN: u32 = 44;

pub struct WavWriter {
    out: BufWriter<File>,
    tmp: PathBuf,
    dest: PathBuf,
    channels: u16,
    data_bytes: u64,
}

fn io_err(path: &Path, e: std::io::Error) -> String {
    t!("backend.io.write", path = path.display(), e = e)
}

fn header(sample_rate: u32, channels: u16, data_bytes: u32) -> [u8; HEADER_LEN as usize] {
    let block_align = channels * 2;
    let mut h = [0u8; HEADER_LEN as usize];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(HEADER_LEN - 8 + data_bytes).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&channels.to_le_bytes());
    h[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&(sample_rate * block_align as u32).to_le_bytes());
    h[32..34].copy_from_slice(&block_align.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

impl WavWriter {
    pub fn create(dest: &Path, sample_rate: u32, channels: u16) -> Result<Self, String> {
        if let Some(dir) = dest.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| t!("backend.io.createDir", path = dir.display(), e = e))?;
        }
        let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "out.wav".into());
        let tmp = dest.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
        let file = File::create(&tmp).map_err(|e| io_err(&tmp, e))?;
        let mut out = BufWriter::new(file);
        // Placeholder: the sizes are written in `finish`.
        out.write_all(&header(sample_rate, channels, 0)).map_err(|e| io_err(&tmp, e))?;
        Ok(WavWriter { out, tmp, dest: dest.to_path_buf(), channels, data_bytes: 0 })
    }

    /// Interleaved samples in [-1, 1] (clamped).
    pub fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        let mut buf = Vec::with_capacity(samples.len() * 2);
        for s in samples {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            buf.extend_from_slice(&v.to_le_bytes());
        }
        self.out.write_all(&buf).map_err(|e| io_err(&self.tmp, e))?;
        self.data_bytes += buf.len() as u64;
        Ok(())
    }

    pub fn frames(&self) -> u64 {
        self.data_bytes / (self.channels as u64 * 2)
    }

    /// Writes the sizes and moves the file to its destination.
    pub fn finish(mut self, sample_rate: u32) -> Result<PathBuf, String> {
        let result = (|| -> Result<(), String> {
            let data = u32::try_from(self.data_bytes).map_err(|_| t!("backend.export.tooLong"))?;
            self.out.flush().map_err(|e| io_err(&self.tmp, e))?;
            let file = self.out.get_mut();
            file.seek(SeekFrom::Start(0)).map_err(|e| io_err(&self.tmp, e))?;
            file.write_all(&header(sample_rate, self.channels, data)).map_err(|e| io_err(&self.tmp, e))?;
            file.sync_all().map_err(|e| io_err(&self.tmp, e))?;
            std::fs::rename(&self.tmp, &self.dest).map_err(|e| io_err(&self.dest, e))
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_file(&self.tmp);
            return Err(e);
        }
        Ok(self.dest.clone())
    }
}

impl Drop for WavWriter {
    /// A writer dropped without `finish` (an error halfway) leaves no temporary file behind.
    fn drop(&mut self) {
        if self.tmp.exists() {
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_valid_header_and_samples() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out").join("a.wav");
        let mut w = WavWriter::create(&dest, 48_000, 2).unwrap();
        w.write(&[0.0, 1.0, -1.0, 2.0]).unwrap();
        w.write(&[0.5, -0.5]).unwrap();
        assert_eq!(w.frames(), 3);
        assert_eq!(w.finish(48_000).unwrap(), dest);

        let b = std::fs::read(&dest).unwrap();
        assert_eq!(b.len(), 44 + 12);
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 36 + 12);
        assert_eq!(&b[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes(b[22..24].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(b[24..28].try_into().unwrap()), 48_000);
        assert_eq!(u32::from_le_bytes(b[28..32].try_into().unwrap()), 48_000 * 4);
        assert_eq!(u32::from_le_bytes(b[40..44].try_into().unwrap()), 12);
        let samples: Vec<i16> = b[44..].chunks(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(samples, vec![0, 32767, -32767, 32767, 16384, -16384]);
        // No temporary files left.
        assert_eq!(std::fs::read_dir(dest.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn dropping_without_finish_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.wav");
        let mut w = WavWriter::create(&dest, 44_100, 2).unwrap();
        w.write(&[0.1, 0.1]).unwrap();
        drop(w);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
