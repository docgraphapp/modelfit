//! Headless probe: real hardware detection + real recommendations as JSON.
//! Used by the browser design harness to show real machine data without the
//! Tauri shell: `cargo run -p modelfit-recommendation --example probe`.

use modelfit_recommendation::{recommend, Objective, Request};
use modelfit_registry::Registry;

fn main() {
    let hw = modelfit_hardware::detect();
    let registry = Registry::bundled();

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
                &hw,
                &registry,
                &Request {
                    objective: obj,
                    context_length: ctx,
                    measured_effective_bandwidth_gbps: None,
                },
            );
            by_ctx.insert(ctx.to_string(), serde_json::to_value(&r).unwrap());
        }
        recs.insert(name.into(), by_ctx.into());
    }

    let out = serde_json::json!({
        "hardware": hw,
        "registryVersion": registry.version,
        "modelCount": registry.models.len(),
        "recommendations": recs,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
