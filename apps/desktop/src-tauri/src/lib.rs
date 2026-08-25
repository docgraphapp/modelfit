use modelfit_hardware::HardwareInfo;
use modelfit_recommendation::{recommend, Recommendations, Request};
use modelfit_registry::Registry;
use modelfit_runtime_adapters::{
    calibration_candidates, gb_per_token, Calibration, Ollama, RuntimeAdapter, RuntimeStatus,
};
use serde::Serialize;
use tauri::{Emitter, Manager};

/// Tried in order; the first that yields a valid registry wins. Three
/// independent failure domains: our domain, Cloudflare's, GitHub's — the
/// open-source repo doubles as the last-resort mirror (the same file CI
/// commits on every rebuild).
const REGISTRY_URLS: &[&str] = &[
    "https://modelfit.docgraph.app/registry/v1/registry.json",
    "https://modelfit-registry.pages.dev/registry/v1/registry.json",
    "https://raw.githubusercontent.com/docgraphapp/modelfit/main/registry/registry.json",
];

fn cache_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("registry.json"))
}

/// Cached remote registry if valid and newer than the bundled snapshot
/// (version strings are ISO dates, so string comparison is date comparison);
/// otherwise the bundled one. The app must always have a working registry.
fn effective_registry(app: &tauri::AppHandle) -> (Registry, &'static str) {
    let bundled = Registry::bundled();
    if let Some(path) = cache_path(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cached) = Registry::parse(&text) {
                if cached.schema_version == 1
                    && !cached.models.is_empty()
                    && cached.version >= bundled.version
                {
                    return (cached, "updated");
                }
            }
        }
    }
    (bundled, "bundled")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistryInfo {
    version: String,
    model_count: usize,
    source: String,
    /// Only set by update_registry: how many models are new vs. before.
    added: Option<usize>,
}

#[tauri::command]
fn detect_hardware() -> HardwareInfo {
    modelfit_hardware::detect()
}

/// `hardware` lets the frontend reuse one detection (and, later, pass
/// user-edited specs) so preset/context changes recompute instantly instead of
/// re-probing the machine on every call.
#[tauri::command]
fn get_recommendations(
    app: tauri::AppHandle,
    hardware: Option<HardwareInfo>,
    request: Option<Request>,
) -> Recommendations {
    let hw = hardware.unwrap_or_else(modelfit_hardware::detect);
    let (registry, _) = effective_registry(&app);
    recommend(&hw, &registry, &request.unwrap_or_default())
}

#[tauri::command]
fn registry_info(app: tauri::AppHandle) -> RegistryInfo {
    let (registry, source) = effective_registry(&app);
    RegistryInfo {
        version: registry.version,
        model_count: registry.models.len(),
        source: source.into(),
        added: None,
    }
}

/// Fetch the latest registry (startup refresh and the "Update registry"
/// button share this path). On any failure the cached/bundled registry stays
/// in place and the error is reported.
#[tauri::command]
async fn update_registry(app: tauri::AppHandle) -> Result<RegistryInfo, String> {
    let before: std::collections::HashSet<String> = {
        let (reg, _) = effective_registry(&app);
        reg.models.iter().map(|m| m.id.clone()).collect()
    };

    let client = reqwest::Client::new();
    let mut last_err = String::from("no registry URL configured");
    for url in REGISTRY_URLS {
        match client.get(*url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().await.map_err(|e| e.to_string())?;
                let parsed = Registry::parse(&text)
                    .map_err(|e| format!("invalid registry from {url}: {e}"))?;
                if parsed.schema_version != 1 || parsed.models.is_empty() {
                    last_err = format!("unusable registry from {url}");
                    continue;
                }
                if let Some(path) = cache_path(&app) {
                    if let Some(dir) = path.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    std::fs::write(&path, &text).map_err(|e| e.to_string())?;
                }
                let added = parsed.models.iter().filter(|m| !before.contains(&m.id)).count();
                return Ok(RegistryInfo {
                    version: parsed.version,
                    model_count: parsed.models.len(),
                    source: "updated".into(),
                    added: Some(added),
                });
            }
            Ok(resp) => last_err = format!("{url}: HTTP {}", resp.status()),
            Err(e) => last_err = format!("{url}: {e}"),
        }
    }
    Err(last_err)
}

#[tauri::command]
async fn runtime_status() -> RuntimeStatus {
    Ollama::default().status().await
}

/// Pull a model into Ollama, streaming progress to the UI as
/// `modelfit://pull-progress` events.
#[tauri::command]
async fn install_model(app: tauri::AppHandle, tag: String) -> Result<(), String> {
    let ollama = Ollama::default();
    ollama
        .pull(&tag, &move |p| {
            let _ = app.emit("modelfit://pull-progress", &p);
        })
        .await
}

/// Calibration benchmark: measure real tok/s on a small dense model (using an
/// already-installed one when possible) and derive the machine's effective
/// memory bandwidth for the engine to extrapolate from.
#[tauri::command]
async fn run_calibration(app: tauri::AppHandle) -> Result<Calibration, String> {
    let (registry, _) = effective_registry(&app);
    let ollama = Ollama::default();
    let status = ollama.status().await;
    if !status.running {
        return Err("Ollama is not running".into());
    }

    let (installed_pick, fallback) = calibration_candidates(&registry, &status.installed_tags);
    let tag = match installed_pick {
        Some(t) => t,
        None => {
            // Nothing suitable installed — pull the small fallback first.
            let app2 = app.clone();
            ollama
                .pull(&fallback, &move |p| {
                    let _ = app2.emit("modelfit://pull-progress", &p);
                })
                .await?;
            fallback
        }
    };

    let m = ollama.measure(&tag).await?;
    let gb_tok = gb_per_token(&registry, &tag)
        .ok_or_else(|| format!("{tag} is not in the model registry"))?;
    Ok(Calibration {
        model_tag: m.model_tag,
        gen_tok_per_sec: m.gen_tok_per_sec,
        prompt_tok_per_sec: m.prompt_tok_per_sec,
        effective_bandwidth_gbps: m.gen_tok_per_sec * gb_tok,
    })
}

/// Open an external page in the default browser (e.g. the Ollama download
/// page). Only https URLs.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https URLs".into());
    }
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";
    #[cfg(target_os = "windows")]
    return std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "windows"))]
    std::process::Command::new(cmd)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            detect_hardware,
            get_recommendations,
            runtime_status,
            install_model,
            run_calibration,
            open_external,
            registry_info,
            update_registry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
