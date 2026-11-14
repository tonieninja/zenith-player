fn main() {
    tauri_build::build();

    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() == Some("msvc")
    {
        println!(
            "cargo:rustc-link-arg=/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}
