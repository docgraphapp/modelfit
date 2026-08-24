use modelfit_hardware::HardwareInfo;
use modelfit_recommendation::{recommend, Recommendations, Request};
use modelfit_registry::Registry;

#[tauri::command]
fn detect_hardware() -> HardwareInfo {
    modelfit_hardware::detect()
}

#[tauri::command]
fn get_recommendations(request: Option<Request>) -> Recommendations {
    let hw = modelfit_hardware::detect();
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
