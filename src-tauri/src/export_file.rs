use tauri::{AppHandle, Manager};

pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || " -_.()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "playlist".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}

#[tauri::command]
pub fn save_playlist_export(
    app: AppHandle,
    name: String,
    ext: String,
    contents: String,
) -> Result<String, String> {
    let ext = match ext.as_str() {
        "csv" | "json" => ext,
        _ => return Err("bad extension".into()),
    };
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = safe_name(&name);
    let mut path = dir.join(format!("{base}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} ({n}).{ext}"));
        n += 1;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn names_are_safe() {
        assert_eq!(super::safe_name("Gym / Run: 2026?"), "Gym _ Run_ 2026_");
        assert_eq!(super::safe_name("..."), "playlist");
        assert_eq!(super::safe_name("Muzyka łódź"), "Muzyka łódź");
    }
}
