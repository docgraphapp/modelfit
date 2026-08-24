use modelfit_hardware::HardwareInfo;

#[tauri::command]
fn detect_hardware() -> HardwareInfo {
    modelfit_hardware::detect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![detect_hardware])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
