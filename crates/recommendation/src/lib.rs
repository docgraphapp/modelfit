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
//! - Every number ships its confidence and the basis behind it: an
//!   extrapolation and a measurement must never look alike to the user.

use modelfit_hardware::HardwareInfo;
use modelfit_registry::{Model, Quant, Registry, DEFAULT_QUANT};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Objective {
    Overall,
    Quality,
    Speed,
    Coding,
    /// Driving an agent or MCP client: the model must accept a tools list,
    /// and speed weighs more because one task is many calls in a row.
    Agents,
}

/// How well a number is known, most certain first.
///
/// The tiers exist so the app can never present a guess the way it presents a
/// measurement. A lower tier never replaces a higher one for the same value:
/// once this machine has timed a model, nothing extrapolated overrides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    /// Timed on this machine, running this exact tag.
    MeasuredLocal,
    /// Median of shared measurements from matching hardware. Nothing produces
    /// this yet — the ingest path is deferred — but the tier is defined here
    /// so the ladder of trust is whole and landing it later is data, not a
    /// change to every consumer.
    Community,
    /// Extrapolated from a bandwidth this machine actually measured.
    Calibrated,
    /// Formula over facts we hold: a chip we recognise, a size read out of the
    /// model file.
    Estimated,
    /// Formula over a placeholder: hardware we have no bandwidth figure for,
    /// or a curated guess standing in for a fact.
    Unknown,
}

impl Confidence {
    /// One step less certain — for a value extrapolated through a model we
    /// know is lossy (MoE routing overhead varies by runtime and batch).
    ///
    /// A measurement is never softened: there is no extrapolation left in it
    /// to be wrong about.
    fn softened(self) -> Confidence {
        match self {
            Confidence::MeasuredLocal => Confidence::MeasuredLocal,
            Confidence::Community => Confidence::Calibrated,
            Confidence::Calibrated => Confidence::Estimated,
            Confidence::Estimated | Confidence::Unknown => Confidence::Unknown,
        }
    }
}

/// A number the app shows, with how well it is known and what it assumes.
///
/// `basis` is the sentence behind the number — what turns "~24 tok/s" from a
/// claim into something the user can check. It is written for a tooltip, so it
/// names the inputs and their units rather than the formula.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub value: f64,
    pub confidence: Confidence,
    pub basis: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub objective: Objective,
    /// Requested context window (tokens). Drives KV-cache memory.
    pub context_length: u32,
    /// From the calibration benchmark: the machine's measured effective
    /// bandwidth (GB/s). When present it replaces the per-chip estimate ×
    /// efficiency guess, and speed estimates are labeled "calibrated".
    #[serde(default)]
    pub measured_effective_bandwidth_gbps: Option<f64>,
    /// tok/s this machine has actually produced, keyed by runtime tag.
    ///
    /// A rung whose tag appears here reports that number instead of an
    /// extrapolation — permanently, and regardless of what the formula would
    /// have said. This is the only input that can reach `MeasuredLocal`.
    /// Keys are matched ignoring the `:latest` a runtime leaves implicit, so
    /// a caller can pass tags through exactly as the runtime reported them.
    #[serde(default)]
    pub measured_tok_per_sec: BTreeMap<String, f64>,
    /// From the calibration benchmark: prompt tok/s × the measured model's
    /// active parameters (billions). Prefill is compute-bound where generation
    /// is bandwidth-bound, so it takes its own constant.
    ///
    /// Absent means no time-to-first-token is reported at all. Deriving one
    /// from spec-sheet TFLOPS would be a number nobody could check, on the
    /// axis users are quickest to notice we got wrong.
    #[serde(default)]
    pub measured_prefill_capacity: Option<f64>,
    /// Capabilities the runtime reports for models it has installed, by tag
    /// (Ollama's `/api/show`). For an installed model this is the model file
    /// answering for itself, so it overrides the registry's `tools` tag.
    #[serde(default)]
    pub runtime_capabilities: BTreeMap<String, Vec<String>>,
}

impl Default for Request {
    fn default() -> Self {
        Request {
            objective: Objective::Overall,
            context_length: 8192,
            measured_effective_bandwidth_gbps: None,
            measured_tok_per_sec: BTreeMap::new(),
            measured_prefill_capacity: None,
            runtime_capabilities: BTreeMap::new(),
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

/// One rung of a model's quantization ladder, assessed on this machine.
///
/// Every rung is reported, including ones that do not fit: the point of the
/// ladder is to show the trade being made, and a rung the machine cannot hold
/// explains the ceiling as clearly as one it can. Quality is deliberately
/// absent — it is not modelled per quant, and inventing a number here would
/// dress a guess as a measurement.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantRung {
    pub quant: String,
    pub memory: Estimate,
    pub speed: Estimate,
    pub fit: FitVerdict,
    pub ollama_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub model_id: String,
    pub name: String,
    pub quant: String,
    pub ollama_tag: Option<String>,
    /// Memory and speed for the ranked rung — the same two estimates the
    /// matching entry in `ladder` carries.
    pub memory: Estimate,
    pub speed: Estimate,
    /// Seconds before the first token appears, at the requested context.
    ///
    /// Only ever present when the machine's prefill throughput was measured:
    /// `None` is the honest answer until the benchmark has run, and it is what
    /// the app shows rather than a guess.
    pub time_to_first_token_s: Option<Estimate>,
    pub fit: FitVerdict,
    /// Absent for a discovered model nothing has rated. Present but with
    /// `recommendable == false` means a provisional, automated score.
    pub quality: Option<f64>,
    /// Whether this model may be offered as a pick. False for the discovered
    /// tier: its memory and speed are reported (they are read from the model
    /// file), but "best for you" is a claim only a curated score can carry.
    pub recommendable: bool,
    /// Where the quality score came from, when there is one.
    pub quality_source: Option<String>,
    /// 0–100, only meaningful for included, recommendable models.
    pub score: f64,
    /// Present iff the model is excluded from recommendations.
    pub excluded_reason: Option<String>,
    /// What the model can do (`chat`, `tools`, `vision`, `reasoning`,
    /// `coding`). From the registry, with `tools` corrected by the runtime
    /// when the model is installed.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// True when the installed model file confirmed `tools` either way,
    /// rather than the registry asserting it.
    #[serde(default)]
    pub tools_verified: bool,
    /// Every quantization of this model, smallest first, assessed on this
    /// machine. Always contains the rung named by `quant`.
    #[serde(default)]
    pub ladder: Vec<QuantRung>,
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
    /// Effective bandwidth every speed estimate is extrapolated from, and how
    /// well it is known. This is the single input the calibration benchmark
    /// improves, so it is reported once rather than per model.
    pub bandwidth: Estimate,
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

/// Apple Silicon spec-sheet memory bandwidth (the GPU's too, on unified memory).
const APPLE_BANDWIDTH: &[(&str, f64)] = &[
    ("m4 max", 546.0),
    ("m3 max", 400.0),
    ("m2 max", 400.0),
    ("m1 max", 400.0),
    ("m4 pro", 273.0),
    ("m2 pro", 200.0),
    ("m1 pro", 200.0),
    ("m3 pro", 150.0),
    ("m2 ultra", 800.0),
    ("m1 ultra", 800.0),
    ("m3 ultra", 819.0),
    ("m4", 120.0),
    ("m3", 102.0),
    ("m2", 100.0),
    ("m1", 68.0),
];

/// Placeholder bandwidth for machines outside the tables above. Deliberately
/// reported as `Unknown`: a number we made up must not read like one we know.
const UNKNOWN_UNIFIED_GBPS: f64 = 100.0;
const UNKNOWN_DISCRETE_GBPS: f64 = 300.0;
const UNKNOWN_CPU_GBPS: f64 = 50.0;

fn speed_floor(objective: Objective) -> f64 {
    match objective {
        Objective::Overall | Objective::Quality => 5.0,
        Objective::Coding => 8.0,
        // An agent loop waits on every step; below this a task drags.
        Objective::Agents => 10.0,
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
        Objective::Agents => (0.55, 0.45),
    }
}

fn quality_for(model: &Model, objective: Objective) -> Option<f64> {
    model.quality_for(objective == Objective::Coding)
}

/// A model's capabilities, with `tools` settled by the runtime when any of
/// its tags is installed. Returns whether the runtime settled it.
///
/// Tool calling lives in the chat template, and every quant of a model ships
/// the same one, so any installed rung answers for all of them.
fn capabilities_for(model: &Model, runtime: &BTreeMap<&str, &Vec<String>>) -> (Vec<String>, bool) {
    let mut caps = model.capabilities.clone();
    let reported = model
        .ollama_tag
        .iter()
        .chain(model.quantizations.values().filter_map(|q| q.ollama_tag.as_ref()))
        .find_map(|t| runtime.get(norm_tag(t)));
    let Some(reported) = reported else {
        return (caps, false);
    };
    let runtime_tools = reported.iter().any(|c| c == "tools");
    caps.retain(|c| c != "tools");
    if runtime_tools {
        caps.push("tools".into());
    }
    (caps, true)
}

/// Runtime tags are compared without the `:latest` the runtime leaves implicit.
fn norm_tag(tag: &str) -> &str {
    tag.strip_suffix(":latest").unwrap_or(tag)
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

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// The effective memory bandwidth every speed estimate extrapolates from —
/// the main predictor of tokens/sec — with how well it is known.
///
/// A measured value is used as-is. Everything else is a spec-sheet figure
/// discounted to what inference really achieves, and a machine we have no
/// figure for gets a placeholder that says so.
pub fn bandwidth_estimate(hw: &HardwareInfo, measured_gbps: Option<f64>) -> Estimate {
    if let Some(m) = measured_gbps.filter(|m| *m > 1.0) {
        return Estimate {
            value: round1(m),
            confidence: Confidence::Calibrated,
            basis: format!("{m:.0} GB/s measured on this machine by the calibration benchmark"),
        };
    }
    let discounted = |theoretical: f64| round1(theoretical * BANDWIDTH_EFFICIENCY);
    let efficiency_note = format!(
        "× {:.0}% real-world efficiency",
        BANDWIDTH_EFFICIENCY * 100.0
    );
    let unknown = |gbps: f64, what: &str| Estimate {
        value: discounted(gbps),
        confidence: Confidence::Unknown,
        basis: format!(
            "no bandwidth figure for {what} — assuming {gbps:.0} GB/s {efficiency_note}. \
             Run the benchmark to replace this with your machine's real number"
        ),
    };

    let cpu = hw.cpu_model.to_lowercase();
    if hw.unified_memory {
        return match APPLE_BANDWIDTH.iter().find(|(pat, _)| cpu.contains(pat)) {
            Some((_, theoretical)) => Estimate {
                value: discounted(*theoretical),
                confidence: Confidence::Estimated,
                basis: format!(
                    "{} spec-sheet memory bandwidth {theoretical:.0} GB/s {efficiency_note}",
                    hw.cpu_model
                ),
            },
            None => unknown(UNKNOWN_UNIFIED_GBPS, "this chip"),
        };
    }
    // Discrete GPUs: no per-SKU table yet (it lands with Windows/Linux parity).
    if hw.gpus.iter().any(|g| g.vram_gb.is_some()) {
        return unknown(UNKNOWN_DISCRETE_GBPS, "this GPU");
    }
    unknown(UNKNOWN_CPU_GBPS, "this CPU's memory")
}

pub fn recommend(hw: &HardwareInfo, registry: &Registry, req: &Request) -> Recommendations {
    let usable = usable_memory_gb(hw);
    let bandwidth = bandwidth_estimate(hw, req.measured_effective_bandwidth_gbps);
    let (wq, ws) = weights(req.objective);
    let floor = speed_floor(req.objective);
    // Guard against nonsense input from the UI layer.
    let context_length = req.context_length.clamp(512, 1 << 20);
    // Both sides of a tag comparison are normalized, so it does not matter
    // whether the caller cleaned up what the runtime reported.
    let measured_tok_per_sec: BTreeMap<&str, f64> = req
        .measured_tok_per_sec
        .iter()
        .map(|(tag, tps)| (norm_tag(tag), *tps))
        .collect();

    let runtime_capabilities: BTreeMap<&str, &Vec<String>> = req
        .runtime_capabilities
        .iter()
        .map(|(tag, caps)| (norm_tag(tag), caps))
        .collect();

    let mut all: Vec<Assessment> = Vec::new();

    for model in &registry.models {
        let (capabilities, tools_verified) = capabilities_for(model, &runtime_capabilities);
        let has_tools = capabilities.iter().any(|c| c == "tools");
        let ctx = context_length.min(model.max_context) as f64;

        // Memory: weights + KV at the requested context + runtime overhead.
        // The estimate is only as good as the facts under it, so a rung whose
        // size or KV rate is a curated fallback rather than a value read from
        // the model file reports itself as unknown.
        let mem_of = |q: &Quant| {
            q.file_size_gb + q.kv_cache_gb_per_1k_ctx * ctx / 1024.0 + RUNTIME_OVERHEAD_GB
        };
        let memory_estimate = |q: &Quant| {
            let kv = q.kv_cache_gb_per_1k_ctx * ctx / 1024.0;
            let read_from_file = q.facts_are_measured();
            Estimate {
                value: round1(mem_of(q)),
                confidence: if read_from_file {
                    Confidence::Estimated
                } else {
                    Confidence::Unknown
                },
                basis: format!(
                    "{:.1} GB weights + {:.1} GB KV cache at {:.0}k context + {:.1} GB runtime overhead{}",
                    q.file_size_gb,
                    kv,
                    ctx / 1024.0,
                    RUNTIME_OVERHEAD_GB,
                    if read_from_file {
                        ""
                    } else {
                        " — sizes are curated fallbacks, not read from the model file"
                    }
                ),
            }
        };

        // Which recorded measurements belong to a rung. Its own install tag
        // names it exactly; the model-level bare tag names it only at the
        // baseline rung, because that is the quant a bare tag pulls — and the
        // bare tag is what the calibration benchmark runs, so without this the
        // one model the user really timed would still read as an estimate.
        let measured_for = |qname: &str, q: &Quant| {
            let candidates = [
                q.ollama_tag.as_deref(),
                (qname == DEFAULT_QUANT)
                    .then_some(model.ollama_tag.as_deref())
                    .flatten(),
            ];
            candidates.into_iter().flatten().find_map(|t| {
                measured_tok_per_sec
                    .get(norm_tag(t))
                    .map(|tps| (norm_tag(t).to_string(), *tps))
            })
        };

        // Speed: a tag this machine has actually run reports its own number;
        // everything else is bandwidth ÷ bytes touched per token, inheriting
        // the confidence of that bandwidth.
        let speed_estimate = |qname: &str, q: &Quant| {
            if let Some((tag, measured)) = measured_for(qname, q) {
                return Estimate {
                    value: round1(measured),
                    confidence: Confidence::MeasuredLocal,
                    // The tier already says "measured on this machine"; the
                    // basis names what was run, not the fact of running it.
                    basis: format!("{tag} was timed at {measured:.0} tok/s here"),
                };
            }
            let bytes_per_weight = q.file_size_gb / model.parameters_b;
            let gb_per_token = model.speed_params_b() * bytes_per_weight;
            let mut value = bandwidth.value / gb_per_token;
            let mut confidence = bandwidth.confidence;
            let mut basis = format!(
                "{:.0} GB/s effective bandwidth ÷ {:.2} GB touched per token \
                 ({:.1}B params at {:.2} bytes/weight)",
                bandwidth.value,
                gb_per_token,
                model.speed_params_b(),
                bytes_per_weight
            );
            if model.is_moe() {
                value *= MOE_EFFICIENCY;
                // Routing cost varies by runtime and batch size, so a MoE
                // number is one step less trustworthy than the bandwidth it
                // came from — unless that bandwidth was this model's own
                // measured throughput, which already includes the routing.
                confidence = confidence.softened();
                basis.push_str(&format!(
                    ", on {:.1}B active of {:.1}B total, less a {:.0}% routing penalty",
                    model.speed_params_b(),
                    model.parameters_b,
                    (1.0 - MOE_EFFICIENCY) * 100.0
                ));
            }
            Estimate {
                value: round1(value),
                confidence,
                basis,
            }
        };

        // Quants step DOWN, never up: the baseline rung when it fits, else the
        // largest rung that does. Climbing into spare headroom would be wrong
        // here — quality is modelled per model, not per quant, so a richer
        // quant scores identical quality while being measurably slower, which
        // would penalise precisely the models a capable machine handles best.
        // Offering the richer rung is a separate decision for the user to make
        // with the trade-off in front of them, not one to fold into the score.
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

        let verdict = |mem: f64| {
            if mem <= usable * COMFORT_FRACTION {
                FitVerdict::Comfortable
            } else if mem <= usable * FIT_FRACTION {
                FitVerdict::Tight
            } else {
                FitVerdict::TooBig
            }
        };
        let fit = verdict(est_memory);

        let memory = memory_estimate(&model.quantizations[quant]);
        let speed = speed_estimate(quant, &model.quantizations[quant]);
        let tok_s = speed.value;

        // Time to first token: the whole prompt has to be pushed through the
        // model before anything comes back, and that cost scales with the
        // parameters each token passes through.
        let time_to_first_token_s = req.measured_prefill_capacity.and_then(|capacity| {
            let prompt_tok_per_sec = capacity / model.speed_params_b();
            (prompt_tok_per_sec > 0.0 && prompt_tok_per_sec.is_finite()).then(|| Estimate {
                value: round1(ctx / prompt_tok_per_sec),
                confidence: Confidence::Calibrated,
                basis: format!(
                    "{:.0} prompt tokens/sec on {:.1}B parameters, measured here, \
                     against a {:.0}k context",
                    prompt_tok_per_sec,
                    model.speed_params_b(),
                    ctx / 1024.0
                ),
            })
        });

        // The whole ladder, smallest rung first, each assessed on this machine.
        let mut ladder: Vec<QuantRung> = model
            .quantizations
            .iter()
            .map(|(qname, q)| QuantRung {
                quant: qname.clone(),
                memory: memory_estimate(q),
                speed: speed_estimate(qname, q),
                fit: verdict(mem_of(q)),
                ollama_tag: model.install_tag(qname),
            })
            .collect();
        ladder.sort_by(|a, b| a.memory.value.partial_cmp(&b.memory.value).unwrap());

        let quality = quality_for(model, req.objective);
        // Discovery is automated; eligibility is curated. An unrated model is
        // assessed and listed — "will it run here" is answered by facts — but
        // it is never put forward as a pick.
        let recommendable = model.is_recommendable();

        // Hard constraints — explainable exclusions.
        let mut excluded_reason = None;
        if context_length > model.max_context {
            excluded_reason = Some(format!(
                "max context is {}k, you asked for {}k",
                model.max_context / 1024,
                context_length / 1024
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
        } else if req.objective == Objective::Agents && !has_tools {
            excluded_reason = Some(if tools_verified {
                "installed copy doesn't accept tools".into()
            } else {
                "no tool-calling support".into()
            });
        }

        // Weighted score (0–100). Quality is normalized over the range real
        // local models occupy (~5–10), not 0–10 — otherwise a 1-point quality
        // gap (large) weighs less than a speed gap the user barely feels.
        // Speed saturates at 20 tok/s: beyond comfortable reading speed,
        // faster stops mattering for interactive use.
        let qn = ((quality.unwrap_or(0.0) - 5.0) / 5.0).clamp(0.0, 1.0);
        let sn = (tok_s / 20.0).clamp(0.0, 1.0);
        // A score is a ranking against other models, so it needs a quality
        // number that is comparable to theirs. Without one there is nothing to
        // rank, and a 0 here keeps the model out of the ordering rather than
        // pretending it came last on merit.
        let score = if excluded_reason.is_some() || !recommendable {
            0.0
        } else {
            (wq * qn + ws * sn) * 100.0
        };

        all.push(Assessment {
            model_id: model.id.clone(),
            name: model.name.clone(),
            quant: quant.clone(),
            ollama_tag: model.install_tag(quant),
            memory,
            speed,
            time_to_first_token_s,
            fit,
            quality,
            recommendable,
            quality_source: model
                .quality
                .as_ref()
                .map(|q| q.source.clone().unwrap_or_else(|| "hand".into())),
            score: round1(score),
            excluded_reason,
            capabilities,
            tools_verified,
            ladder,
        });
    }

    // Score first, but score alone leaves a long tail tied at zero: every
    // excluded model and every unrated one. Within that tail, a model that
    // runs here outranks one that does not, and a smaller one outranks a
    // larger — so the rows nearest to being useful surface first instead of
    // sitting in registry order.
    all.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap()
            .then_with(|| a.excluded_reason.is_some().cmp(&b.excluded_reason.is_some()))
            .then_with(|| a.memory.value.partial_cmp(&b.memory.value).unwrap())
    });

    // A pick must both run here and be one we can stand behind.
    let included = |a: &&Assessment| a.excluded_reason.is_none() && a.recommendable;
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
            .filter(|a| a.quality.unwrap_or(0.0) >= min_q)
            .max_by(|a, b| a.speed.value.partial_cmp(&b.speed.value).unwrap())
            .cloned()
    };
    let fast = fastest(FAST_MIN_QUALITY).or_else(|| fastest(0.0));

    Recommendations {
        best,
        safe,
        fast,
        all,
        usable_memory_gb: round1(usable),
        bandwidth,
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
        assert!(moe.memory.value > 18.0);
        // Speed: MoE runs on ~3B active params — much faster than 32B dense.
        assert!(moe.speed.value > dense.speed.value * 3.0);
        // A known chip gives an Estimated bandwidth; MoE routing softens it
        // one step, so the two must not read alike.
        assert_eq!(dense.speed.confidence, Confidence::Estimated);
        assert_eq!(moe.speed.confidence, Confidence::Unknown);
    }

    #[test]
    fn context_length_flips_fit() {
        // Gemma 27B on 48GB: fits at 8k, but its KV cache (~0.14GB/1k, from
        // real GGUF metadata) outgrows the machine by its full 128k context.
        let hw = apple("M4 Pro", 48.0);
        let at_8k = rec(
            &hw,
            &Request {
                objective: Objective::Overall,
                context_length: 8192,
                ..Request::default()
            },
        );
        assert!(find(&at_8k, "gemma3-27b").excluded_reason.is_none());

        let at_128k = rec(
            &hw,
            &Request {
                objective: Objective::Overall,
                context_length: 131072,
                ..Request::default()
            },
        );
        let g = find(&at_128k, "gemma3-27b");
        assert!(
            g.excluded_reason.is_some(),
            "27B + 128k ctx KV cache must not fit in 22GB usable"
        );
        assert!(g.excluded_reason.as_ref().unwrap().contains("GB"));
    }

    #[test]
    fn small_machine_gets_small_model_with_reasons() {
        let r = rec(&apple("M1", 8.0), &Request::default());
        // 8GB → usable 5.6GB: nothing over ~4GB file fits.
        let best = r
            .best
            .as_ref()
            .expect("even 8GB machines get a recommendation");
        assert!(best.memory.value <= r.usable_memory_gb);
        // Every excluded model says why.
        for a in r.all.iter().filter(|a| a.excluded_reason.is_some()) {
            assert!(!a.excluded_reason.as_ref().unwrap().is_empty());
        }
        // Big models are excluded for memory, not silently missing.
        assert!(find(&r, "qwen3-32b").excluded_reason.is_some());
    }

    #[test]
    fn coding_objective_prefers_coder_quality() {
        let r = rec(
            &apple("M4 Max", 64.0),
            &Request {
                objective: Objective::Coding,
                context_length: 8192,
                ..Request::default()
            },
        );
        let best = r.best.as_ref().unwrap();
        // Under the coding objective, coder-tuned or top coding models win.
        let coder = find(&r, "qwen2.5-coder-32b");
        assert!(coder.excluded_reason.is_none());
        assert!(best.quality.unwrap() >= 8.0);
    }

    #[test]
    fn agents_objective_only_ranks_tool_callers() {
        let r = rec(
            &apple("M4 Max", 64.0),
            &Request {
                objective: Objective::Agents,
                context_length: 32768,
                ..Request::default()
            },
        );
        assert!(r.best.is_some(), "a 64 GB machine has a tool-calling pick");
        for a in r.all.iter().filter(|a| a.excluded_reason.is_none()) {
            assert!(a.capabilities.iter().any(|c| c == "tools"), "{} ranked without tools", a.model_id);
        }
        let reasons: Vec<_> = r.all.iter().filter_map(|a| a.excluded_reason.as_deref()).collect();
        assert!(reasons.contains(&"no tool-calling support"));
    }

    #[test]
    fn installed_model_settles_tools_either_way() {
        let hw = apple("M4 Max", 64.0);
        let reg = Registry::bundled();
        let tagged = |has: bool| {
            let m = reg.models.iter().find(|m| m.id == "llama3.2-3b").unwrap();
            let mut req = Request { objective: Objective::Agents, ..Request::default() };
            let caps = if has { vec!["completion".into(), "tools".into()] } else { vec!["completion".into()] };
            // `:latest` as the runtime reports it; matching must not care.
            req.runtime_capabilities.insert(format!("{}:latest", m.ollama_tag.as_deref().unwrap()), caps);
            recommend(&hw, &reg, &req)
        };

        let without = tagged(false);
        let a = find(&without, "llama3.2-3b");
        assert!(a.tools_verified);
        assert!(!a.capabilities.iter().any(|c| c == "tools"), "runtime overrides the registry");
        assert_eq!(a.excluded_reason.as_deref(), Some("installed copy doesn't accept tools"));

        let with = tagged(true);
        let a = find(&with, "llama3.2-3b");
        assert!(a.tools_verified && a.capabilities.iter().any(|c| c == "tools"));
        // Other models were not installed, so the registry still speaks for them.
        assert!(!find(&with, "qwen3-32b").tools_verified);
    }

    #[test]
    fn safe_pick_is_comfortable() {
        let r = rec(&apple("M4 Pro", 24.0), &Request::default());
        let safe = r
            .safe
            .as_ref()
            .expect("24GB machine has a comfortable pick");
        assert_eq!(safe.fit, FitVerdict::Comfortable);
        assert!(safe.memory.value <= r.usable_memory_gb * 0.8 + 0.05);
    }

    #[test]
    fn fast_pick_is_fastest_decent_model() {
        let r = rec(&apple("M4 Max", 64.0), &Request::default());
        let fast = r.fast.as_ref().unwrap();
        for a in r.all.iter().filter(|a| a.excluded_reason.is_none()) {
            if a.quality.unwrap_or(0.0) >= 7.0 {
                assert!(fast.speed.value >= a.speed.value);
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
        assert_eq!(meas.bandwidth.confidence, Confidence::Calibrated);
        assert_eq!(est.bandwidth.confidence, Confidence::Estimated);
        let e = find(&est, "qwen3-14b");
        let m = find(&meas, "qwen3-14b");
        assert!(m.speed.value > e.speed.value * 1.5);
        assert_eq!(m.speed.confidence, Confidence::Calibrated);
        // MoE stays one step below the bandwidth it was extrapolated from.
        assert_eq!(
            find(&meas, "qwen3-30b-a3b").speed.confidence,
            Confidence::Estimated
        );
    }

    #[test]
    fn tiny_machine_yields_no_picks_but_full_reasons() {
        // Small enough that even the smallest quant plus the fixed runtime
        // overhead cannot fit: best must be None (the UI shows an empty state)
        // and every assessment must still explain itself.
        //
        // The size is deliberately well under anything shippable rather than
        // just below today's smallest model. The catalogue grows — this test
        // is about the empty state, not about where the floor happens to sit
        // this week — so the premise is asserted first and fails loudly if a
        // model ever does fit here.
        let hw = apple("M1", 2.0);
        let r = rec(&hw, &Request::default());
        assert!(
            r.all.iter().all(|a| a.memory.value > usable_memory_gb(&hw)),
            "premise: nothing in the catalogue fits a 2 GB machine"
        );
        assert!(r.best.is_none());
        assert!(r.safe.is_none());
        assert!(r.fast.is_none());
        for a in &r.all {
            assert!(
                a.excluded_reason.is_some(),
                "{} must carry a reason",
                a.model_id
            );
        }
    }

    #[test]
    fn fast_falls_back_below_quality_bar() {
        // 8GB with a huge context: only the smallest models squeeze in; even
        // if none clears the 7.0 quality bar, FAST must still be offered
        // whenever anything is included.
        let r = rec(
            &apple("M1", 8.0),
            &Request {
                objective: Objective::Overall,
                context_length: 16384,
                ..Request::default()
            },
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
        let richer_that_fits = |a: &Assessment| {
            let chosen = a.memory.value;
            a.ladder
                .iter()
                .filter(|r| r.memory.value > chosen && r.fit != FitVerdict::TooBig)
                .map(|r| r.quant.clone())
                .collect::<Vec<_>>()
        };
        assert!(
            richer_that_fits(a).contains(&"Q8_0".to_string()),
            "expected Q8_0 offered on 64GB, got {:?}",
            richer_that_fits(a)
        );
        // 8GB: nothing richer fits, and the baseline still does.
        let r8 = rec(&apple("M1", 8.0), &Request::default());
        let a8 = find(&r8, "qwen3-8b");
        assert_eq!(a8.quant, DEFAULT_QUANT);
        assert!(richer_that_fits(a8).is_empty(), "no headroom on 8GB");
    }

    #[test]
    fn ladder_is_complete_and_agrees_with_the_pick() {
        let r = rec(&apple("M4 Max", 64.0), &Request::default());
        for a in &r.all {
            let chosen = a
                .ladder
                .iter()
                .find(|x| x.quant == a.quant)
                .unwrap_or_else(|| panic!("{}: ladder omits the chosen rung", a.model_id));
            assert_eq!(chosen.memory.value, a.memory.value, "{}", a.model_id);
            assert_eq!(chosen.speed.value, a.speed.value, "{}", a.model_id);
            assert_eq!(
                chosen.speed.confidence, a.speed.confidence,
                "{}",
                a.model_id
            );
            assert_eq!(chosen.fit, a.fit, "{}", a.model_id);
            // Smallest first, and more bits always costs speed.
            for w in a.ladder.windows(2) {
                assert!(w[0].memory.value <= w[1].memory.value, "{}", a.model_id);
                assert!(w[0].speed.value >= w[1].speed.value, "{}", a.model_id);
            }
        }
    }

    #[test]
    fn ranking_is_unaffected_by_richer_rungs() {
        // Adding rungs a machine can afford must not reorder models: the
        // score is computed at the same baseline rung for everyone.
        let r = rec(&apple("M4 Max", 64.0), &Request::default());
        for a in &r.all {
            if a.excluded_reason.is_none() {
                let richer_fits = a
                    .ladder
                    .iter()
                    .any(|r| r.memory.value > a.memory.value && r.fit != FitVerdict::TooBig);
                assert!(
                    a.quant == DEFAULT_QUANT || !richer_fits,
                    "{} ranked at {} while richer rungs fit",
                    a.model_id,
                    a.quant
                );
            }
        }
    }

    #[test]
    fn a_measured_tag_reports_its_own_number_forever() {
        // Whatever the formula says, a rung this machine has actually run
        // reports what it ran at — and says so.
        let hw = apple("M4 Max", 64.0);
        let tag = Registry::bundled()
            .models
            .iter()
            .find(|m| m.id == "qwen3-8b")
            .unwrap()
            .install_tag(DEFAULT_QUANT)
            .unwrap();
        let mut req = Request::default();
        req.measured_tok_per_sec.insert(tag.clone(), 7.0);
        let r = rec(&hw, &req);
        let a = find(&r, "qwen3-8b");
        assert_eq!(a.speed.value, 7.0);
        assert_eq!(a.speed.confidence, Confidence::MeasuredLocal);
        assert!(
            a.speed.basis.contains(&tag),
            "basis names the tag it measured"
        );
        // The measurement is specific to that rung, not the whole model.
        let other = a.ladder.iter().find(|l| l.quant != a.quant).unwrap();
        assert_eq!(other.speed.confidence, Confidence::Estimated);
        // And it beats calibration, which is a weaker tier.
        req.measured_effective_bandwidth_gbps = Some(400.0);
        let cal = rec(&hw, &req);
        assert_eq!(find(&cal, "qwen3-8b").speed.value, 7.0);
    }

    #[test]
    fn the_bare_tag_the_benchmark_runs_lands_on_the_baseline_rung() {
        // calibration_candidates picks a model's bare tag ("gemma3:4b"), while
        // each rung carries a quant-specific one ("gemma3:4b-it-q4_K_M"). A
        // bare tag pulls the runtime's default quant, so the reading belongs
        // to that rung — and to no other.
        let hw = apple("M4 Max", 64.0);
        let reg = Registry::bundled();
        let model = reg.models.iter().find(|m| m.id == "gemma3-4b").unwrap();
        let bare = model.ollama_tag.clone().unwrap();
        assert_ne!(
            Some(&bare),
            model.install_tag(DEFAULT_QUANT).as_ref(),
            "test is only meaningful while the rung tag differs from the bare one"
        );
        let mut req = Request::default();
        req.measured_tok_per_sec.insert(bare, 11.0);
        let r = rec(&hw, &req);
        let a = find(&r, "gemma3-4b");
        assert_eq!(a.quant, DEFAULT_QUANT);
        assert_eq!(a.speed.confidence, Confidence::MeasuredLocal);
        assert_eq!(a.speed.value, 11.0);
        for rung in a.ladder.iter().filter(|l| l.quant != DEFAULT_QUANT) {
            assert_ne!(
                rung.speed.confidence,
                Confidence::MeasuredLocal,
                "{} must not inherit the baseline's measurement",
                rung.quant
            );
        }
    }

    #[test]
    fn a_tag_measured_with_the_latest_suffix_still_matches() {
        // Ollama names the same file "qwen3:8b" and "qwen3:8b:latest"; a
        // measurement recorded under either must be found under the other.
        let hw = apple("M4 Max", 64.0);
        let tag = Registry::bundled()
            .models
            .iter()
            .find(|m| m.id == "qwen3-8b")
            .unwrap()
            .install_tag(DEFAULT_QUANT)
            .unwrap();
        let mut req = Request::default();
        req.measured_tok_per_sec
            .insert(format!("{tag}:latest"), 7.0);
        let r = rec(&hw, &req);
        let a = find(&r, "qwen3-8b");
        assert_eq!(a.speed.confidence, Confidence::MeasuredLocal);
        assert_eq!(a.speed.value, 7.0);
    }

    #[test]
    fn unknown_hardware_is_not_dressed_up_as_an_estimate() {
        let mut hw = apple("M9 Hypermax", 64.0);
        hw.cpu_model = "Apple M9 Hypermax".into(); // not in the table
        let r = rec(&hw, &Request::default());
        assert_eq!(r.bandwidth.confidence, Confidence::Unknown);
        assert!(r.bandwidth.basis.contains("no bandwidth figure"));
        assert_eq!(find(&r, "qwen3-8b").speed.confidence, Confidence::Unknown);
    }

    #[test]
    fn every_number_carries_a_basis_naming_its_inputs() {
        let r = rec(&apple("M4 Pro", 24.0), &Request::default());
        for a in &r.all {
            assert!(a.speed.basis.contains("tok/s") || a.speed.basis.contains("GB/s"));
            assert!(a.memory.basis.contains("KV cache"), "{}", a.model_id);
            assert!(
                a.memory.basis.contains("runtime overhead"),
                "{}",
                a.model_id
            );
            for rung in &a.ladder {
                assert!(!rung.memory.basis.is_empty() && !rung.speed.basis.is_empty());
            }
        }
    }

    #[test]
    fn context_length_shows_up_in_the_memory_basis() {
        // The basis is what lets a user check the number; the context it
        // assumed is the input they are most likely to have changed.
        let r = rec(
            &apple("M4 Max", 64.0),
            &Request {
                context_length: 32768,
                ..Request::default()
            },
        );
        assert!(find(&r, "qwen3-8b").memory.basis.contains("32k context"));
    }

    /// A registry with one model demoted out of the curated tier.
    fn registry_with_uncurated(id: &str, quality: Option<f64>) -> Registry {
        let mut reg = Registry::bundled();
        let m = reg.models.iter_mut().find(|m| m.id == id).unwrap();
        m.quality = quality.map(|q| modelfit_registry::Quality {
            general: q,
            coding: q,
            source: Some("leaderboard-v2".into()),
        });
        reg
    }

    #[test]
    fn an_unrated_model_is_assessed_but_never_picked() {
        // The discovered tier answers "will it run here" and nothing more.
        let hw = apple("M4 Max", 64.0);
        let req = Request::default();
        let baseline = rec(&hw, &req);
        let baseline_best = baseline.best.as_ref().unwrap().model_id.clone();

        let reg = registry_with_uncurated(&baseline_best, None);
        let r = recommend(&hw, &reg, &req);
        let a = find(&r, &baseline_best);

        // Still fully assessed: it runs, and we say how well.
        assert!(
            a.excluded_reason.is_none(),
            "it still fits — that is a fact"
        );
        assert!(a.memory.value > 0.0 && a.speed.value > 0.0);
        // But it carries no rating, no score, and no pick.
        assert_eq!(a.quality, None);
        assert!(!a.recommendable);
        assert_eq!(a.score, 0.0);
        for pick in [&r.best, &r.safe, &r.fast] {
            assert_ne!(
                pick.as_ref().map(|p| p.model_id.as_str()),
                Some(baseline_best.as_str()),
                "an unrated model must not be offered as a pick"
            );
        }
        // And the machine still gets a recommendation from the curated tier.
        assert!(r.best.is_some());
    }

    #[test]
    fn a_provisional_score_is_shown_but_still_not_picked() {
        // An automated leaderboard number is worth showing and worth nothing
        // as a promise: benchmarks do not always survive quantization.
        let hw = apple("M4 Max", 64.0);
        let baseline = rec(&hw, &Request::default());
        let top = baseline.best.as_ref().unwrap().model_id.clone();

        let reg = registry_with_uncurated(&top, Some(9.9));
        let r = recommend(&hw, &reg, &Request::default());
        let a = find(&r, &top);
        assert_eq!(a.quality, Some(9.9), "the number is reported");
        assert_eq!(a.quality_source.as_deref(), Some("leaderboard-v2"));
        assert!(!a.recommendable);
        assert_eq!(a.score, 0.0);
        assert_ne!(
            r.best.as_ref().map(|p| p.model_id.as_str()),
            Some(top.as_str())
        );
        // Even a 9.9 must not win FAST, which has its own quality bar.
        assert_ne!(
            r.fast.as_ref().map(|p| p.model_id.as_str()),
            Some(top.as_str())
        );
    }

    #[test]
    fn a_registry_with_nothing_curated_yields_no_picks() {
        // The honest empty state, not a pick made from numbers nobody stood
        // behind.
        let mut reg = Registry::bundled();
        for m in &mut reg.models {
            m.quality = None;
        }
        let r = recommend(&apple("M4 Max", 64.0), &reg, &Request::default());
        assert!(r.best.is_none() && r.safe.is_none() && r.fast.is_none());
        assert!(r.all.iter().all(|a| !a.recommendable));
        // Every model is still assessed — the table is not empty.
        assert!(r.all.iter().any(|a| a.excluded_reason.is_none()));
    }

    #[test]
    fn no_time_to_first_token_until_it_has_been_measured() {
        // Prefill throughput cannot be read off a spec sheet the way memory
        // bandwidth can, so before the benchmark there is nothing honest to
        // say — including after a bandwidth-only calibration.
        let hw = apple("M4 Max", 64.0);
        let r = rec(&hw, &Request::default());
        assert!(r.all.iter().all(|a| a.time_to_first_token_s.is_none()));

        let bandwidth_only = rec(
            &hw,
            &Request {
                measured_effective_bandwidth_gbps: Some(300.0),
                ..Request::default()
            },
        );
        assert!(bandwidth_only
            .all
            .iter()
            .all(|a| a.time_to_first_token_s.is_none()));
    }

    #[test]
    fn measured_prefill_scales_across_models_and_context() {
        // 400 B-params·tok/s: an 8B model chews 50 prompt tok/s, so 8k of
        // context is ~164 s before the first token appears.
        let hw = apple("M4 Max", 64.0);
        let at_8k = rec(
            &hw,
            &Request {
                measured_prefill_capacity: Some(400.0),
                ..Request::default()
            },
        );
        let small = find(&at_8k, "qwen3-8b");
        let ttft = small.time_to_first_token_s.as_ref().unwrap();
        assert_eq!(ttft.confidence, Confidence::Calibrated);
        assert!(
            (ttft.value - 8192.0 / (400.0 / 8.2)).abs() < 1.0,
            "got {}",
            ttft.value
        );

        // A bigger model pushes each token through more parameters, so it is
        // slower to first token on the same machine.
        let big = find(&at_8k, "qwen3-32b");
        assert!(big.time_to_first_token_s.as_ref().unwrap().value > ttft.value);

        // Twice the context is twice the prompt to process.
        let at_16k = rec(
            &hw,
            &Request {
                context_length: 16384,
                measured_prefill_capacity: Some(400.0),
                ..Request::default()
            },
        );
        let doubled = find(&at_16k, "qwen3-8b")
            .time_to_first_token_s
            .as_ref()
            .unwrap()
            .value;
        assert!((doubled - ttft.value * 2.0).abs() < 1.0);
    }

    #[test]
    fn moe_prefill_uses_active_parameters() {
        // Prefill runs through the active experts, not the whole model — the
        // same split that makes a 30B-A3B generate like a 3B.
        let r = rec(
            &apple("M4 Max", 64.0),
            &Request {
                measured_prefill_capacity: Some(400.0),
                ..Request::default()
            },
        );
        let moe = find(&r, "qwen3-30b-a3b")
            .time_to_first_token_s
            .as_ref()
            .unwrap()
            .value;
        let dense = find(&r, "qwen3-32b")
            .time_to_first_token_s
            .as_ref()
            .unwrap()
            .value;
        assert!(moe < dense / 5.0, "MoE {moe} vs dense {dense}");
    }

    #[test]
    fn the_zero_score_tail_still_has_a_useful_order() {
        // With a catalogue of a hundred models, most rows tie at zero: every
        // excluded one and every unrated one. Registry order there would put a
        // 400 GB model above an 8B the user could almost run.
        let mut reg = Registry::bundled();
        for m in &mut reg.models {
            m.quality = None; // everything unrated → every score is 0
        }
        let r = recommend(&apple("M1", 8.0), &reg, &Request::default());
        let mut seen_excluded = false;
        let mut last_memory = 0.0;
        for a in &r.all {
            if a.excluded_reason.is_some() {
                seen_excluded = true;
            } else {
                assert!(!seen_excluded, "{} runs but sorted below an excluded model", a.model_id);
                assert!(a.memory.value >= last_memory, "{}: out of size order", a.model_id);
                last_memory = a.memory.value;
            }
        }
    }
}
