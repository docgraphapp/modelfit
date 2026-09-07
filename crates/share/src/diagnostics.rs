//! The "Copy diagnostics" payload: everything needed to explain a number the
//! app produced, in a form that can be pasted into a bug report.
//!
//! Sibling of the benchmark share and held to the same rule — hardware and
//! timing facts only, never paths, hostnames, or anything about what the
//! machine is used for. It carries more than the benchmark share (runtime
//! state, the bandwidth basis) because it goes to us, on purpose, once.
//!
//! The bandwidth line is the point of the whole thing: almost every "why does
//! it say N tok/s" report is answered by which tier that number came from.

use modelfit_hardware::HardwareInfo;
use modelfit_recommendation::{bandwidth_estimate, usable_memory_gb};
use modelfit_runtime_adapters::{Calibration, RuntimeStatus};

/// Everything the caller must supply; the shape keeps the argument list from
/// turning into six positional strings.
pub struct Diagnostics<'a> {
    pub hardware: &'a HardwareInfo,
    pub runtime: &'a RuntimeStatus,
    pub calibration: Option<&'a Calibration>,
    pub app_version: &'a str,
    pub registry_version: &'a str,
    pub registry_model_count: usize,
    /// "bundled" or "updated" — a stale registry explains a missing model.
    pub registry_source: &'a str,
}

fn gpu_line(hw: &HardwareInfo) -> String {
    if hw.gpus.is_empty() {
        return "none detected".into();
    }
    hw.gpus
        .iter()
        .map(|g| {
            let mut s = if g.name.to_lowercase().contains(&g.vendor.to_lowercase()) {
                g.name.clone()
            } else {
                format!("{} {}", g.vendor, g.name)
            };
            // On unified memory the "VRAM" figure is the system pool again,
            // already on the Memory row; repeating it there misdescribes the
            // machine to whoever reads the report.
            if let Some(v) = g.vram_gb.filter(|_| !hw.unified_memory) {
                s.push_str(&format!(" · {v:.0} GB VRAM"));
            }
            if let Some(c) = g.core_count {
                s.push_str(&format!(" · {c} cores"));
            }
            s
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Render the diagnostics as a Markdown table, ready to paste into an issue.
pub fn build_diagnostics(d: &Diagnostics) -> String {
    let hw = d.hardware;
    // No measurement is passed here: this reports what the app would assume
    // for a model it has never run, which is the case people report on.
    let bw = bandwidth_estimate(hw, d.calibration.map(|c| c.effective_bandwidth_gbps));

    let mut rows: Vec<(String, String)> = vec![
        ("App".into(), d.app_version.to_string()),
        (
            "Registry".into(),
            format!(
                "{} · {} models · {}",
                d.registry_version, d.registry_model_count, d.registry_source
            ),
        ),
        (
            "OS".into(),
            format!("{} {} ({})", hw.os, hw.os_version, hw.arch),
        ),
        (
            "CPU".into(),
            format!(
                "{} · {} cores ({} logical)",
                hw.cpu_model, hw.physical_cores, hw.logical_cores
            ),
        ),
        (
            "Memory".into(),
            format!(
                "{:.0} GB{} · {:.1} GB available",
                hw.total_ram_gb,
                if hw.unified_memory { " unified" } else { "" },
                hw.available_ram_gb
            ),
        ),
        ("GPU".into(), gpu_line(hw)),
        ("Acceleration".into(), hw.accelerations.join(", ")),
        (
            "Usable memory".into(),
            format!("{:.1} GB (what the engine budgets)", usable_memory_gb(hw)),
        ),
        (
            "Bandwidth".into(),
            format!("{:.0} GB/s · {:?} · {}", bw.value, bw.confidence, bw.basis),
        ),
        (
            "Runtime".into(),
            if d.runtime.running {
                format!(
                    "Ollama {} · {} model(s) installed",
                    d.runtime.version.as_deref().unwrap_or("(version unknown)"),
                    d.runtime.installed_tags.len()
                )
            } else {
                "Ollama not running".into()
            },
        ),
    ];
    rows.push((
        "Benchmark".into(),
        match d.calibration {
            Some(c) => format!(
                "{} · {:.0} tok/s generation · {} · {:.0} GB/s effective · {}",
                c.model_tag,
                c.gen_tok_per_sec,
                // Zero means the runtime served the prompt from cache or gave
                // no timing — not that it processed zero tokens per second.
                if c.prompt_tok_per_sec > 0.0 {
                    format!("{:.0} tok/s prompt", c.prompt_tok_per_sec)
                } else {
                    "prompt not measured".into()
                },
                c.effective_bandwidth_gbps,
                match c.prefill_capacity {
                    // Without this there is no time-to-first-token anywhere in
                    // the app, which is worth saying out loud in a report.
                    Some(p) => format!("prefill {p:.0} B-params·tok/s"),
                    None => "no prefill timing".into(),
                }
            ),
            None => "not run".into(),
        },
    ));

    let mut out = String::from("### ModelFit diagnostics\n\n| | |\n|---|---|\n");
    for (k, v) in rows {
        // A stray pipe from a chip or tag name would split the row.
        out.push_str(&format!("| {} | {} |\n", k, v.replace('|', "\\|")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use modelfit_hardware::GpuInfo;

    fn hw() -> HardwareInfo {
        HardwareInfo {
            os: "macos".into(),
            os_version: "15.6".into(),
            arch: "aarch64".into(),
            cpu_model: "Apple M4 Pro".into(),
            physical_cores: 12,
            logical_cores: 12,
            total_ram_gb: 48.0,
            available_ram_gb: 21.4,
            disk_available_gb: 500.0,
            unified_memory: true,
            gpus: vec![GpuInfo {
                vendor: "Apple".into(),
                name: "Apple M4 Pro GPU".into(),
                vram_gb: Some(48.0),
                core_count: Some(20),
            }],
            accelerations: vec!["cpu".into(), "metal".into()],
        }
    }

    fn render(cal: Option<&Calibration>, runtime: &RuntimeStatus) -> String {
        build_diagnostics(&Diagnostics {
            hardware: &hw(),
            runtime,
            calibration: cal,
            app_version: "0.1.0",
            registry_version: "2026-08-25",
            registry_model_count: 19,
            registry_source: "bundled",
        })
    }

    fn stopped() -> RuntimeStatus {
        RuntimeStatus {
            running: false,
            version: None,
            installed_tags: vec![],
        }
    }

    #[test]
    fn reports_the_state_that_explains_a_number() {
        let out = render(None, &stopped());
        assert!(out.contains("Apple M4 Pro"));
        assert!(out.contains("48 GB unified"));
        assert!(out.contains("Usable memory"));
        // The bandwidth tier and its basis are the point of the report.
        assert!(out.contains("Estimated"));
        assert!(out.contains("spec-sheet"));
        assert!(out.contains("Ollama not running"));
        assert!(out.contains("| Benchmark | not run |"));
    }

    #[test]
    fn a_run_benchmark_replaces_the_spec_sheet_basis() {
        let cal = Calibration {
            model_tag: "llama3.2:3b".into(),
            gen_tok_per_sec: 96.4,
            prompt_tok_per_sec: 412.7,
            effective_bandwidth_gbps: 187.3,
            prefill_capacity: Some(1320.6),
        };
        let out = render(
            Some(&cal),
            &RuntimeStatus {
                running: true,
                version: Some("0.5.1".into()),
                installed_tags: vec!["llama3.2:3b".into()],
            },
        );
        assert!(out.contains("Calibrated"));
        assert!(out.contains("187 GB/s"));
        assert!(!out.contains("spec-sheet"));
        assert!(out.contains("Ollama 0.5.1 · 1 model(s) installed"));
        assert!(out.contains("prefill 1321 B-params·tok/s"));
        assert!(out.contains("413 tok/s prompt"));
    }

    #[test]
    fn a_prompt_served_from_cache_is_reported_as_unmeasured() {
        // Zero is "the runtime told us nothing usable", not "zero tok/s".
        // A report that prints it as a rate sends us chasing a performance
        // problem that does not exist.
        let cal = Calibration {
            model_tag: "llama3.2:3b".into(),
            gen_tok_per_sec: 96.4,
            prompt_tok_per_sec: 0.0,
            effective_bandwidth_gbps: 187.3,
            prefill_capacity: None,
        };
        let out = render(Some(&cal), &stopped());
        assert!(out.contains("prompt not measured"));
        assert!(!out.contains("0 tok/s prompt"));
        assert!(out.contains("no prefill timing"));
    }

    #[test]
    fn unified_memory_does_not_report_a_second_vram_figure() {
        // The pool is already on the Memory row; calling it VRAM as well
        // would describe a machine that does not exist.
        assert!(!render(None, &stopped()).contains("VRAM"));
    }

    #[test]
    fn a_pipe_in_a_value_cannot_split_the_table() {
        let mut h = hw();
        h.cpu_model = "Weird | Chip".into();
        let out = build_diagnostics(&Diagnostics {
            hardware: &h,
            runtime: &stopped(),
            calibration: None,
            app_version: "0.1.0",
            registry_version: "2026-08-25",
            registry_model_count: 19,
            registry_source: "bundled",
        });
        let cpu_row = out.lines().find(|l| l.starts_with("| CPU ")).unwrap();
        assert!(cpu_row.contains("Weird \\| Chip"));
        // Only the two delimiters and the one between the columns are live
        // pipes; the one inside the value is escaped and does not count.
        let live_pipes = cpu_row
            .char_indices()
            .filter(|(i, c)| *c == '|' && !cpu_row[..*i].ends_with('\\'))
            .count();
        assert_eq!(live_pipes, 3, "row stays two columns: {cpu_row}");
    }
}
