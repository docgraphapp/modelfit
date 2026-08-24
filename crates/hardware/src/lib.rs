//! ModelFit hardware detection.
//!
//! Detects CPU, memory, GPU, disk, and acceleration capabilities. All values
//! are best-effort: anything we can't determine is `None`, and the UI lets the
//! user confirm/edit detected specs (that screen is the fallback for fuzzy
//! cases like AMD/Intel VRAM or iGPU shared memory).

use serde::Serialize;
use sysinfo::{Disks, System};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub cpu_model: String,
    pub physical_cores: usize,
    pub logical_cores: usize,
    pub total_ram_gb: f64,
    pub available_ram_gb: f64,
    pub disk_available_gb: f64,
    /// Apple Silicon: CPU and GPU share one memory pool. When true, the GPU's
    /// usable memory is the system RAM pool, not a dedicated VRAM figure.
    pub unified_memory: bool,
    pub gpus: Vec<GpuInfo>,
    /// Available acceleration backends: "metal", "cuda", "rocm", "vulkan", "cpu".
    pub accelerations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub vendor: String,
    pub name: String,
    /// Dedicated VRAM. `None` when unknown or when memory is unified/shared.
    pub vram_gb: Option<f64>,
    /// Apple GPU core count, when detectable.
    pub core_count: Option<u32>,
}

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

pub fn detect() -> HardwareInfo {
    let mut sys = System::new_all();
    sys.refresh_all();

    let cpu_model = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".into());

    // macOS reports available_memory() as 0 on some versions; fall back to
    // total - used. Conservative (inactive/cache pages count as used but are
    // reclaimable) — fit math primarily budgets against total RAM anyway.
    let available_ram = if sys.available_memory() > 0 {
        sys.available_memory()
    } else {
        sys.total_memory().saturating_sub(sys.used_memory())
    };

    let disks = Disks::new_with_refreshed_list();
    // Largest available space among real disks — where models would land.
    let disk_available_gb = disks
        .iter()
        .map(|d| d.available_space() as f64 / GIB)
        .fold(0.0, f64::max);

    let mut info = HardwareInfo {
        os: std::env::consts::OS.to_string(),
        os_version: System::long_os_version().unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_model,
        physical_cores: sys.physical_core_count().unwrap_or(0),
        logical_cores: sys.cpus().len(),
        total_ram_gb: round1(sys.total_memory() as f64 / GIB),
        available_ram_gb: round1(available_ram as f64 / GIB),
        disk_available_gb: round1(disk_available_gb),
        unified_memory: false,
        gpus: Vec::new(),
        accelerations: vec!["cpu".into()],
    };

    platform::enrich(&mut info);
    info
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::process::Command;

    pub fn enrich(info: &mut HardwareInfo) {
        if info.arch == "aarch64" {
            // Apple Silicon: unified memory — the GPU sees the whole RAM pool.
            info.unified_memory = true;
            info.accelerations.push("metal".into());
            info.gpus.push(GpuInfo {
                vendor: "Apple".into(),
                name: format!("{} GPU", info.cpu_model),
                vram_gb: Some(info.total_ram_gb),
                core_count: gpu_core_count(),
            });
        } else {
            // Intel Mac: Metal still available; GPU details left for the
            // confirm/edit screen (small and shrinking user base).
            info.accelerations.push("metal".into());
        }
    }

    /// `ioreg` exposes `gpu-core-count` for Apple Silicon.
    fn gpu_core_count() -> Option<u32> {
        let out = Command::new("ioreg")
            .args(["-r", "-c", "AGXAccelerator", "-d", "1"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(rest) = line.split("\"gpu-core-count\"").nth(1) {
                let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = digits.parse() {
                    return Some(n);
                }
            }
        }
        None
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn enrich(info: &mut HardwareInfo) {
        // Windows/Linux GPU detection (NVML for NVIDIA, DXGI/sysfs for
        // AMD/Intel) lands in M6. Until then the confirm/edit screen covers it.
        let _ = info;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_returns_sane_values() {
        let hw = detect();
        assert!(!hw.cpu_model.is_empty());
        assert!(hw.logical_cores > 0);
        assert!(hw.total_ram_gb > 0.0);
        assert!(hw.available_ram_gb <= hw.total_ram_gb);
        assert!(hw.accelerations.contains(&"cpu".to_string()));
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            assert!(hw.unified_memory);
            assert!(hw.accelerations.contains(&"metal".to_string()));
            assert_eq!(hw.gpus.len(), 1);
        }
    }
}
