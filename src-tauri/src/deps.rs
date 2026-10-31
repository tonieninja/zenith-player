//! boot-time refresh for yt-dlp + innertube client version, dont block the ui
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

use crate::ytdlp;
use crate::ytm_api;

static LAST_FULL: Mutex<Option<Instant>> = Mutex::new(None);
static REFRESHING: Mutex<()> = Mutex::new(());

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DepReport {
    pub ytdlp_version: Option<String>,
    pub ytdlp_updated: bool,
    pub innertube_version: Option<String>,
    pub innertube_key: Option<String>,
    pub innertube_updated: bool,
}

fn snapshot() -> DepReport {
    let inn = ytm_api::current_innertube();
    DepReport {
        ytdlp_version: None,
        ytdlp_updated: false,
        innertube_version: Some(inn.client_version).filter(|s| !s.is_empty()),
        innertube_key: Some(inn.api_key).filter(|s| !s.is_empty()),
        innertube_updated: false,
    }
}

pub fn hydrate(app: &AppHandle) {
    ytm_api::hydrate_innertube(app);
}

pub fn refresh_all(app: &AppHandle) -> DepReport {
    let _busy = REFRESHING.lock().unwrap_or_else(|e| e.into_inner());
    hydrate(app);
    if let Ok(g) = LAST_FULL.lock() {
        if let Some(at) = *g {
            if at.elapsed() < Duration::from_secs(45) {
                return snapshot();
            }
        }
    }

    let inn = ytm_api::refresh_innertube(app);
    let ytd = ytdlp::refresh_ytdlp(app);
    if let Ok(mut g) = LAST_FULL.lock() {
        *g = Some(Instant::now());
    }
    DepReport {
        ytdlp_version: ytd
            .as_ref()
            .ok()
            .map(|r| r.version.clone())
            .filter(|s| !s.is_empty()),
        ytdlp_updated: ytd.as_ref().map(|r| r.updated).unwrap_or(false),
        innertube_version: Some(inn.client_version).filter(|s| !s.is_empty()),
        innertube_key: Some(inn.api_key).filter(|s| !s.is_empty()),
        innertube_updated: inn.updated,
    }
}

#[tauri::command]
pub fn get_innertube_config(app: AppHandle) -> ytm_api::InnertubeConfig {
    ytm_api::hydrate_innertube(&app);
    ytm_api::current_innertube()
}

#[tauri::command]
pub async fn refresh_playback_deps(app: AppHandle) -> Result<DepReport, String> {
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || refresh_all(&app2))
        .await
        .map_err(|e| e.to_string())
}
