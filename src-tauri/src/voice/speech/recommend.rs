//! Which catalog model fits this PC. Settings → Voice shows the suggestion
//! with its reason above the model list; the user still decides.
//!
//! The built-in source runs whisper.cpp on the CPU only, so the GPU does not
//! count here (buzzkey's own probe covers CUDA). `recommend` is pure and
//! unit-tested; `detect` only reads the machine.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hardware {
    /// Logical CPU threads.
    pub threads: usize,
    pub ram_gb: Option<u32>,
    pub avx2: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub model: &'static str,
    pub reason: String,
    /// e.g. "16 CPU threads, 32 GB RAM, AVX2".
    pub summary: String,
    /// Unix milliseconds of the measurement.
    pub measured_at: u64,
}

fn summary(hw: &Hardware) -> String {
    let mut parts = vec![format!("{} CPU threads", hw.threads)];
    if let Some(ram) = hw.ram_gb {
        parts.push(format!("{ram} GB RAM"));
    }
    parts.push(if hw.avx2 { "AVX2" } else { "no AVX2" }.into());
    parts.join(", ")
}

/// Pure: hardware in, model id and reason out.
pub fn recommend(hw: &Hardware, measured_at: u64) -> Recommendation {
    let ram = hw.ram_gb.unwrap_or(8);
    let (model, reason) = if hw.threads < 4 || ram < 8 || !hw.avx2 {
        (
            "small-q5",
            "Few CPU threads, little RAM or no AVX2: the small model keeps dictation quick.",
        )
    } else if hw.threads < 8 {
        (
            "medium-q5",
            "A 4-7 thread CPU handles the medium model in a few seconds per sentence; clearly more accurate than small.",
        )
    } else if hw.threads < 16 || ram < 16 {
        (
            "large-v3-turbo-q5",
            "Enough cores for Large v3 Turbo: near the best German and English accuracy at a usable speed.",
        )
    } else if hw.threads < 24 || ram < 32 {
        (
            "large-v3-turbo-q8",
            "A fast CPU with plenty of RAM runs Large v3 Turbo at higher precision without waiting.",
        )
    } else {
        (
            "large-v3-q5",
            "A workstation CPU: the full Large v3 model gives the best accuracy and still keeps up.",
        )
    };
    Recommendation {
        model,
        reason: reason.into(),
        summary: summary(hw),
        measured_at,
    }
}

pub fn detect() -> Hardware {
    Hardware {
        threads: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        ram_gb: ram_gb(),
        avx2: avx2(),
    }
}

fn avx2() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    return std::arch::is_x86_feature_detected!("avx2");
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    return true;
}

#[cfg(windows)]
fn ram_gb() -> Option<u32> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: `status` is a properly sized, writable MEMORYSTATUSEX.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return None;
    }
    // Round: 31.8 GB usable on a 32 GB machine counts as 32.
    Some(((status.ullTotalPhys as f64) / (1u64 << 30) as f64).round() as u32)
}

#[cfg(not(windows))]
fn ram_gb() -> Option<u32> {
    None
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(threads: usize, ram: u32, avx2: bool) -> &'static str {
        let hw = Hardware {
            threads,
            ram_gb: Some(ram),
            avx2,
        };
        recommend(&hw, 0).model
    }

    #[test]
    fn heavier_models_for_stronger_machines() {
        assert_eq!(pick(2, 8, true), "small-q5");
        assert_eq!(pick(8, 4, true), "small-q5");
        assert_eq!(pick(16, 32, false), "small-q5");
        assert_eq!(pick(4, 8, true), "medium-q5");
        assert_eq!(pick(8, 16, true), "large-v3-turbo-q5");
        assert_eq!(pick(16, 8, true), "large-v3-turbo-q5");
        assert_eq!(pick(16, 32, true), "large-v3-turbo-q8");
        assert_eq!(pick(24, 16, true), "large-v3-turbo-q8");
        assert_eq!(pick(24, 32, true), "large-v3-q5");
    }

    #[test]
    fn every_recommendation_is_in_the_catalog_and_explained() {
        for threads in [1, 4, 8, 16, 32] {
            for ram in [4, 16, 64] {
                let hw = Hardware {
                    threads,
                    ram_gb: Some(ram),
                    avx2: true,
                };
                let r = recommend(&hw, 7);
                assert!(super::super::model::find(r.model).is_some(), "{}", r.model);
                assert!(!r.reason.is_empty());
                assert!(r.summary.contains("CPU threads"));
                assert_eq!(r.measured_at, 7);
            }
        }
    }
}
