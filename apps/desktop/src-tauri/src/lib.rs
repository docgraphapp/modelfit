use modelfit_hardware::HardwareInfo;
use modelfit_recommendation::{recommend, Recommendations, Request};
use modelfit_registry::Registry;
use modelfit_runtime_adapters::{
    calibration_candidates, gb_per_token, Calibration, Ollama, RuntimeAdapter, RuntimeStatus,
};
use tauri::Emitter;

#[tauri::command]
fn detect_hardware() -> HardwareInfo {
    modelfit_hardware::detect()
}

/// `hardware` lets the frontend reuse one detection (and, later, pass
/// user-edited specs) so preset/context changes recompute instantly instead of
/// re-probing the machine on every call.
#[tauri::command]
fn get_recommendations(
    hardware: Option<HardwareInfo>,
    request: Option<Request>,
) -> Recommendations {
    let hw = hardware.unwrap_or_else(modelfit_hardware::detect);
    let registry = Registry::bundled();
    recommend(&hw, &registry, &request.unwrap_or_default())
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
    let registry = Registry::bundled();
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
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
