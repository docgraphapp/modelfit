//! Runtime adapters: ModelFit never runs models itself — a runtime is only
//! the *executor* of a recommendation. v1 ships the Ollama adapter; the trait
//! is the seam where llama.cpp-direct (and LM Studio) slot in later.

use async_trait::async_trait;
use futures_util::StreamExt;
use modelfit_registry::{Model, Quant, Registry, DEFAULT_QUANT};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub running: bool,
    pub version: Option<String>,
    /// Installed model tags, normalized (":latest" stripped).
    pub installed_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub tag: String,
    pub status: String,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub model_tag: String,
    pub gen_tok_per_sec: f64,
    pub prompt_tok_per_sec: f64,
}

#[async_trait]
pub trait RuntimeAdapter: Send + Sync {
    async fn status(&self) -> RuntimeStatus;
    async fn pull(
        &self,
        tag: &str,
        on_progress: &(dyn Fn(PullProgress) + Send + Sync),
    ) -> Result<(), String>;
    /// Timed generation on an installed model (the calibration primitive).
    async fn measure(&self, tag: &str) -> Result<Measurement, String>;
}

pub struct Ollama {
    base: String,
    client: reqwest::Client,
}

impl Default for Ollama {
    fn default() -> Self {
        Ollama {
            base: "http://127.0.0.1:11434".into(),
            client: reqwest::Client::new(),
        }
    }
}

pub fn normalize_tag(tag: &str) -> String {
    tag.strip_suffix(":latest").unwrap_or(tag).to_string()
}

/// Below this, the runtime did not actually evaluate the prompt we sent.
///
/// `measurement_prompt` is several hundred tokens, so a handful of evaluated
/// tokens means they came out of a cache. See `prompt_tok_per_sec`.
const MIN_PROMPT_TOKENS: u64 = 64;

/// The prompt for one benchmark run — never the same text twice.
///
/// A runtime serves a repeated prompt from its cache, so a benchmark that can
/// be re-run must never send a prompt it has sent before: the second run would
/// time the cache instead of the model. The failure is silent and spectacular
/// — the same mistake elsewhere in this codebase's family produced a reported
/// 546,720 tokens/sec.
///
/// The nonce leads the prompt because prefix matching is what the cache does.
/// Appending one would still let almost all of the prompt hit, and a partial
/// hit is the worst case of all: measured against a cache, but not obviously
/// wrong enough to notice.
///
/// It is built to differ in its *first* characters, not its last. Two clock
/// readings a moment apart share every digit but the last few ("1775…901234"
/// vs "1775…909999"), which is a shared prefix a cache can still match on — so
/// a per-process counter goes first and the clock digits are reversed behind
/// it. The counter alone would repeat across restarts; the clock alone repeats
/// if two runs land in the same tick. Together they cannot.
fn measurement_prompt() -> String {
    static RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let clock = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let nonce: String = clock.to_string().chars().rev().collect();
    format!(
        "Run {seq}-{nonce}. {}",
        "Summarize, in your own words, why the sky appears blue during the day \
         and red at sunset. Cover Rayleigh scattering, the wavelength dependence, \
         and the longer atmospheric path at dusk. "
            .repeat(4)
    )
}

/// Prompt-processing throughput, or 0 when the runtime did not measure it.
///
/// Zero means "unknown" and travels all the way to the app as no
/// time-to-first-token at all. That is the point: this number becomes a
/// `Calibrated` estimate — one the app presents as measured on this machine —
/// so a cache artifact here would put our second-highest confidence tier on
/// the number least likely to be true. Reporting nothing is the honest answer;
/// a fast wrong number is not.
fn prompt_tok_per_sec(count: Option<u64>, duration_ns: Option<u64>) -> f64 {
    match (count, duration_ns) {
        // A cache hit shows up as far fewer evaluated tokens than we sent, a
        // near-zero duration, or both — and the ratio of two near-zero numbers
        // is where an absurd figure comes from.
        (Some(c), Some(d)) if c >= MIN_PROMPT_TOKENS && d > 0 => c as f64 / (d as f64 / 1e9),
        _ => 0.0,
    }
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagEntry>,
}
#[derive(Deserialize)]
struct TagEntry {
    name: String,
}

#[derive(Deserialize)]
struct GenerateResponse {
    eval_count: Option<u64>,
    eval_duration: Option<u64>,
    prompt_eval_count: Option<u64>,
    prompt_eval_duration: Option<u64>,
}

#[async_trait]
impl RuntimeAdapter for Ollama {
    async fn status(&self) -> RuntimeStatus {
        let version = match self.client.get(format!("{}/api/version", self.base)).send().await {
            Ok(r) => r
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v["version"].as_str().map(String::from)),
            Err(_) => {
                return RuntimeStatus { running: false, version: None, installed_tags: vec![] }
            }
        };
        let installed_tags = match self.client.get(format!("{}/api/tags", self.base)).send().await
        {
            Ok(r) => r
                .json::<TagsResponse>()
                .await
                .map(|t| t.models.iter().map(|m| normalize_tag(&m.name)).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        };
        RuntimeStatus { running: true, version, installed_tags }
    }

    async fn pull(
        &self,
        tag: &str,
        on_progress: &(dyn Fn(PullProgress) + Send + Sync),
    ) -> Result<(), String> {
        let resp = self
            .client
            .post(format!("{}/api/pull", self.base))
            .json(&serde_json::json!({ "model": tag }))
            .send()
            .await
            .map_err(|e| format!("pull request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("pull failed: HTTP {}", resp.status()));
        }
        // NDJSON stream; lines may split across chunks.
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("pull stream error: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find('\n') {
                let line: String = buf.drain(..=pos).collect();
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let v: serde_json::Value =
                    serde_json::from_str(line).map_err(|e| format!("bad pull line: {e}"))?;
                if let Some(err) = v["error"].as_str() {
                    return Err(err.to_string());
                }
                on_progress(PullProgress {
                    tag: tag.to_string(),
                    status: v["status"].as_str().unwrap_or("").to_string(),
                    total: v["total"].as_u64(),
                    completed: v["completed"].as_u64(),
                });
            }
        }
        Ok(())
    }

    async fn measure(&self, tag: &str) -> Result<Measurement, String> {
        // Warmup loads the model so load time doesn't pollute the timing.
        self.generate(tag, "Say OK.", 4).await?;
        let prompt = measurement_prompt();
        let g = self.generate(tag, &prompt, 160).await?;
        let (Some(ec), Some(ed)) = (g.eval_count, g.eval_duration) else {
            return Err("runtime returned no timing data".into());
        };
        if ed == 0 || ec < 16 {
            return Err(format!("measurement too short ({ec} tokens)"));
        }
        Ok(Measurement {
            model_tag: normalize_tag(tag),
            gen_tok_per_sec: ec as f64 / (ed as f64 / 1e9),
            prompt_tok_per_sec: prompt_tok_per_sec(
                g.prompt_eval_count,
                g.prompt_eval_duration,
            ),
        })
    }
}

impl Ollama {
    async fn generate(
        &self,
        tag: &str,
        prompt: &str,
        num_predict: u32,
    ) -> Result<GenerateResponse, String> {
        let resp = self
            .client
            .post(format!("{}/api/generate", self.base))
            .json(&serde_json::json!({
                "model": tag,
                "prompt": prompt,
                "stream": false,
                "options": { "num_predict": num_predict, "temperature": 0 }
            }))
            .send()
            .await
            .map_err(|e| format!("generate failed: {e}"))?;
        if !resp.status().is_success() {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("generate failed: HTTP {code} {body}"));
        }
        resp.json().await.map_err(|e| format!("bad generate response: {e}"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    pub model_tag: String,
    pub gen_tok_per_sec: f64,
    pub prompt_tok_per_sec: f64,
    /// gen_tok/s × GB-touched-per-token of the calibration model: the
    /// machine's real effective memory bandwidth, which the engine uses to
    /// extrapolate speed for every registry model.
    pub effective_bandwidth_gbps: f64,
    /// prompt_tok/s × the calibration model's active parameters (billions):
    /// how much prompt this machine can chew through, in a form that scales to
    /// other models. Generation is bandwidth-bound and prefill is
    /// compute-bound, so it needs its own constant rather than a share of the
    /// bandwidth figure.
    ///
    /// `None` when the runtime returned no prompt timing — a time-to-first-
    /// token we cannot measure is one we do not report.
    #[serde(default)]
    pub prefill_capacity: Option<f64>,
}

/// Pick the calibration model: the smallest *dense* registry model already
/// installed (no download), else the smallest dense model with an Ollama tag
/// (caller pulls it first). MoE models are excluded — their per-token traffic
/// is not the full file, so they can't anchor the bandwidth estimate.
pub fn calibration_candidates(registry: &Registry, installed: &[String]) -> (Option<String>, String) {
    let mut dense: Vec<(&str, f64)> = registry
        .models
        .iter()
        .filter(|m| !m.is_moe())
        .filter_map(|m| {
            let tag = m.ollama_tag.as_deref()?;
            let size = m.quantizations.values().map(|q| q.file_size_gb).fold(f64::MAX, f64::min);
            Some((tag, size))
        })
        .collect();
    dense.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    let installed_pick = dense
        .iter()
        .find(|(tag, _)| installed.iter().any(|i| i == &normalize_tag(tag)))
        .map(|(tag, _)| tag.to_string());
    let fallback = dense.first().map(|(t, _)| t.to_string()).unwrap_or_default();
    (installed_pick, fallback)
}

/// The registry model and quant a runtime tag names.
///
/// The benchmark measured one specific file, so the exact quant whose install
/// tag was run is resolved first — quant tags are distinct per rung, so
/// "llama3.1:8b-instruct-q6_K" matches Q6_K rather than whichever quant
/// happens to sort first. A bare model tag ("llama3.1:8b") pulls the runtime's
/// default quant.
fn resolve_tag<'a>(registry: &'a Registry, tag: &str) -> Option<(&'a Model, &'a Quant)> {
    let norm = normalize_tag(tag);
    let exact = registry.models.iter().find_map(|m| {
        m.quantizations
            .values()
            .find(|q| q.ollama_tag.as_deref().map(normalize_tag) == Some(norm.clone()))
            .map(|q| (m, q))
    });
    match exact {
        Some(pair) => Some(pair),
        None => {
            let m = registry
                .models
                .iter()
                .find(|m| m.ollama_tag.as_deref().map(normalize_tag) == Some(norm.clone()))?;
            let q = m
                .quantizations
                .get(DEFAULT_QUANT)
                .or_else(|| m.quantizations.values().next())?;
            Some((m, q))
        }
    }
}

/// GB each generated token touches for a registry model+quant (dense: the
/// whole file). Used to convert measured tok/s into effective bandwidth.
pub fn gb_per_token(registry: &Registry, tag: &str) -> Option<f64> {
    let (model, quant) = resolve_tag(registry, tag)?;
    let bytes_per_weight = quant.file_size_gb / model.parameters_b;
    Some(model.speed_params_b() * bytes_per_weight)
}

/// Active parameters (billions) of the model a tag names.
///
/// Prefill cost scales with the parameters each token is pushed through, so
/// this is what turns one machine's measured prompt throughput into a figure
/// that applies to every other model.
pub fn active_params_b(registry: &Registry, tag: &str) -> Option<f64> {
    resolve_tag(registry, tag).map(|(m, _)| m.speed_params_b())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_prefers_installed_dense_model() {
        let reg = Registry::bundled();
        let (pick, fallback) =
            calibration_candidates(&reg, &["llama3.1:8b".to_string(), "qwen3:30b".to_string()]);
        // llama3.1:8b is installed and dense → picked; MoE 30B never is.
        assert_eq!(pick.as_deref(), Some("llama3.1:8b"));
        // With nothing installed, the fallback is the smallest dense model.
        assert_eq!(fallback, "llama3.2:3b");
    }

    #[test]
    fn gb_per_token_is_file_size_for_dense() {
        let reg = Registry::bundled();
        // Dense model → each token touches ~the whole file of the quant the
        // bare tag actually pulls, which is the runtime default (not the
        // smallest rung on the ladder).
        let g = gb_per_token(&reg, "llama3.1:8b").unwrap();
        let expected = reg
            .models
            .iter()
            .find(|m| m.id == "llama3.1-8b")
            .unwrap()
            .quantizations["Q4_K_M"]
            .file_size_gb;
        assert!((g - expected).abs() < 0.01, "{g} vs {expected}");
    }

    #[test]
    fn gb_per_token_resolves_the_quant_that_was_run() {
        let reg = Registry::bundled();
        let model = reg.models.iter().find(|m| m.id == "llama3.1-8b").unwrap();
        // Benchmarking a non-default rung must use that rung's file size,
        // otherwise the measured bandwidth is scaled by the wrong weight.
        for (qname, q) in &model.quantizations {
            let tag = q.ollama_tag.as_deref().expect("every quant is installable");
            let g = gb_per_token(&reg, tag).unwrap();
            assert!(
                (g - q.file_size_gb).abs() < 0.01,
                "{qname}: {g} vs {}",
                q.file_size_gb
            );
        }
    }

    #[test]
    fn no_two_benchmark_runs_send_the_same_prompt() {
        // The whole point: a repeated prompt is served from the runtime's
        // cache, and the second run then times the cache instead of the model.
        let a = measurement_prompt();
        let b = measurement_prompt();
        assert_ne!(a, b, "a re-run would be served from the prompt cache");
        // The nonce must lead: caches match on prefix, so a trailing nonce
        // would still let almost the whole prompt hit.
        let common = a
            .chars()
            .zip(b.chars())
            .take_while(|(x, y)| x == y)
            .count();
        assert!(common < 8, "prompts share a {common}-char prefix; nonce is not leading");
        // Still a real prompt, not just the nonce.
        assert!(a.len() > 400, "prompt too short to measure prefill");
    }

    #[test]
    fn a_cached_prompt_reports_no_prefill_rather_than_a_fast_lie() {
        // The real shape of the bug: a handful of evaluated tokens in a
        // near-zero duration, whose ratio is a spectacular wrong number.
        assert_eq!(prompt_tok_per_sec(Some(3), Some(5_000)), 0.0);
        assert_eq!(prompt_tok_per_sec(Some(0), Some(0)), 0.0);
        // Missing timing is equally unknown, not zero throughput.
        assert_eq!(prompt_tok_per_sec(None, Some(1_000_000)), 0.0);
        assert_eq!(prompt_tok_per_sec(Some(200), None), 0.0);
        // A duration of zero cannot produce a rate, however many tokens.
        assert_eq!(prompt_tok_per_sec(Some(500), Some(0)), 0.0);

        // A real evaluation of the whole prompt is reported as measured:
        // 220 tokens in 1.1 s is 200 tok/s.
        let tps = prompt_tok_per_sec(Some(220), Some(1_100_000_000));
        assert!((tps - 200.0).abs() < 0.001, "got {tps}");
    }
}
