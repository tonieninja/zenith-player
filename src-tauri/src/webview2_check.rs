use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND,
};

const BOOTSTRAPPER_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const MIN_MAJOR: u32 = 100;
const MANUAL_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn reg_pv(root: HKEY, key: &str) -> Option<String> {
    let k = wide(key);
    let v = wide("pv");
    let mut buf = [0u16; 128];
    let mut len = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            root,
            k.as_ptr(),
            v.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut _,
            &mut len,
        )
    };
    if rc != 0 {
        return None;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]))
}

pub fn installed() -> bool {
    const ID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let keys = [
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{ID}"),
        ),
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{ID}"),
        ),
        (
            HKEY_CURRENT_USER,
            format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{ID}"),
        ),
    ];
    keys.iter().any(|(root, k)| {
        reg_pv(*root, k)
            .and_then(|v| {
                v.trim()
                    .split('.')
                    .next()
                    .and_then(|m| m.parse::<u32>().ok())
            })
            .map(|major| major >= MIN_MAJOR)
            .unwrap_or(false)
    })
}

fn msg(text: &str, flags: u32) {
    let t = wide(text);
    let c = wide("Zenith");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            t.as_ptr(),
            c.as_ptr(),
            flags | MB_OK | MB_SETFOREGROUND,
        )
    };
}

fn install() -> Result<(), String> {
    let path = std::env::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
    let bytes = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .and_then(|c| c.get(BOOTSTRAPPER_URL).send())
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .map_err(|e| format!("download: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
    let st = std::process::Command::new(&path)
        .args(["/silent", "/install"])
        .status()
        .map_err(|e| format!("run: {e}"))?;
    let _ = std::fs::remove_file(&path);
    if !st.success() {
        return Err(format!("installer exit code {:?}", st.code()));
    }
    Ok(())
}

pub fn ensure() -> bool {
    if installed() {
        return true;
    }
    msg(
        "Brakuje (lub jest zbyt stare) środowiska Microsoft Edge WebView2, potrzebnego do działania Zenith.\n\
         Po kliknięciu OK zostanie ono pobrane i zainstalowane/zaktualizowane automatycznie (może to potrwać chwilę).\n\n\
         Microsoft Edge WebView2 Runtime, which Zenith needs, is missing or too old.\n\
         After you click OK it will be downloaded and installed/updated automatically (this may take a moment).",
        MB_ICONINFORMATION,
    );
    let res = install();
    if res.is_ok() && installed() {
        return true;
    }
    let why = res
        .err()
        .unwrap_or_else(|| "runtime still not detected".into());
    msg(
        &format!(
            "Nie udało się zainstalować WebView2 ({why}).\n\
             Sprawdź połączenie z internetem albo pobierz i zainstaluj ręcznie:\n{MANUAL_URL}\n\n\
             WebView2 could not be installed ({why}).\n\
             Check your internet connection or download and install it manually:\n{MANUAL_URL}"
        ),
        MB_ICONERROR,
    );
    false
}
