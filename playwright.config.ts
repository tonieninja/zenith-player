import { defineConfig, devices } from '@playwright/test';

// E2E for the phone remote page served by the real Rust server (remote.rs, ignored test
// `e2e_serve`). Locally an installed Chrome can be used: PW_CHROME=/usr/bin/google-chrome
const port = Number(process.env.ZENITH_E2E_PORT || 18890);
export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['harness/**'],
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['Pixel 7'],
    launchOptions: process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {},
  },
  webServer: {
    command: `cargo test --manifest-path src-tauri/Cargo.toml --lib e2e_serve -- --ignored --nocapture`,
    url: `http://127.0.0.1:${port}/manifest.webmanifest`,
    timeout: 600_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ZENITH_E2E_PORT: String(port),
      ZENITH_REMOTE_E2E_LOG: process.env.ZENITH_REMOTE_E2E_LOG || 'target-e2e-cmds.log',
    },
  },
});
