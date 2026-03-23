use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

use crate::ytm_api;

static LAST_FULL: Mutex<Option<Instant>> = Mutex::new(None);
static REFRESHING: Mutex<()> = Mutex::new(());

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DepReport {
    pub player_version: Option<String>,
    pub innertube_version: Option<String>,
    pub innertube_key: Option<String>,
    pub innertube_updated: bool,
}

fn snapshot() -> DepReport {
    let inn = ytm_api::current_innertube();
    DepReport {
        player_version: None,
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
    let player = tauri::async_runtime::block_on(crate::player_js::version());
    if let Ok(mut g) = LAST_FULL.lock() {
        *g = Some(Instant::now());
    }
    DepReport {
        player_version: player,
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
