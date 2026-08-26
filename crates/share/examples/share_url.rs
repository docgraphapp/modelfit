//! Print the real "Share my benchmark" URL for this machine, using the same
//! builder the app ships. Lets the prefilled GitHub form be checked end to end
//! without driving the GUI: `cargo run -p modelfit-share --example share_url`.

use modelfit_share::build_benchmark_share;
use modelfit_registry::Registry;
use modelfit_runtime_adapters::Calibration;

fn main() {
    let hw = modelfit_hardware::detect();
    let cal = Calibration {
        model_tag: "llama3.2:3b".into(),
        gen_tok_per_sec: 96.4,
        prompt_tok_per_sec: 412.7,
        effective_bandwidth_gbps: 187.3,
    };
    let share = build_benchmark_share(&hw, &cal, "0.1.0", &Registry::bundled().version);
    for f in &share.fields {
        println!("{:<28} {}", f.label, f.value);
    }
    println!("\n{}", share.url);
}
