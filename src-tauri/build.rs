fn main() {
    tauri_build::build();

    // tauri-winres links the Common Controls v6 manifest only into package
    // binaries (cargo:rustc-link-arg-bins). The cargo test --lib harness still
    // imports TaskDialogIndirect from comctl32 and exits with
    // STATUS_ENTRYPOINT_NOT_FOUND on Windows unless it also requests that
    // assembly. rustc-link-arg-tests is rejected here (no [[test]] targets),
    // and linking resource.lib again via rustc-link-arg duplicates VERSION
    // in the app binary. /manifestdependency adds the same SxS dependency
    // without a second resource object.
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() == Some("msvc")
    {
        println!(
            "cargo:rustc-link-arg=/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}
