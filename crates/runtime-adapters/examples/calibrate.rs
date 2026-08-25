//! Headless calibration test: replicates the desktop `run_calibration`
//! command against the live local Ollama so the benchmark path can be
//! exercised without the Tauri shell:
//! `cargo run -p modelfit-runtime-adapters --example calibrate`

use modelfit_registry::Registry;
use modelfit_runtime_adapters::{
    calibration_candidates, gb_per_token, Ollama, RuntimeAdapter,
};

#[tokio::main]
async fn main() {
    let registry = Registry::bundled();
    let ollama = Ollama::default();

    let status = ollama.status().await;
    println!("ollama running={} version={:?}", status.running, status.version);
    println!("installed: {:?}", status.installed_tags);
    if !status.running {
        eprintln!("Ollama is not running");
        std::process::exit(1);
    }

    let (installed_pick, fallback) = calibration_candidates(&registry, &status.installed_tags);
    println!("installed_pick={installed_pick:?} fallback={fallback:?}");
    let tag = match installed_pick {
        Some(t) => t,
        None => {
            println!("nothing suitable installed — would pull {fallback} (skipping pull in test)");
            std::process::exit(2);
        }
    };

    println!("measuring via {tag} …");
    let start = std::time::Instant::now();
    match ollama.measure(&tag).await {
        Ok(m) => {
            let gb_tok = gb_per_token(&registry, &tag);
            println!(
                "ok in {:.1}s: gen={:.1} tok/s prompt={:.0} tok/s gb/token={:?}",
                start.elapsed().as_secs_f64(),
                m.gen_tok_per_sec,
                m.prompt_tok_per_sec,
                gb_tok
            );
            match gb_tok {
                Some(g) => println!(
                    "effective bandwidth = {:.1} GB/s",
                    m.gen_tok_per_sec * g
                ),
                None => println!("BUG: {tag} not resolvable in registry → run_calibration would error"),
            }
        }
        Err(e) => println!("measure failed: {e}"),
    }
}
