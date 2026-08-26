//! ModelFit model registry: the "small light database" of model facts.
//!
//! Static facts only (sizes, params, quality scores — true for everyone);
//! everything machine-specific is computed by the recommendation engine.
//! Ships as JSON: a bundled snapshot for offline/first-run, refreshed from the
//! remote registry at runtime (M5).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub schema_version: u32,
    pub version: String,
    pub models: Vec<Model>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub family: String,
    /// Total parameters (billions) — drives MEMORY.
    pub parameters_b: f64,
    /// MoE active parameters (billions) — drives SPEED. `None` for dense.
    pub active_parameters_b: Option<f64>,
    pub max_context: u32,
    pub capabilities: Vec<String>,
    pub quality: Quality,
    /// Quant name (e.g. "Q4_K_M") → facts.
    pub quantizations: BTreeMap<String, Quant>,
    pub ollama_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub general: f64,
    pub coding: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quant {
    pub file_size_gb: f64,
    /// KV cache is computed per requested context — never a flat number.
    pub kv_cache_gb_per_1k_ctx: f64,
    /// Install tag for THIS quant. The model-level `ollama_tag` names only the
    /// runtime's default quant, so recommending any other rung needs its own
    /// tag or the install pulls something different from what was assessed.
    /// `None` when the pipeline could not verify one (offline builds).
    #[serde(default)]
    pub ollama_tag: Option<String>,
}

impl Model {
    /// Install tag for one quant: its own if the pipeline verified one, else
    /// the model default (correct only for the runtime's default quant).
    pub fn install_tag(&self, quant: &str) -> Option<String> {
        self.quantizations
            .get(quant)
            .and_then(|q| q.ollama_tag.clone())
            .or_else(|| self.ollama_tag.clone())
    }

    /// Params that each generated token actually touches (speed math).
    pub fn speed_params_b(&self) -> f64 {
        self.active_parameters_b.unwrap_or(self.parameters_b)
    }
    pub fn is_moe(&self) -> bool {
        self.active_parameters_b.is_some()
    }
}

const BUNDLED: &str = include_str!("../../../registry/registry.json");

impl Registry {
    /// The snapshot compiled into the binary (offline/first-run fallback).
    pub fn bundled() -> Registry {
        serde_json::from_str(BUNDLED).expect("bundled registry.json is invalid")
    }

    pub fn parse(json: &str) -> Result<Registry, serde_json::Error> {
        serde_json::from_str(json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_parses_and_is_sane() {
        let r = Registry::bundled();
        assert!(r.models.len() >= 10);
        for m in &r.models {
            assert!(m.parameters_b > 0.0, "{}", m.id);
            assert!(!m.quantizations.is_empty(), "{}", m.id);
            if let Some(active) = m.active_parameters_b {
                assert!(active < m.parameters_b, "{}: MoE active >= total", m.id);
            }
            for (qname, q) in &m.quantizations {
                assert!(q.file_size_gb > 0.0, "{} {}", m.id, qname);
                assert!(q.kv_cache_gb_per_1k_ctx > 0.0, "{} {}", m.id, qname);
            }
        }
    }

    #[test]
    fn moe_speed_params_use_active() {
        let r = Registry::bundled();
        let moe = r.models.iter().find(|m| m.id == "qwen3-30b-a3b").unwrap();
        assert!(moe.is_moe());
        assert!(moe.speed_params_b() < 5.0);
    }
}
