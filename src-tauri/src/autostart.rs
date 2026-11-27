use std::path::{Path, PathBuf};

pub const MINIMIZED_ARG: &str = "--minimized";
const NAME: &str = "Zenith";
// etykieta LaunchAgenta to identyfikator paczki z tauri.conf.json (pilnuje tego test)
#[cfg(any(target_os = "macos", test))]
const BUNDLE_ID: &str = "com.zenithplayer.desktop";

#[derive(serde::Serialize, Default, PartialEq, Debug)]
pub struct State {
    enabled: bool,
    minimized: bool,
}

/// Flatpak startuje przez `flatpak run`, AppImage przez plik obrazu (exe siedzi w tymczasowym montowaniu),
/// reszta, także wersja portable, przez bieżącą ścieżkę exe.
fn command(
    exe: &Path,
    appimage: Option<PathBuf>,
    flatpak: Option<String>,
    minimized: bool,
) -> Vec<String> {
    let mut cmd = match (flatpak, appimage) {
        (Some(id), _) => vec!["flatpak".into(), "run".into(), id],
        (None, Some(img)) => vec![img.display().to_string()],
        _ => vec![exe.display().to_string()],
    };
    if minimized {
        cmd.push(MINIMIZED_ARG.into());
    }
    cmd
}

/// Argumenty po programie; ścieżka w cudzysłowie może zawierać spacje, więc liczy się tekst za ostatnim.
#[cfg(any(not(target_os = "macos"), test))]
fn has_minimized(cmdline: &str) -> bool {
    cmdline
        .rsplit('"')
        .next()
        .is_some_and(|rest| rest.split_whitespace().any(|a| a == MINIMIZED_ARG))
}

pub fn launched_minimized(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == MINIMIZED_ARG)
}

#[tauri::command]
pub fn autostart_get() -> State {
    imp::get()
}

#[tauri::command]
pub fn autostart_set(enabled: bool, minimized: bool) -> Result<State, String> {
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
        imp::enable(&command(
            &exe,
            appimage,
            std::env::var("FLATPAK_ID").ok(),
            minimized,
        ))?;
    } else {
        imp::disable()?;
    }
    Ok(imp::get())
}

#[cfg(windows)]
mod imp {
    use super::{has_minimized, State, NAME};
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
        RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
    };

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    fn read(key: &str, flags: u32) -> Option<Vec<u8>> {
        let (key, name) = (wide(key), wide(NAME));
        let mut len = 0u32;
        let get = |buf: *mut u8, len: &mut u32| unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                std::ptr::null_mut(),
                buf.cast(),
                len,
            )
        };
        if get(std::ptr::null_mut(), &mut len) != 0 {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        (get(buf.as_mut_ptr(), &mut len) == 0).then(|| {
            buf.truncate(len as usize);
            buf
        })
    }

    fn delete(key: &str) {
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, wide(key).as_ptr(), wide(NAME).as_ptr()) };
    }

    pub fn get() -> State {
        let Some(raw) = read(RUN, RRF_RT_REG_SZ) else {
            return State::default();
        };
        let units: Vec<u16> = raw
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        let value = String::from_utf16_lossy(&units);
        // wyłączenie w Menedżerze zadań zostawia wpis Run, a nieparzysty pierwszy bajt StartupApproved go blokuje
        let blocked = read(APPROVED, RRF_RT_REG_BINARY)
            .is_some_and(|b| b.first().is_some_and(|f| f & 1 == 1));
        State {
            enabled: !blocked,
            minimized: has_minimized(value.trim_end_matches('\0')),
        }
    }

    pub fn enable(cmd: &[String]) -> Result<(), String> {
        let line = super::windows_line(cmd);
        let data = wide(&line);
        let r = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                wide(RUN).as_ptr(),
                wide(NAME).as_ptr(),
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        };
        if r != 0 {
            return Err(format!("registry {r}"));
        }
        // włączenie z aplikacji zdejmuje blokadę z Menedżera zadań, inaczej przełącznik kłamałby
        delete(APPROVED);
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        delete(RUN);
        delete(APPROVED);
        Ok(())
    }
}

#[cfg(any(windows, test))]
fn windows_line(cmd: &[String]) -> String {
    let (exe, args) = cmd
        .split_first()
        .map_or(("", &[][..]), |(e, a)| (e.as_str(), a));
    std::iter::once(format!("\"{exe}\""))
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(any(not(windows), test))]
mod files {
    use std::path::Path;

    pub fn write(dir: &Path, file: &str, body: &str) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(file), body).map_err(|e| e.to_string())
    }

    pub fn read(dir: &Path, file: &str) -> Option<String> {
        std::fs::read_to_string(dir.join(file)).ok()
    }

    pub fn remove(dir: &Path, file: &str) -> Result<(), String> {
        match std::fs::remove_file(dir.join(file)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

// Exec z .desktop: argument z odstępem lub znakiem specjalnym idzie w cudzysłów, a ukośnik podwaja się dwa razy
#[cfg(any(target_os = "linux", test))]
fn exec_arg(a: &str) -> String {
    let a = a.replace('%', "%%");
    if a.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./=:+,@".contains(c))
    {
        return a;
    }
    let mut s = String::from("\"");
    for c in a.chars() {
        match c {
            '\\' => s.push_str(r"\\\\"),
            '"' | '`' | '$' => {
                s.push_str(r"\\");
                s.push(c);
            }
            _ => s.push(c),
        }
    }
    s.push('"');
    s
}

#[cfg(any(target_os = "linux", test))]
fn desktop_body(cmd: &[String]) -> String {
    let exec: Vec<String> = cmd.iter().map(|a| exec_arg(a)).collect();
    format!(
        "[Desktop Entry]\nType=Application\nName={NAME}\nExec={}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        exec.join(" ")
    )
}

// menedżery autostartu w KDE i GNOME wyłączają wpis kluczem, zamiast go kasować
#[cfg(any(target_os = "linux", test))]
fn desktop_state(body: Option<String>) -> State {
    let Some(body) = body else {
        return State::default();
    };
    let lines: Vec<&str> = body.lines().map(str::trim).collect();
    let off = lines
        .iter()
        .any(|l| *l == "Hidden=true" || *l == "X-GNOME-Autostart-enabled=false");
    let exec = lines
        .iter()
        .find_map(|l| l.strip_prefix("Exec="))
        .unwrap_or("");
    State {
        enabled: !off,
        minimized: has_minimized(exec),
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{desktop_body, desktop_state, files, State};
    use std::path::PathBuf;

    const FILE: &str = "zenith.desktop";

    fn dir() -> Option<PathBuf> {
        // Flatpak podmienia XDG_CONFIG_HOME na katalog w ~/.var/app, a sesja czyta autostart z prawdziwego ~/.config
        let xdg = std::env::var_os("FLATPAK_ID")
            .is_none()
            .then(|| std::env::var_os("XDG_CONFIG_HOME"))
            .flatten()
            .map(PathBuf::from)
            .filter(|p| p.is_absolute());
        xdg.or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .map(|d| d.join("autostart"))
    }

    pub fn get() -> State {
        desktop_state(dir().and_then(|d| files::read(&d, FILE)))
    }

    pub fn enable(cmd: &[String]) -> Result<(), String> {
        files::write(&dir().ok_or("no home")?, FILE, &desktop_body(cmd))
    }

    pub fn disable() -> Result<(), String> {
        dir().map_or(Ok(()), |d| files::remove(&d, FILE))
    }
}

#[cfg(any(target_os = "macos", test))]
fn plist_body(cmd: &[String]) -> String {
    let xml = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let args: String = cmd
        .iter()
        .map(|a| format!("<string>{}</string>", xml(a)))
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>{BUNDLE_ID}</string><key>ProgramArguments</key><array>{args}</array><key>RunAtLoad</key><true/></dict></plist>\n"
    )
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{files, plist_body, State, BUNDLE_ID, MINIMIZED_ARG};
    use std::path::PathBuf;

    fn dir() -> Option<PathBuf> {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/LaunchAgents"))
    }

    fn file() -> String {
        format!("{BUNDLE_ID}.plist")
    }

    pub fn get() -> State {
        dir()
            .and_then(|d| files::read(&d, &file()))
            .map_or_else(State::default, |body| State {
                enabled: true,
                minimized: body.contains(&format!("<string>{MINIMIZED_ARG}</string>")),
            })
    }

    pub fn enable(cmd: &[String]) -> Result<(), String> {
        files::write(&dir().ok_or("no home")?, &file(), &plist_body(cmd))
    }

    pub fn disable() -> Result<(), String> {
        dir().map_or(Ok(()), |d| files::remove(&d, &file()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(appimage: Option<&str>, flatpak: Option<&str>, min: bool) -> Vec<String> {
        command(
            Path::new("/opt/Zenith/zenith"),
            appimage.map(PathBuf::from),
            flatpak.map(String::from),
            min,
        )
    }

    #[test]
    fn launch_command_points_at_what_the_user_runs() {
        assert_eq!(cmd(None, None, false), ["/opt/Zenith/zenith"]);
        assert_eq!(
            cmd(Some("/home/a/Zenith 4.7.AppImage"), None, true),
            ["/home/a/Zenith 4.7.AppImage", "--minimized"]
        );
        assert_eq!(
            cmd(Some("/x.AppImage"), Some("com.zenithplayer.desktop"), false),
            ["flatpak", "run", "com.zenithplayer.desktop"]
        );
    }

    #[test]
    fn windows_line_quotes_the_portable_path() {
        let line = windows_line(&[
            r"D:\Apps\Zenith Portable\Zenith.exe".into(),
            MINIMIZED_ARG.into(),
        ]);
        assert_eq!(line, r#""D:\Apps\Zenith Portable\Zenith.exe" --minimized"#);
        assert!(has_minimized(&line));
        assert!(!has_minimized(r#""D:\--minimized dir\Zenith.exe""#));
    }

    #[test]
    fn desktop_entry_round_trips_through_a_temp_dir() {
        let dir = std::env::temp_dir().join(format!("zautostart_{}", std::process::id()));
        let entry = desktop_body(&cmd(Some("/home/a/My Apps/Zenith.AppImage"), None, true));
        assert!(entry.contains("Exec=\"/home/a/My Apps/Zenith.AppImage\" --minimized\n"));
        files::write(&dir, "zenith.desktop", &entry).unwrap();
        let on = desktop_state(files::read(&dir, "zenith.desktop"));
        assert_eq!(
            on,
            State {
                enabled: true,
                minimized: true
            }
        );

        // tak wyłącza wpis panel autostartu w KDE
        files::write(&dir, "zenith.desktop", &format!("{entry}Hidden=true\n")).unwrap();
        assert!(!desktop_state(files::read(&dir, "zenith.desktop")).enabled);

        files::remove(&dir, "zenith.desktop").unwrap();
        files::remove(&dir, "zenith.desktop").unwrap();
        assert_eq!(
            desktop_state(files::read(&dir, "zenith.desktop")),
            State::default()
        );
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn exec_args_are_escaped() {
        assert_eq!(exec_arg("/usr/bin/zenith"), "/usr/bin/zenith");
        assert_eq!(exec_arg("/a b/100%"), "\"/a b/100%%\"");
        assert_eq!(exec_arg("/a$b"), r#""/a\\$b""#);
    }

    #[test]
    fn launch_agent_runs_at_load_with_escaped_args() {
        let body = plist_body(&[
            "/Applications/A&B.app/Contents/MacOS/zenith".into(),
            MINIMIZED_ARG.into(),
        ]);
        assert!(body.contains("<string>/Applications/A&amp;B.app/Contents/MacOS/zenith</string>"));
        assert!(body.contains("<string>--minimized</string>"));
        assert!(body.contains("<key>RunAtLoad</key><true/>"));
    }

    #[test]
    fn bundle_id_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], BUNDLE_ID);
    }

    #[test]
    fn only_the_flag_after_the_program_starts_hidden() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(launched_minimized(&args(&["zenith", "--minimized"])));
        assert!(!launched_minimized(&args(&["--minimized"])));
        assert!(!launched_minimized(&args(&["zenith", "zenith://play?v=x"])));
    }
}
