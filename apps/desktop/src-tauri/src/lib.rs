use modelfit_hardware::HardwareInfo;
use modelfit_recommendation::{recommend, Recommendations, Request};
use modelfit_registry::Registry;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![detect_hardware, get_recommendations])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
