//! In-app updates — see `docs/adr-0001-in-app-updates.md`.
//!
//! Three entry points, one code path: a background check shortly after
//! startup, a periodic re-check while the app stays open, and the manual
//! "Check for updates" button. The first two are silent about failure (the
//! app keeps working on the current version); only the manual path reports
//! what happened, because someone is waiting for an answer.
//!
//! Nothing here can delay startup: the background task is spawned from
//! `setup` *after* the first-paint path, sleeps before its first request, and
//! caps every check with a network timeout.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Long enough that the check never competes with hardware detection and the
/// registry refresh for the first seconds of the app's life.
const STARTUP_DELAY: Duration = Duration::from_secs(5);
/// A desktop app left open for days should still notice a release.
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// A stalled connection must not leave a task hanging until the app quits.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Result of a check. `available: false` carries no version — the frontend
/// shows "You're up to date" from this alone.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    /// The offered version; empty when nothing is available.
    pub version: String,
    /// Release notes from the manifest, when the release carried any.
    pub notes: Option<String>,
    /// Publication date from the manifest (RFC 3339).
    pub date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    /// Absent when the server sent no content-length.
    total: Option<u64>,
}

/// Dev builds are unsigned and versioned 0.0.0-ish relative to any real
/// release; checking would only ever produce noise in the log and a banner
/// offering to "update" a working tree.
fn enabled() -> bool {
    !cfg!(debug_assertions)
}

/// One check against the configured endpoint. Errors are the caller's to
/// interpret — silent for background checks, shown for the manual one.
async fn check(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    if !enabled() {
        log::info!("updater: skipped (dev build)");
        return Ok(UpdateInfo {
            available: false,
            current_version: current,
            ..Default::default()
        });
    }
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            current_version: current,
            version: update.version.clone(),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }),
        None => Ok(UpdateInfo {
            available: false,
            current_version: current,
            ..Default::default()
        }),
    }
}

/// The manual "Check for updates" button. Same path as the background check,
/// but the outcome reaches the user either way.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    check(&app).await
}

/// Download and install the pending update, streaming progress as
/// `updater://progress`. The app is *not* restarted here — see `restart_app`;
/// the user decides when to lose whatever is on screen.
///
/// This re-runs the check rather than holding the `Update` handle from the
/// earlier one in app state: the handle is not `Send`-friendly to park across
/// commands, and one extra fetch of a small JSON manifest is cheaper than the
/// bookkeeping — with the bonus that a release pulled in the meantime is
/// noticed instead of installed from a stale handle.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if !enabled() {
        return Err("updates are disabled in development builds".into());
    }
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    log::info!("updater: installing {}", update.version);

    // Chunk callbacks arrive far faster than the UI can paint; the emitter
    // below rate-limits them the same way model-pull progress is limited.
    let emitter = throttled_progress(app.clone());
    let downloaded = std::sync::Mutex::new(0u64);
    update
        .download_and_install(
            |chunk, total| {
                let mut done = downloaded.lock().unwrap();
                *done += chunk as u64;
                emitter(*done, total);
            },
            || log::info!("updater: download complete, installing"),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Restart into the freshly installed version. Never returns.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    log::info!("updater: restarting into new version");
    app.restart();
}

/// ~10 events/second, plus the final byte count whatever the timing — a
/// progress bar that stops one chunk short of full looks broken.
fn throttled_progress(app: AppHandle) -> impl Fn(u64, Option<u64>) {
    let last = std::sync::Mutex::new(std::time::Instant::now() - Duration::from_secs(1));
    move |downloaded, total| {
        let mut at = last.lock().unwrap();
        let now = std::time::Instant::now();
        let finished = total.is_some_and(|t| downloaded >= t);
        if finished || now.duration_since(*at) >= Duration::from_millis(100) {
            *at = now;
            let _ = app.emit("updater://progress", DownloadProgress { downloaded, total });
        }
    }
}

/// Background checking: once shortly after launch, then on a slow interval.
///
/// Spawned from `setup`, so it must not do anything expensive before its
/// first sleep. An available update is announced as `updater://available`;
/// failures only reach the log, since the user did not ask.
pub fn spawn_background_checks(app: AppHandle) {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            match check(&app).await {
                Ok(info) if info.available => {
                    log::info!("updater: {} available", info.version);
                    let _ = app.emit("updater://available", info);
                }
                Ok(_) => log::info!("updater: up to date"),
                Err(e) => log::warn!("updater: check failed: {e}"),
            }
            tokio::time::sleep(RECHECK_INTERVAL).await;
        }
    });
}
