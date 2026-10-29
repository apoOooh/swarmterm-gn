//! Whisper models for the built-in speech source (SWA-38). Not bundled: the
//! installer stays small and the user picks a size in Settings → Voice.
//!
//! The catalog is fixed — URL and SHA-256 are compiled in, so a download can
//! only ever produce one of these exact files. A download streams into a
//! `.part` file, hashes while writing and renames only after the hash
//! matched; a half-finished or tampered file never sits under the final name.
//! "Ready" therefore means "the file exists": the hash was checked once, on
//! the way in, and is not re-read (500 MB) on every status query.

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

// Corp compiles the download out (`speech::download`); this item then
// only serves tests. Models an administrator places in the folder still load.
#[cfg_attr(feature = "corp", allow(dead_code))]
const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/// Multilingual models only: the GN user dictates German and English.
/// Ordered from light to heavy; `recommend` picks one by hardware. The
/// unquantised tiny/base/small stay at the end so existing downloads and
/// settings keep working.
pub const CATALOG: &[ModelInfo] = &[
    ModelInfo {
        id: "small-q5",
        label: "Small q5 (190 MB, light CPUs)",
        file: "ggml-small-q5_1.bin",
        bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
    ModelInfo {
        id: "medium-q5",
        label: "Medium q5 (539 MB, 4-7 CPU threads)",
        file: "ggml-medium-q5_0.bin",
        bytes: 539_212_467,
        sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
    },
    ModelInfo {
        id: "large-v3-turbo-q5",
        label: "Large v3 Turbo q5 (547 MB, mid-range CPUs)",
        file: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
    ModelInfo {
        id: "large-v3-turbo-q8",
        label: "Large v3 Turbo q8 (874 MB, fast CPUs)",
        file: "ggml-large-v3-turbo-q8_0.bin",
        bytes: 874_188_075,
        sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    },
    ModelInfo {
        id: "large-v3-q5",
        label: "Large v3 q5 (1.1 GB, most accurate, workstations)",
        file: "ggml-large-v3-q5_0.bin",
        bytes: 1_081_140_203,
        sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
    },
    ModelInfo {
        id: "tiny",
        label: "Tiny (75 MB, legacy)",
        file: "ggml-tiny.bin",
        bytes: 77_691_713,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    },
    ModelInfo {
        id: "base",
        label: "Base (142 MB, legacy)",
        file: "ggml-base.bin",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    ModelInfo {
        id: "small",
        label: "Small (466 MB, legacy)",
        file: "ggml-small.bin",
        bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
];

pub fn find(id: &str) -> Option<&'static ModelInfo> {
    CATALOG.iter().find(|m| m.id == id)
}

// Corp compiles the download out (`speech::download`); this item then
// only serves tests. Models an administrator places in the folder still load.
#[cfg_attr(feature = "corp", allow(dead_code))]
pub fn url(model: &ModelInfo) -> String {
    format!("{BASE_URL}{}", model.file)
}

pub fn path(dir: &Path, model: &ModelInfo) -> PathBuf {
    dir.join(model.file)
}

// Corp compiles the download out (`speech::download`); this item then
// only serves tests. Models an administrator places in the folder still load.
#[cfg_attr(feature = "corp", allow(dead_code))]
fn part_path(dir: &Path, model: &ModelInfo) -> PathBuf {
    dir.join(format!("{}.part", model.file))
}

pub fn is_ready(dir: &Path, model: &ModelInfo) -> bool {
    path(dir, model).is_file()
}

// Corp compiles the download out (`speech::download`); this item then
// only serves tests. Models an administrator places in the folder still load.
#[cfg_attr(feature = "corp", allow(dead_code))]
/// Hashes as bytes arrive and moves the file into place only on a match.
/// Pure apart from the file system, so the hash gate is unit-tested without
/// a network.
pub struct PartFile {
    file: std::fs::File,
    hasher: Sha256,
    written: u64,
    part: PathBuf,
    target: PathBuf,
    expected: &'static str,
}

// Corp compiles the download out (`speech::download`); this item then
// only serves tests. Models an administrator places in the folder still load.
#[cfg_attr(feature = "corp", allow(dead_code))]
impl PartFile {
    pub fn create(dir: &Path, model: &'static ModelInfo) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
        let part = part_path(dir, model);
        let file = std::fs::File::create(&part).map_err(|e| format!("create: {e}"))?;
        Ok(Self {
            file,
            hasher: Sha256::new(),
            written: 0,
            part,
            target: path(dir, model),
            expected: model.sha256,
        })
    }

    pub fn write(&mut self, chunk: &[u8]) -> Result<u64, String> {
        self.file
            .write_all(chunk)
            .map_err(|e| format!("write: {e}"))?;
        self.hasher.update(chunk);
        self.written += chunk.len() as u64;
        Ok(self.written)
    }

    /// Hash check, then rename. On a mismatch the part file is deleted.
    pub fn finish(self) -> Result<PathBuf, String> {
        let Self {
            file,
            hasher,
            part,
            target,
            expected,
            ..
        } = self;
        let flushed = file.sync_all().map_err(|e| format!("flush: {e}"));
        drop(file);
        let digest = hex(&hasher.finalize());
        if let Err(e) = flushed {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
        if digest != expected {
            let _ = std::fs::remove_file(&part);
            return Err("checksum-mismatch".into());
        }
        std::fs::rename(&part, &target).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("rename: {e}")
        })?;
        Ok(target)
    }

    /// Cancelled or failed mid-way: nothing may stay behind.
    pub fn abandon(self) {
        let part = self.part.clone();
        drop(self);
        let _ = std::fs::remove_file(part);
    }
}

// Corp compiles the download out (`speech::download`); this item then
// only serves tests. Models an administrator places in the folder still load.
#[cfg_attr(feature = "corp", allow(dead_code))]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // sha256("abc")
    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn fake(sha256: &'static str) -> &'static ModelInfo {
        Box::leak(Box::new(ModelInfo {
            id: "fake",
            label: "Fake",
            file: "ggml-fake.bin",
            bytes: 3,
            sha256,
        }))
    }

    #[test]
    fn catalog_ids_are_unique_and_the_default_is_in_it() {
        assert!(find(crate::voice::settings::DEFAULT_MODEL).is_some());
        assert!(find("nope").is_none());
        for (i, m) in CATALOG.iter().enumerate() {
            assert_eq!(m.sha256.len(), 64);
            assert!(CATALOG[i + 1..].iter().all(|o| o.id != m.id));
            assert!(url(m).starts_with("https://huggingface.co/"));
        }
    }

    #[test]
    fn a_matching_hash_moves_the_file_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let model = fake(ABC);
        let mut part = PartFile::create(dir.path(), model).unwrap();
        part.write(b"ab").unwrap();
        assert_eq!(part.write(b"c").unwrap(), 3);
        assert!(!is_ready(dir.path(), model));
        part.finish().unwrap();
        assert!(is_ready(dir.path(), model));
        assert!(!part_path(dir.path(), model).exists());
    }

    #[test]
    fn a_wrong_hash_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let model = fake(ABC);
        let mut part = PartFile::create(dir.path(), model).unwrap();
        part.write(b"abd").unwrap();
        assert_eq!(part.finish().unwrap_err(), "checksum-mismatch");
        assert!(!is_ready(dir.path(), model));
        assert!(!part_path(dir.path(), model).exists());
    }

    #[test]
    fn abandon_removes_the_part_file() {
        let dir = tempfile::tempdir().unwrap();
        let model = fake(ABC);
        let mut part = PartFile::create(dir.path(), model).unwrap();
        part.write(b"a").unwrap();
        part.abandon();
        assert!(!part_path(dir.path(), model).exists());
    }
}
