//! session file at rest: DPAPI on Windows, 0600 elsewhere
use std::fs;
use std::path::Path;

const MAGIC: &[u8] = b"ZDP1";

#[cfg(windows)]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(plain.len()).map_err(|_| "session too large")?,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("CryptProtectData failed".into());
    }
    let blob =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(output.pbData as _);
    }
    Ok(blob)
}

#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(blob.len()).map_err(|_| "session too large")?,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("CryptUnprotectData failed".into());
    }
    let plain =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(output.pbData as _);
    }
    Ok(plain)
}

#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    Ok(blob.to_vec())
}

fn lock_down(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    let _ = path;
}

pub fn write_session(path: &Path, json: &str) -> Result<(), String> {
    let blob = protect(json.as_bytes())?;
    let mut out = Vec::with_capacity(MAGIC.len() + blob.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&blob);
    fs::write(path, out).map_err(|e| e.to_string())?;
    lock_down(path);
    Ok(())
}

/// returns (json, was_legacy_plaintext)
pub fn read_session(path: &Path) -> Result<(String, bool), String> {
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    if raw.starts_with(MAGIC) {
        let plain = unprotect(&raw[MAGIC.len()..])?;
        let json = String::from_utf8(plain).map_err(|e| e.to_string())?;
        return Ok((json, false));
    }
    let json = String::from_utf8(raw).map_err(|e| e.to_string())?;
    Ok((json, true))
}
