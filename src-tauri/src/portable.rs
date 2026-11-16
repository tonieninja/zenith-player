use std::path::{Path, PathBuf};

use tauri::{ipc::Channel, AppHandle};

// instalatory NSIS i MSI wpisują w swoją kopię exe typ paczki, a portable to goły exe z target/release
pub fn is_portable() -> bool {
    cfg!(windows) && !cfg!(debug_assertions) && tauri::utils::platform::bundle_type().is_none()
}

#[tauri::command]
pub fn app_is_portable() -> bool {
    is_portable()
}

pub fn cleanup_old_exe() {
    if !is_portable() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(with_suffix(&exe, "old"));
    }
}

async fn find_update(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    // bez własnego klucza aktualizator bierze instalator NSIS, który instaluje obok i zostawia portable stary
    let target = tauri_plugin_updater::target()
        .map(|t| format!("{t}-portable"))
        .ok_or("unsupported platform")?;
    app.updater_builder()
        .target(target)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn portable_update_check(app: AppHandle) -> Result<Option<String>, String> {
    if !is_portable() {
        return Ok(None);
    }
    Ok(find_update(&app).await?.map(|u| u.version))
}

#[tauri::command]
pub async fn portable_update_install(
    app: AppHandle,
    on_progress: Channel<Option<u32>>,
) -> Result<(), String> {
    if !is_portable() {
        return Err("not portable".into());
    }
    let update = find_update(&app).await?.ok_or("no update")?;
    let (mut got, mut last) = (0u64, None);
    let bytes = update
        .download(
            |n, total| {
                got += n as u64;
                let pct = total
                    .filter(|t| *t > 0)
                    .map(|t| (got * 100 / t).min(100) as u32);
                if pct != last {
                    last = pct;
                    let _ = on_progress.send(pct);
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    swap_exe(&exe, &bytes).map_err(|e| e.to_string())?;
    relaunch_after_exit(&exe);
    crate::windows::graceful_shutdown(&app);
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".");
    s.push(suffix);
    PathBuf::from(s)
}

// działający exe na Windows da się przemianować, ale nie nadpisać, więc stary odchodzi na bok jako .old
fn swap_exe(exe: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let new = with_suffix(exe, "new");
    let old = with_suffix(exe, "old");
    if let Err(e) = std::fs::write(&new, bytes) {
        let _ = std::fs::remove_file(&new);
        return Err(e);
    }
    let _ = std::fs::remove_file(&old);
    if let Err(e) = std::fs::rename(exe, &old) {
        let _ = std::fs::remove_file(&new);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&new, exe) {
        let _ = std::fs::rename(&old, exe);
        let _ = std::fs::remove_file(&new);
        return Err(e);
    }
    Ok(())
}

// nowa wersja wystartowana przed wyjściem starej trafiłaby na blokadę jednej instancji i od razu się zamknęła
fn relaunch_after_exit(exe: &Path) {
    #[cfg(windows)]
    {
        // ścieżka idzie przez zmienną, bo cudzysłów ’ w nazwie folderu zamknąłby napis w skrypcie
        let script = format!(
            "Wait-Process -Id {} -ErrorAction SilentlyContinue; Start-Process -FilePath $env:ZENITH_RELAUNCH",
            std::process::id()
        );
        let _ = crate::remote::hidden_powershell()
            .arg(script)
            .env("ZENITH_RELAUNCH", exe)
            .spawn();
    }
    #[cfg(not(windows))]
    let _ = exe;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_keeps_the_old_exe_aside_and_puts_the_new_one_in_place() {
        let dir = std::env::temp_dir().join(format!("zenith-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("Zenith_portable.exe");
        std::fs::write(&exe, b"old").unwrap();
        std::fs::write(with_suffix(&exe, "old"), b"older").unwrap();
        swap_exe(&exe, b"new").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        assert_eq!(std::fs::read(with_suffix(&exe, "old")).unwrap(), b"old");
        assert!(!with_suffix(&exe, "new").exists());
        // brak pliku źródłowego: nic nie może zostać w pół drogi
        let missing = dir.join("missing.exe");
        assert!(swap_exe(&missing, b"x").is_err());
        assert!(!with_suffix(&missing, "new").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
