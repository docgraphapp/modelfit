//! Runtime adapters: ModelFit never runs models itself — a runtime is only
//! the *executor* of a recommendation. v1 ships the Ollama adapter; the trait
//! is the seam where llama.cpp-direct (and LM Studio) slot in later.

use async_trait::async_trait;
use futures_util::StreamExt;
use modelfit_registry::Registry;
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
        let prompt = "Summarize, in your own words, why the sky appears blue during the day \
                      and red at sunset. Cover Rayleigh scattering, the wavelength dependence, \
                      and the longer atmospheric path at dusk. "
            .repeat(4);
        let g = self.generate(tag, &prompt, 160).await?;
        let (Some(ec), Some(ed)) = (g.eval_count, g.eval_duration) else {
            return Err("runtime returned no timing data".into());
        };
        if ed == 0 || ec < 16 {
            return Err(format!("measurement too short ({ec} tokens)"));
        }
        let gen = ec as f64 / (ed as f64 / 1e9);
        let prompt_tps = match (g.prompt_eval_count, g.prompt_eval_duration) {
            (Some(c), Some(d)) if d > 0 => c as f64 / (d as f64 / 1e9),
            _ => 0.0,
        };
        Ok(Measurement {
            model_tag: normalize_tag(tag),
            gen_tok_per_sec: gen,
            prompt_tok_per_sec: prompt_tps,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    pub model_tag: String,
    pub gen_tok_per_sec: f64,
    pub prompt_tok_per_sec: f64,
    /// gen_tok/s × GB-touched-per-token of the calibration model: the
    /// machine's real effective memory bandwidth, which the engine uses to
    /// extrapolate speed for every registry model.
    pub effective_bandwidth_gbps: f64,
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

/// GB each generated token touches for a registry model+quant (dense: the
/// whole file). Used to convert measured tok/s into effective bandwidth.
pub fn gb_per_token(registry: &Registry, tag: &str) -> Option<f64> {
    let norm = normalize_tag(tag);
    let model = registry
        .models
        .iter()
        .find(|m| m.ollama_tag.as_deref().map(normalize_tag) == Some(norm.clone()))?;
    let quant = model.quantizations.values().next()?;
    let bytes_per_weight = quant.file_size_gb / model.parameters_b;
    Some(model.speed_params_b() * bytes_per_weight)
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
        // Dense model → each token touches ~the whole smallest-quant file.
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
}
