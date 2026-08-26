//! The "Share my benchmark" payload: the fields published and the prefilled
//! GitHub issue URL that carries them.
//!
//! Deliberately free of Tauri so the thing that actually ships can be built and
//! checked anywhere — `scripts/check-benchmark-form.py` runs the example in CI
//! to prove the field ids still match .github/ISSUE_TEMPLATE/benchmark.yml.

use modelfit_hardware::HardwareInfo;
use modelfit_runtime_adapters::Calibration;
use serde::Serialize;

/// Where "Share my benchmark" posts. A GitHub issue form is the whole backend:
/// sharing is opt-in and public by construction, there is nothing to host, and
/// nothing is sent until the user presses Submit on GitHub's own page.
const BENCHMARK_ISSUE_URL: &str = "https://github.com/docgraphapp/modelfit/issues/new";

/// One prefilled field, shown in the preview and carried in the URL.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareField {
    /// Matches the field id in .github/ISSUE_TEMPLATE/benchmark.yml.
    pub id: String,
    pub label: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkShare {
    pub fields: Vec<ShareField>,
    pub url: String,
}

/// Percent-encode for a query value (RFC 3986 unreserved set kept as-is).
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Build the benchmark share: the exact fields that would be published, and
/// the prefilled issue URL carrying them.
///
/// Assembled here rather than in the webview for two reasons: the preview the
/// user approves is then literally the payload that ships, and the field list
/// cannot be widened from the frontend. Only hardware and timing facts are
/// included — never paths, hostnames, free disk, or anything about what the
/// machine is being used for.
pub fn build_benchmark_share(
    hardware: &HardwareInfo,
    calibration: &Calibration,
    app_version: &str,
    registry_version: &str,
) -> BenchmarkShare {
    // Vendor and name often already overlap ("Apple" + "Apple M4 Pro GPU"),
    // and this text is going somewhere public — so only prepend the vendor
    // when the name does not already carry it.
    let join_once = |prefix: &str, name: &str| {
        if name.to_lowercase().contains(&prefix.to_lowercase()) {
            name.to_string()
        } else {
            format!("{prefix} {name}")
        }
    };

    let gpu = match hardware.gpus.first() {
        Some(g) => {
            let mut s = join_once(&g.vendor, &g.name);
            // On unified memory there is no dedicated VRAM — the figure is
            // just the system pool again, already reported under Memory, and
            // calling it VRAM would misdescribe the machine to a reader.
            if let Some(v) = g.vram_gb.filter(|_| !hardware.unified_memory) {
                s.push_str(&format!(" · {v:.0} GB VRAM"));
            }
            if let Some(c) = g.core_count {
                s.push_str(&format!(" · {c} cores"));
            }
            s.trim().to_string()
        }
        None => "none detected".to_string(),
    };

    let f = |id: &str, label: &str, value: String| ShareField {
        id: id.into(),
        label: label.into(),
        value,
    };
    let fields = vec![
        f("chip", "CPU / chip", hardware.cpu_model.clone()),
        f(
            "ram",
            "Memory",
            format!(
                "{:.0} GB{}",
                hardware.total_ram_gb,
                if hardware.unified_memory { " unified" } else { "" }
            ),
        ),
        f("gpu", "GPU", gpu),
        f("accel", "Acceleration", hardware.accelerations.join(", ")),
        f(
            "os",
            "OS",
            format!(
                "{} ({})",
                join_once(&hardware.os, &hardware.os_version),
                hardware.arch
            ),
        ),
        f("model", "Benchmarked model", calibration.model_tag.clone()),
        f(
            "gen_tps",
            "Generation tokens/sec",
            format!("{:.1}", calibration.gen_tok_per_sec),
        ),
        f(
            "prompt_tps",
            "Prompt tokens/sec",
            format!("{:.1}", calibration.prompt_tok_per_sec),
        ),
        f(
            "bandwidth",
            "Effective bandwidth (GB/s)",
            format!("{:.1}", calibration.effective_bandwidth_gbps),
        ),
        f(
            "versions",
            "App / registry",
            format!("{} · {}", app_version, registry_version),
        ),
    ];

    let mut url = format!("{BENCHMARK_ISSUE_URL}?template=benchmark.yml&labels=benchmark");
    url.push_str(&format!(
        "&title={}",
        pct(&format!(
            "[benchmark] {} · {}",
            hardware.cpu_model, calibration.model_tag
        ))
    ));
    for field in &fields {
        url.push_str(&format!("&{}={}", field.id, pct(&field.value)));
    }

    BenchmarkShare { fields, url }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pct_encodes_what_would_break_a_query_string() {
        // Chip names and Ollama tags routinely carry spaces, colons and dots;
        // an unencoded & or # would truncate or fragment the prefilled issue.
        assert_eq!(pct("Apple M4 Pro"), "Apple%20M4%20Pro");
        assert_eq!(pct("llama3.2:3b"), "llama3.2%3A3b");
        assert_eq!(pct("a&b#c=d"), "a%26b%23c%3Dd");
        // Unreserved characters must survive untouched.
        assert_eq!(pct("Q4_K_M-x.y~z"), "Q4_K_M-x.y~z");
        // Multi-byte input is encoded per UTF-8 byte, not per char.
        assert_eq!(pct("·"), "%C2%B7");
    }
}
