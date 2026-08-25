//! Headless probe: real hardware detection + real recommendations as JSON.
//! Used by the browser design harness to show real machine data without the
//! Tauri shell: `cargo run -p modelfit-recommendation --example probe`.

use modelfit_recommendation::{recommend, Objective, Request};
use modelfit_registry::Registry;

fn grid(
    hw: &modelfit_hardware::HardwareInfo,
    registry: &Registry,
    measured: Option<f64>,
) -> serde_json::Map<String, serde_json::Value> {
    let objectives = [
        ("overall", Objective::Overall),
        ("quality", Objective::Quality),
        ("speed", Objective::Speed),
        ("coding", Objective::Coding),
    ];
    let contexts: [u32; 6] = [4096, 8192, 16384, 32768, 65536, 131072];
    let mut recs = serde_json::Map::new();
    for (name, obj) in objectives {
        let mut by_ctx = serde_json::Map::new();
        for ctx in contexts {
            let r = recommend(
                hw,
                registry,
                &Request {
                    objective: obj,
                    context_length: ctx,
                    measured_effective_bandwidth_gbps: measured,
                },
            );
            by_ctx.insert(ctx.to_string(), serde_json::to_value(&r).unwrap());
        }
        recs.insert(name.into(), by_ctx.into());
    }
    recs
}

fn main() {
    let hw = modelfit_hardware::detect();
    let registry = Registry::bundled();

    let mut out = serde_json::json!({
        "hardware": hw,
        "registryVersion": registry.version,
        "modelCount": registry.models.len(),
        "recommendations": grid(&hw, &registry, None),
    });

    // Optional: `--measured <gbps> <tag> <gen_tps> <prompt_tps>` (numbers from
    // the runtime-adapters `calibrate` example) adds the post-benchmark state
    // so the browser harness can play the calibration flow honestly.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--measured") {
        let bw: f64 = args[i + 1].parse().expect("--measured <gbps> <tag> <gen> <prompt>");
        let tag = args[i + 2].clone();
        let gen: f64 = args[i + 3].parse().expect("gen tok/s");
        let prompt: f64 = args[i + 4].parse().expect("prompt tok/s");
        out["recommendationsMeasured"] = grid(&hw, &registry, Some(bw)).into();
        out["calibration"] = serde_json::json!({
            "modelTag": tag,
            "genTokPerSec": gen,
            "promptTokPerSec": prompt,
            "effectiveBandwidthGbps": bw,
        });
    }

    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
