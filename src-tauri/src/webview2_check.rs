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

// aplikacja bez konsoli: bez okienka start, który się nie udał, wygląda jak brak reakcji na kliknięcie
pub fn fatal(err: &str) -> ! {
    msg(
        &format!("Zenith nie mógł się uruchomić.\n\n{err}\n\nJeśli to się powtarza, zainstaluj ponownie WebView2: {MANUAL_URL}"),
        MB_ICONERROR,
    );
    std::process::exit(1)
}

// shortcut: sprawdza podpis Authenticode, nie wydawcę; wystarcza, bo plik idzie tylko z go.microsoft.com po https
fn signed(path: &std::path::Path) -> bool {
    use windows_sys::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
        WTD_UI_NONE,
    };
    let p = wide(&path.to_string_lossy());
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: p.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.Anonymous.pFile = &mut file;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let mut call = |d: &mut WINTRUST_DATA| unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            (d as *mut WINTRUST_DATA).cast(),
        )
    };
    let r = call(&mut data);
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    call(&mut data);
    r == 0
}

fn install() -> Result<(), String> {
    // nazwa z PID-em: inny program nie podłoży wcześniej pliku o znanej nazwie w %TEMP%
    let path = std::env::temp_dir().join(format!("zenith-wv2-{}.exe", std::process::id()));
    let bytes = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .https_only(true)
        .build()
        .and_then(|c| c.get(BOOTSTRAPPER_URL).send())
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .map_err(|e| format!("download: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
    if !signed(&path) {
        let _ = std::fs::remove_file(&path);
        return Err("installer signature check failed".into());
    }
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
        "Zenith potrzebuje Microsoft Edge WebView2, a na tym komputerze go nie ma albo jest za stary.\n\
         Po kliknięciu OK Zenith sam go pobierze i zainstaluje. To może chwilę potrwać.\n\n\
         Zenith needs the Microsoft Edge WebView2 Runtime, and it's missing or too old on this PC.\n\
         Click OK and Zenith will download and install it. This can take a moment.",
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
