//! ModelFit model registry: the "small light database" of model facts.
//!
//! Static facts only (sizes, params, quality scores — true for everyone);
//! everything machine-specific is computed by the recommendation engine.
//! Ships as JSON: a bundled snapshot for offline/first-run, refreshed from the
//! remote registry at runtime (M5).

use serde::{Deserialize, Serialize};

/// The rung a bare runtime tag pulls, and the baseline every model is ranked
/// at so scores stay comparable across models.
pub const DEFAULT_QUANT: &str = "Q4_K_M";
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
    /// Absent for a discovered model that nothing has rated yet.
    #[serde(default)]
    pub quality: Option<Quality>,
    /// Quant name (e.g. "Q4_K_M") → facts.
    pub quantizations: BTreeMap<String, Quant>,
    pub ollama_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub general: f64,
    pub coding: f64,
    /// Where the scores came from: `"hand"` for a curated entry, otherwise the
    /// id of the automated source (e.g. a leaderboard). Absent means hand —
    /// every entry predating the field was written by a person.
    #[serde(default)]
    pub source: Option<String>,
}

impl Quality {
    /// The one source that makes a model eligible to be recommended.
    pub const HAND: &'static str = "hand";

    pub fn is_curated(&self) -> bool {
        self.source.as_deref().unwrap_or(Self::HAND) == Self::HAND
    }
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
    /// Where `file_size_gb` came from: `"hf"` (exact file listing) or
    /// `"fallback"` (the curated guess in models.yaml, used when the lookup
    /// failed). Absent in registries built before the field existed, which is
    /// read as `"hf"` — the pipeline only falls back when it warns, so
    /// assuming the good case keeps old snapshots honest rather than marking
    /// every number unknown.
    #[serde(default)]
    pub size_source: Option<String>,
    /// Where `kv_cache_gb_per_1k_ctx` came from: `"gguf"` (computed from the
    /// file's own header) or `"fallback"`. Same absent-means-good rule.
    #[serde(default)]
    pub kv_source: Option<String>,
}

/// True when a source marker names a curated fallback rather than a fact read
/// from the file itself.
fn is_fallback(source: &Option<String>) -> bool {
    source.as_deref() == Some("fallback")
}

impl Quant {
    /// Whether both numbers behind this rung's memory estimate were read from
    /// the model file, or at least one is a curated fallback.
    pub fn facts_are_measured(&self) -> bool {
        !is_fallback(&self.size_source) && !is_fallback(&self.kv_source)
    }
}

impl Model {
    /// Whether this model may be offered as a BEST / SAFE / FAST pick.
    ///
    /// Only a hand-curated quality score qualifies. A discovered model is
    /// still listed with its memory and speed — those are facts read out of
    /// the model file, and they answer "will this run here". But a pick
    /// asserts "this is the best one for you", and that claim rests entirely
    /// on a quality number. Ranking a model nobody has assessed, or one an
    /// automated leaderboard scored on benchmarks that may not survive
    /// quantization, would spend exactly the trust the recommendation exists
    /// to earn. Discovery is automated; eligibility is curated.
    pub fn is_recommendable(&self) -> bool {
        self.quality.as_ref().is_some_and(|q| q.is_curated())
    }

    /// The quality score for an objective, if this model has one at all.
    pub fn quality_for(&self, coding: bool) -> Option<f64> {
        self.quality
            .as_ref()
            .map(|q| if coding { q.coding } else { q.general })
    }

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
            if let Some(q) = &m.quality {
                assert!(q.general > 0.0 && q.general <= 10.0, "{}", m.id);
                assert!(q.coding > 0.0 && q.coding <= 10.0, "{}", m.id);
            }
        }
    }

    #[test]
    fn the_snapshot_ships_both_tiers_and_can_always_recommend_something() {
        // The discovered tier makes the catalogue big; the curated tier is what
        // makes a pick possible. A snapshot with nothing curated would render
        // an app that lists a hundred models and recommends none of them.
        let r = Registry::bundled();
        let curated = r.models.iter().filter(|m| m.is_recommendable()).count();
        assert!(curated >= 10, "only {curated} curated models in the snapshot");
        // Nothing may reach the curated tier by accident: an entry is either
        // hand-written or it carries a source saying it was not.
        for m in r.models.iter().filter(|m| !m.is_recommendable()) {
            assert!(
                m.quality.as_ref().is_none_or(|q| q.source.is_some()),
                "{}: uncurated but claims no source",
                m.id
            );
        }
    }

    #[test]
    fn only_hand_curated_quality_makes_a_model_recommendable() {
        let mut m = Registry::bundled().models.remove(0);
        assert!(m.is_recommendable(), "curated by default");

        m.quality.as_mut().unwrap().source = Some("leaderboard-v2".into());
        assert!(
            !m.is_recommendable(),
            "a provisional score is not a curation"
        );
        assert_eq!(m.quality_for(false), Some(6.6), "but it is still reported");

        m.quality = None;
        assert!(!m.is_recommendable());
        assert_eq!(m.quality_for(false), None);
    }

    #[test]
    fn moe_speed_params_use_active() {
        let r = Registry::bundled();
        let moe = r.models.iter().find(|m| m.id == "qwen3-30b-a3b").unwrap();
        assert!(moe.is_moe());
        assert!(moe.speed_params_b() < 5.0);
    }
}
