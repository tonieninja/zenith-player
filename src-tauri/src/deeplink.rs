// zenith://play?v=<id>; inne adresy są ignorowane, bo link może przyjść z dowolnej strony w przeglądarce
pub fn video_id(url: &str) -> Option<String> {
    let rest = url.strip_prefix("zenith://")?;
    let (path, query) = rest.split_once('?')?;
    if path.trim_end_matches('/') != "play" {
        return None;
    }
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("v="))
        .filter(|id| crate::downloads::valid_id(id))
        .map(str::to_string)
}

pub fn from_args<S: AsRef<str>>(args: &[S]) -> Option<String> {
    args.iter().find_map(|a| video_id(a.as_ref()))
}

pub fn deliver(app: &tauri::AppHandle, id: &str) {
    use tauri::Emitter;
    if !crate::windows::defer_ui_event("zenith-deeplink", id) {
        let _ = app.emit_to("main", "zenith-deeplink", id);
    }
}

#[tauri::command]
pub fn deeplink_register(on: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // AppImage startuje z tymczasowego montowania, więc w systemie zapisujemy ścieżkę do samego pliku
    let exe = std::env::var_os("APPIMAGE").map(Into::into).unwrap_or(exe);
    imp::register(on, &exe)
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
    };

    const KEY: &str = r"Software\Classes\zenith";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    fn set(path: &str, name: &str, value: &str) -> Result<(), String> {
        let mut key: HKEY = std::ptr::null_mut();
        let data = wide(value);
        let name = wide(name);
        unsafe {
            if RegCreateKeyW(HKEY_CURRENT_USER, wide(path).as_ptr(), &mut key) != 0 {
                return Err(format!("registry {path}"));
            }
            let r = RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            );
            RegCloseKey(key);
            if r != 0 {
                return Err(format!("registry value {path}"));
            }
        }
        Ok(())
    }

    pub fn register(on: bool, exe: &std::path::Path) -> Result<(), String> {
        if !on {
            unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(KEY).as_ptr()) };
            return Ok(());
        }
        let exe = exe.display().to_string();
        set(KEY, "", "URL:Zenith")?;
        set(KEY, "URL Protocol", "")?;
        set(&format!(r"{KEY}\DefaultIcon"), "", &format!("\"{exe}\",0"))?;
        set(
            &format!(r"{KEY}\shell\open\command"),
            "",
            &format!("\"{exe}\" \"%1\""),
        )
    }
}

#[cfg(target_os = "linux")]
mod imp {
    const FILE: &str = "zenith-url-handler.desktop";

    pub fn register(on: bool, exe: &std::path::Path) -> Result<(), String> {
        let dir = std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".local/share"))
            })
            .ok_or("no home")?
            .join("applications");
        let file = dir.join(FILE);
        if !on {
            let _ = std::fs::remove_file(&file);
            return Ok(());
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let body = format!(
            "[Desktop Entry]\nType=Application\nName=Zenith\nNoDisplay=true\nExec=\"{}\" %u\nMimeType=x-scheme-handler/zenith;\n",
            exe.display()
        );
        std::fs::write(&file, body).map_err(|e| e.to_string())?;
        let _ = std::process::Command::new("xdg-mime")
            .args(["default", FILE, "x-scheme-handler/zenith"])
            .status();
        Ok(())
    }
}

// na macOS schemat rejestruje wpis w Info.plist przy budowaniu paczki, więc przełącznik nie ma tam czego zmieniać
#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    pub fn register(_on: bool, _exe: &std::path::Path) -> Result<(), String> {
        Err("unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_play_links_with_a_valid_id_pass() {
        assert_eq!(
            video_id("zenith://play?v=HyHNuVaZJ-k").as_deref(),
            Some("HyHNuVaZJ-k")
        );
        assert_eq!(
            video_id("zenith://play/?t=3&v=HyHNuVaZJ-k").as_deref(),
            Some("HyHNuVaZJ-k")
        );
        assert_eq!(video_id("zenith://play?v=../../etc"), None);
        assert_eq!(video_id("zenith://play?v=HyHNuVaZJ-k%22"), None);
        assert_eq!(video_id("zenith://delete?v=HyHNuVaZJ-k"), None);
        assert_eq!(
            video_id("https://music.youtube.com/watch?v=HyHNuVaZJ-k"),
            None
        );
        let args = ["zenith.exe", "--flag", "zenith://play?v=HyHNuVaZJ-k"];
        assert_eq!(from_args(&args).as_deref(), Some("HyHNuVaZJ-k"));
        assert_eq!(from_args(&["zenith.exe"]), None);
    }
}
