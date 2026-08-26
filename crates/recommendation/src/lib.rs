//! ModelFit recommendation engine.
//!
//! Pure math over (hardware × registry × request) — no I/O, no runtime
//! dependency. Pipeline per the requirements doc:
//!
//!   hard constraints (fits with headroom, clears speed floor)
//!     → weighted quality/speed score on survivors
//!     → BEST / SAFE / FAST picks
//!
//! Key correctness rules (see REQUIREMENTS.md FR-3/FR-4):
//! - MoE: memory uses total params, speed uses ACTIVE params.
//! - Context length is an input; KV cache is computed from it.
//! - Excluded models carry a human-readable reason ("explainable").

use modelfit_hardware::HardwareInfo;
use modelfit_registry::{Model, Quant, Registry, DEFAULT_QUANT};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Objective {
    Overall,
    Quality,
    Speed,
    Coding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub objective: Objective,
    /// Requested context window (tokens). Drives KV-cache memory.
    pub context_length: u32,
    /// From the calibration benchmark: the machine's measured effective
    /// bandwidth (GB/s). When present it replaces the per-chip estimate ×
    /// efficiency guess, and speed estimates are labeled "measured".
    #[serde(default)]
    pub measured_effective_bandwidth_gbps: Option<f64>,
}

impl Default for Request {
    fn default() -> Self {
        Request {
            objective: Objective::Overall,
            context_length: 8192,
            measured_effective_bandwidth_gbps: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FitVerdict {
    /// ≤ 80% of usable memory: recommended zone.
    Comfortable,
    /// Fits with the required 10% headroom but above 80%.
    Tight,
    /// Does not fit at the requested context.
    TooBig,
}

/// A rung richer than the one assessed that this machine can also run.
/// Presented as a choice — the quality it buys is real but not modelled, so
/// it must not move the score that ranks models against each other.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantOption {
    pub quant: String,
    pub est_memory_gb: f64,
    pub est_tok_per_sec: f64,
    pub ollama_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub model_id: String,
    pub name: String,
    pub quant: String,
    pub ollama_tag: Option<String>,
    pub est_memory_gb: f64,
    pub est_tok_per_sec: f64,
    pub fit: FitVerdict,
    pub quality: f64,
    /// 0–100, only meaningful for included models.
    pub score: f64,
    /// Present iff the model is excluded from recommendations.
    pub excluded_reason: Option<String>,
    /// "high" | "medium" — MoE throughput and unknown-bandwidth machines are medium.
    pub confidence: String,
    /// Richer rungs that also fit, smallest first. Empty when the assessed
    /// quant is already the richest this machine can hold.
    #[serde(default)]
    pub also_fits: Vec<QuantOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendations {
    pub best: Option<Assessment>,
    pub safe: Option<Assessment>,
    pub fast: Option<Assessment>,
    /// Every model, assessed (included and excluded), sorted by score.
    pub all: Vec<Assessment>,
    pub usable_memory_gb: f64,
    pub bandwidth_gbps: f64,
    pub bandwidth_measured: bool,
}

/// Fixed inference-runtime overhead (llama.cpp/Ollama buffers, scratch).
const RUNTIME_OVERHEAD_GB: f64 = 1.5;
/// Required headroom: a model must fit within 90% of usable memory.
const FIT_FRACTION: f64 = 0.90;
/// "Comfortable" (SAFE zone) threshold.
const COMFORT_FRACTION: f64 = 0.80;
/// Fraction of theoretical bandwidth real inference achieves.
const BANDWIDTH_EFFICIENCY: f64 = 0.55;
/// MoE routing/expert-switch penalty on top of the dense estimate.
const MOE_EFFICIENCY: f64 = 0.7;
/// FAST pick must still be a decent model.
const FAST_MIN_QUALITY: f64 = 7.0;

fn speed_floor(objective: Objective) -> f64 {
    match objective {
        Objective::Overall | Objective::Quality => 5.0,
        Objective::Coding => 8.0,
        Objective::Speed => 15.0,
    }
}

fn weights(objective: Objective) -> (f64, f64) {
    // (quality_weight, speed_weight)
    match objective {
        Objective::Overall => (0.6, 0.4),
        Objective::Quality => (0.8, 0.2),
        Objective::Speed => (0.3, 0.7),
        Objective::Coding => (0.7, 0.3),
    }
}

fn quality_for(model: &Model, objective: Objective) -> f64 {
    match objective {
        Objective::Coding => model.quality.coding,
        _ => model.quality.general,
    }
}

/// Memory the model can actually claim for weights + KV.
///
/// Unified memory (Apple Silicon): the GPU sees the whole pool, but the OS and
/// apps need a share — budget 70% of total RAM. Discrete GPU: dedicated VRAM.
/// CPU-only: 60% of system RAM.
pub fn usable_memory_gb(hw: &HardwareInfo) -> f64 {
    if hw.unified_memory {
        hw.total_ram_gb * 0.70
    } else if let Some(vram) = hw.gpus.first().and_then(|g| g.vram_gb) {
        vram * 0.95
    } else {
        hw.total_ram_gb * 0.60
    }
}

/// Effective memory bandwidth (GB/s) — the main predictor of tokens/sec.
///
/// Static per-chip estimates until the calibration benchmark (M4) measures the
/// real value; returns (bandwidth, was_estimated_from_known_chip).
pub fn estimate_bandwidth_gbps(hw: &HardwareInfo) -> (f64, bool) {
    let cpu = hw.cpu_model.to_lowercase();
    // Apple Silicon spec sheet numbers (LPDDR bandwidth is the GPU's too).
    const APPLE: &[(&str, f64)] = &[
        ("m4 max", 546.0), ("m3 max", 400.0), ("m2 max", 400.0), ("m1 max", 400.0),
        ("m4 pro", 273.0), ("m2 pro", 200.0), ("m1 pro", 200.0), ("m3 pro", 150.0),
        ("m2 ultra", 800.0), ("m1 ultra", 800.0), ("m3 ultra", 819.0),
        ("m4", 120.0), ("m3", 102.0), ("m2", 100.0), ("m1", 68.0),
    ];
    if hw.unified_memory {
        for (pat, bw) in APPLE {
            if cpu.contains(pat) {
                return (*bw, true);
            }
        }
        return (100.0, false);
    }
    // Discrete GPUs: conservative default until NVML/calibration (M4/M6).
    if hw.gpus.iter().any(|g| g.vram_gb.is_some()) {
        (300.0, false)
    } else {
        // CPU-only: dual-channel DDR4/DDR5 ballpark.
        (50.0, false)
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

pub fn recommend(hw: &HardwareInfo, registry: &Registry, req: &Request) -> Recommendations {
    let usable = usable_memory_gb(hw);
    let (est_bandwidth, known_chip) = estimate_bandwidth_gbps(hw);
    // Measured effective bandwidth (calibration) beats the chip-table
    // estimate × efficiency guess.
    let (effective_bw, measured) = match req.measured_effective_bandwidth_gbps {
        Some(m) if m > 1.0 => (m, true),
        _ => (est_bandwidth * BANDWIDTH_EFFICIENCY, false),
    };
    let (wq, ws) = weights(req.objective);
    let floor = speed_floor(req.objective);
    // Guard against nonsense input from the UI layer.
    let req = Request {
        objective: req.objective,
        context_length: req.context_length.clamp(512, 1 << 20),
        measured_effective_bandwidth_gbps: req.measured_effective_bandwidth_gbps,
    };

    let mut all: Vec<Assessment> = Vec::new();

    for model in &registry.models {
        // Quants step DOWN, never up: the baseline rung when it fits, else the
        // largest rung that does. Climbing into spare headroom would be wrong
        // here — quality is modelled per model, not per quant, so a richer
        // quant scores identical quality while being measurably slower, which
        // would penalise precisely the models a capable machine handles best.
        // Offering the richer rung is a separate decision for the user to make
        // with the trade-off in front of them, not one to fold into the score.
        let ctx = req.context_length.min(model.max_context) as f64;
        let mem_of = |q: &Quant| q.file_size_gb + q.kv_cache_gb_per_1k_ctx * ctx / 1024.0
            + RUNTIME_OVERHEAD_GB;
        let fits_comfy = |m: f64| m <= usable * COMFORT_FRACTION;

        let mut chosen: Option<(&String, f64)> = None; // (quant, est_memory)
        let mut smallest: Option<(&String, f64)> = None;
        for (qname, q) in &model.quantizations {
            let mem = mem_of(q);
            if smallest.as_ref().map_or(true, |(_, m)| mem < *m) {
                smallest = Some((qname, mem));
            }
            // Below the baseline, prefer the largest rung that still fits.
            let better = chosen.as_ref().map_or(true, |(_, m)| mem > *m);
            if fits_comfy(mem) && better {
                chosen = Some((qname, mem));
            }
        }
        // The baseline wins whenever it fits, whatever richer rungs exist.
        if let Some((qname, q)) = model.quantizations.get_key_value(DEFAULT_QUANT) {
            let mem = mem_of(q);
            if fits_comfy(mem) {
                chosen = Some((qname, mem));
            }
        }
        // If no quant is comfortable, assess the smallest one — it either
        // fits Tight (still recommendable) or proves the model TooBig.
        let (quant, est_memory) = chosen.unwrap_or_else(|| {
            let (qname, mem) = smallest.expect("model has at least one quant");
            (qname, mem)
        });

        let fit = if est_memory <= usable * COMFORT_FRACTION {
            FitVerdict::Comfortable
        } else if est_memory <= usable * FIT_FRACTION {
            FitVerdict::Tight
        } else {
            FitVerdict::TooBig
        };

        // Speed: effective bandwidth / bytes each token touches.
        let tok_s_of = |q: &Quant| {
            let bytes_per_weight = q.file_size_gb / model.parameters_b;
            let mut t = effective_bw / (model.speed_params_b() * bytes_per_weight);
            if model.is_moe() {
                t *= MOE_EFFICIENCY;
            }
            t
        };
        let tok_s = tok_s_of(&model.quantizations[quant]);

        // Richer rungs the machine can also hold, offered as alternatives.
        let also_fits: Vec<QuantOption> = model
            .quantizations
            .iter()
            .filter(|(_, q)| q.file_size_gb > model.quantizations[quant].file_size_gb)
            .filter(|(_, q)| fits_comfy(mem_of(q)))
            .map(|(qname, q)| QuantOption {
                quant: qname.clone(),
                est_memory_gb: round1(mem_of(q)),
                est_tok_per_sec: round1(tok_s_of(q)),
                ollama_tag: model.install_tag(qname),
            })
            .collect();

        let quality = quality_for(model, req.objective);

        // Hard constraints — explainable exclusions.
        let mut excluded_reason = None;
        if req.context_length > model.max_context {
            excluded_reason = Some(format!(
                "max context is {}k, you asked for {}k",
                model.max_context / 1024,
                req.context_length / 1024
            ));
        } else if fit == FitVerdict::TooBig {
            // Two flavors so the message never looks self-contradictory:
            // rounding "needs 16.2, usable 16.8" to integers reads as
            // "needs 16 of 17" — which sounds like it should fit.
            excluded_reason = Some(if est_memory <= usable {
                format!(
                    "needs ~{:.1} GB — too close to your {:.1} GB usable memory ({:.0}% headroom required)",
                    est_memory,
                    usable,
                    (1.0 - FIT_FRACTION) * 100.0
                )
            } else {
                format!(
                    "needs ~{:.1} GB, your usable memory is {:.1} GB",
                    est_memory, usable
                )
            });
        } else if tok_s < floor {
            excluded_reason = Some(format!(
                "estimated {:.0} tok/s — below the {:.0} tok/s floor for this objective",
                tok_s, floor
            ));
        } else if req.objective == Objective::Coding
            && !model.capabilities.iter().any(|c| c == "coding")
        {
            excluded_reason = Some("not a coding-capable model".into());
        }

        // Weighted score (0–100). Quality is normalized over the range real
        // local models occupy (~5–10), not 0–10 — otherwise a 1-point quality
        // gap (large) weighs less than a speed gap the user barely feels.
        // Speed saturates at 20 tok/s: beyond comfortable reading speed,
        // faster stops mattering for interactive use.
        let qn = ((quality - 5.0) / 5.0).clamp(0.0, 1.0);
        let sn = (tok_s / 20.0).clamp(0.0, 1.0);
        let score = if excluded_reason.is_some() {
            0.0
        } else {
            (wq * qn + ws * sn) * 100.0
        };

        let confidence = if model.is_moe() {
            "medium" // routing overhead varies even with a measured baseline
        } else if measured {
            "measured"
        } else if known_chip {
            "high"
        } else {
            "medium"
        };

        all.push(Assessment {
            model_id: model.id.clone(),
            name: model.name.clone(),
            quant: quant.clone(),
            ollama_tag: model.install_tag(quant),
            est_memory_gb: round1(est_memory),
            est_tok_per_sec: round1(tok_s),
            fit,
            quality,
            score: round1(score),
            excluded_reason,
            confidence: confidence.into(),
            also_fits,
        });
    }

    all.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

    let included = |a: &&Assessment| a.excluded_reason.is_none();
    let best = all.iter().find(included).cloned();
    let safe = all
        .iter()
        .filter(included)
        .find(|a| a.fit == FitVerdict::Comfortable)
        .cloned();
    // FAST = fastest decent model; if nothing clears the quality bar (small
    // machines), fall back to the fastest included model rather than no pick.
    let fastest = |min_q: f64| {
        all.iter()
            .filter(included)
            .filter(|a| a.quality >= min_q)
            .max_by(|a, b| a.est_tok_per_sec.partial_cmp(&b.est_tok_per_sec).unwrap())
            .cloned()
    };
    let fast = fastest(FAST_MIN_QUALITY).or_else(|| fastest(0.0));

    Recommendations {
        best,
        safe,
        fast,
        all,
        usable_memory_gb: round1(usable),
        bandwidth_gbps: round1(effective_bw),
        bandwidth_measured: measured,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use modelfit_hardware::GpuInfo;

    fn apple(chip: &str, ram_gb: f64) -> HardwareInfo {
        HardwareInfo {
            os: "macos".into(),
            os_version: "macOS 15".into(),
            arch: "aarch64".into(),
            cpu_model: format!("Apple {chip}"),
            physical_cores: 12,
            logical_cores: 12,
            total_ram_gb: ram_gb,
            available_ram_gb: ram_gb / 2.0,
            disk_available_gb: 500.0,
            unified_memory: true,
            gpus: vec![GpuInfo {
                vendor: "Apple".into(),
                name: format!("Apple {chip} GPU"),
                vram_gb: Some(ram_gb),
                core_count: Some(20),
            }],
            accelerations: vec!["cpu".into(), "metal".into()],
        }
    }

    fn rec(hw: &HardwareInfo, req: &Request) -> Recommendations {
        recommend(hw, &Registry::bundled(), req)
    }

    fn find<'a>(r: &'a Recommendations, id: &str) -> &'a Assessment {
        r.all.iter().find(|a| a.model_id == id).unwrap()
    }

    #[test]
    fn moe_memory_from_total_speed_from_active() {
        // 64GB M4 Max: both 30B-A3B (MoE) and 32B (dense) fit.
        let r = rec(&apple("M4 Max", 64.0), &Request::default());
        let moe = find(&r, "qwen3-30b-a3b");
        let dense = find(&r, "qwen3-32b");
        assert!(moe.excluded_reason.is_none());
        // Memory: MoE costs like a 30B (~18.6GB weights), not like its 3B active.
        assert!(moe.est_memory_gb > 18.0);
        // Speed: MoE runs on ~3B active params — much faster than 32B dense.
        assert!(moe.est_tok_per_sec > dense.est_tok_per_sec * 3.0);
        // MoE estimates are medium-confidence even on a known chip.
        assert_eq!(moe.confidence, "medium");
        assert_eq!(dense.confidence, "high");
    }

    #[test]
    fn context_length_flips_fit() {
        // Gemma 27B on 48GB: fits at 8k, but its heavy KV cache (~0.5GB/1k,
        // from real GGUF metadata) kills it at 80k.
        let hw = apple("M4 Pro", 48.0);
        let at_8k = rec(&hw, &Request { objective: Objective::Overall, context_length: 8192, ..Request::default() });
        assert!(find(&at_8k, "gemma3-27b").excluded_reason.is_none());

        let at_80k = rec(&hw, &Request { objective: Objective::Overall, context_length: 81920, ..Request::default() });
        let g = find(&at_80k, "gemma3-27b");
        assert!(g.excluded_reason.is_some(), "27B + 80k ctx KV cache must not fit in 22GB usable");
        assert!(g.excluded_reason.as_ref().unwrap().contains("GB"));
    }

    #[test]
    fn small_machine_gets_small_model_with_reasons() {
        let r = rec(&apple("M1", 8.0), &Request::default());
        // 8GB → usable 5.6GB: nothing over ~4GB file fits.
        let best = r.best.as_ref().expect("even 8GB machines get a recommendation");
        assert!(best.est_memory_gb <= r.usable_memory_gb);
        // Every excluded model says why.
        for a in r.all.iter().filter(|a| a.excluded_reason.is_some()) {
            assert!(!a.excluded_reason.as_ref().unwrap().is_empty());
        }
        // Big models are excluded for memory, not silently missing.
        assert!(find(&r, "qwen3-32b").excluded_reason.is_some());
    }

    #[test]
    fn coding_objective_prefers_coder_quality() {
        let r = rec(&apple("M4 Max", 64.0), &Request { objective: Objective::Coding, context_length: 8192, ..Request::default() });
        let best = r.best.as_ref().unwrap();
        // Under the coding objective, coder-tuned or top coding models win.
        let coder = find(&r, "qwen2.5-coder-32b");
        assert!(coder.excluded_reason.is_none());
        assert!(best.quality >= 8.0);
    }

    #[test]
    fn safe_pick_is_comfortable() {
        let r = rec(&apple("M4 Pro", 24.0), &Request::default());
        let safe = r.safe.as_ref().expect("24GB machine has a comfortable pick");
        assert_eq!(safe.fit, FitVerdict::Comfortable);
        assert!(safe.est_memory_gb <= r.usable_memory_gb * 0.8 + 0.05);
    }

    #[test]
    fn fast_pick_is_fastest_decent_model() {
        let r = rec(&apple("M4 Max", 64.0), &Request::default());
        let fast = r.fast.as_ref().unwrap();
        for a in r.all.iter().filter(|a| a.excluded_reason.is_none()) {
            if a.quality >= 7.0 {
                assert!(fast.est_tok_per_sec >= a.est_tok_per_sec);
            }
        }
    }

    #[test]
    fn measured_bandwidth_overrides_estimate() {
        let hw = apple("M4 Pro", 24.0);
        let est = rec(&hw, &Request::default());
        let meas = rec(
            &hw,
            &Request {
                measured_effective_bandwidth_gbps: Some(300.0), // 2× the estimate
                ..Request::default()
            },
        );
        assert!(meas.bandwidth_measured);
        assert!(!est.bandwidth_measured);
        let e = find(&est, "qwen3-14b");
        let m = find(&meas, "qwen3-14b");
        assert!(m.est_tok_per_sec > e.est_tok_per_sec * 1.5);
        assert_eq!(m.confidence, "measured");
        // MoE stays medium even with a measured baseline.
        assert_eq!(find(&meas, "qwen3-30b-a3b").confidence, "medium");
    }

    #[test]
    fn tiny_machine_yields_no_picks_but_full_reasons() {
        // 4GB: nothing fits even at Q4 — best must be None (the UI shows an
        // empty state), and every assessment still explains itself.
        let r = rec(&apple("M1", 4.0), &Request::default());
        assert!(r.best.is_none());
        assert!(r.fast.is_none());
        for a in &r.all {
            assert!(a.excluded_reason.is_some(), "{} must carry a reason", a.model_id);
        }
    }

    #[test]
    fn fast_falls_back_below_quality_bar() {
        // 8GB with a huge context: only the smallest models squeeze in; even
        // if none clears the 7.0 quality bar, FAST must still be offered
        // whenever anything is included.
        let r = rec(
            &apple("M1", 8.0),
            &Request { objective: Objective::Overall, context_length: 16384, ..Request::default() },
        );
        if r.all.iter().any(|a| a.excluded_reason.is_none()) {
            assert!(r.fast.is_some());
        }
    }

    #[test]
    fn quality_beats_saturated_speed_on_midrange_machine() {
        // Regression: 24GB M4 Pro must recommend a ~14B model, not a 4B that
        // merely maxes the speed term (both are "fast enough" interactively).
        let r = rec(&apple("M4 Pro", 24.0), &Request::default());
        let best = r.best.as_ref().unwrap();
        let best_model = Registry::bundled()
            .models
            .iter()
            .find(|m| m.id == best.model_id)
            .unwrap()
            .parameters_b;
        assert!(
            best_model >= 12.0,
            "expected a 14B-class BEST on 24GB, got {} ({}B)",
            best.name,
            best_model
        );
    }

    #[test]
    fn richer_quant_offered_when_memory_allows() {
        // 64GB: Qwen3 8B is still offered at Q8_0 — as an alternative, so the
        // richer rung reaches the user without distorting the score that
        // ranks models against each other.
        let r = rec(&apple("M4 Max", 64.0), &Request::default());
        let a = find(&r, "qwen3-8b");
        assert_eq!(a.quant, DEFAULT_QUANT, "ranked at the baseline rung");
        assert!(
            a.also_fits.iter().any(|o| o.quant == "Q8_0"),
            "expected Q8_0 offered on 64GB, got {:?}",
            a.also_fits.iter().map(|o| &o.quant).collect::<Vec<_>>()
        );
        // 8GB: nothing richer fits, and the baseline still does.
        let r8 = rec(&apple("M1", 8.0), &Request::default());
        let a8 = find(&r8, "qwen3-8b");
        assert_eq!(a8.quant, DEFAULT_QUANT);
        assert!(a8.also_fits.is_empty(), "no headroom on 8GB");
    }

    #[test]
    fn ranking_is_unaffected_by_richer_rungs() {
        // Adding rungs a machine can afford must not reorder models: the
        // score is computed at the same baseline rung for everyone.
        let r = rec(&apple("M4 Max", 64.0), &Request::default());
        for a in &r.all {
            if a.excluded_reason.is_none() {
                assert!(
                    a.quant == DEFAULT_QUANT || a.also_fits.is_empty(),
                    "{} ranked at {} while richer rungs fit",
                    a.model_id,
                    a.quant
                );
            }
        }
    }
}
