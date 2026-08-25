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

/// First paint is done — show the window (see setup).
#[tauri::command]
async fn frontend_ready(window: tauri::WebviewWindow) {
    log::info!("frontend_ready received; showing window");
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
async fn detect_hardware() -> HardwareInfo {
    // Subprocess + sysfs probing; spawn_blocking keeps it off both the main
    // thread (which a sync command would block) and the async workers.
    tauri::async_runtime::spawn_blocking(modelfit_hardware::detect)
        .await
        .unwrap_or_else(|_| modelfit_hardware::detect())
}

/// `hardware` lets the frontend reuse one detection (and, later, pass
/// user-edited specs) so preset/context changes recompute instantly instead of
/// re-probing the machine on every call.
#[tauri::command]
async fn get_recommendations(
    app: tauri::AppHandle,
    hardware: Option<HardwareInfo>,
    request: Option<Request>,
) -> Recommendations {
    let hw = hardware.unwrap_or_else(modelfit_hardware::detect);
    let (registry, _) = effective_registry(&app);
    recommend(&hw, &registry, &request.unwrap_or_default())
}

#[tauri::command]
async fn registry_info(app: tauri::AppHandle) -> RegistryInfo {
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

/// Forward pull progress to the UI, rate-limited. Ollama emits one NDJSON
/// line per network chunk — hundreds per second on a fast connection — and
/// each forwarded event costs an IPC round-trip plus a React re-render.
/// Phase changes ("verifying sha256…", "success") always go through; byte
/// updates within a phase are capped at ~10/s.
fn throttled_emitter(app: tauri::AppHandle) -> impl Fn(modelfit_runtime_adapters::PullProgress) {
    let last = std::sync::Mutex::new((String::new(), std::time::Instant::now() - std::time::Duration::from_secs(1)));
    move |p| {
        let mut g = last.lock().unwrap();
        let now = std::time::Instant::now();
        if p.status != g.0 || now.duration_since(g.1) >= std::time::Duration::from_millis(100) {
            *g = (p.status.clone(), now);
            let _ = app.emit("modelfit://pull-progress", &p);
        }
    }
}

/// Pull a model into Ollama, streaming progress to the UI as
/// `modelfit://pull-progress` events.
#[tauri::command]
async fn install_model(app: tauri::AppHandle, tag: String) -> Result<(), String> {
    let ollama = Ollama::default();
    ollama.pull(&tag, &throttled_emitter(app)).await
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
            ollama.pull(&fallback, &throttled_emitter(app.clone())).await?;
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
        // Startup trace: release builds have been seen white-screening with
        // no navigation at all — this line in the log file is the fastest way
        // to tell "assets never loaded" from "frontend crashed after load".
        .on_page_load(|_window, payload| {
            log::info!("page load: {:?} {}", payload.event(), payload.url());
        })
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            // macOS keeps its native traffic lights, floated over the app's own
            // title bar by `titleBarStyle: Overlay`. Everywhere else the system
            // frame comes off entirely and TitleBar.tsx draws the controls.
            #[cfg(not(target_os = "macos"))]
            window.set_decorations(false)?;
            // The window stays hidden until the frontend reports ready
            // (frontend_ready below), so it appears with the UI already
            // painted instead of flashing an empty dark webview. The frame
            // change above also lands before anything is visible. Fallback:
            // if the frontend never reports in (crash, dev-server down),
            // show anyway so a broken build is debuggable rather than
            // invisible.
            let fallback = window.clone();
            tauri::async_runtime::spawn(async move {
                // std sleep: this dedicated fallback task may block its slot.
                let _ = tauri::async_runtime::spawn_blocking(|| {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                })
                .await;
                if !fallback.is_visible().unwrap_or(true) {
                    let _ = fallback.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
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
