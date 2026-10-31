# Security

Signed-in sessions store YouTube cookies in the app data directory. On Windows
the file is DPAPI-protected for the current user (`CryptProtectData`). On Linux
the file is mode `0600`. Treat it like a browser profile anyway.

## Reporting

Report privately via [GitHub security advisories](https://github.com/tonieninja/zenith-player/security/advisories/new). Do not open a public issue for session
theft, cookie leaks, or remote code execution.

Trademark, copyright, and terms-of-service matters go in an issue titled
`legal:` or to the maintainer contact on the GitHub profile. See [DISCLAIMER.md](./DISCLAIMER.md).

## In scope

| Area          | Examples                                |
| ------------- | --------------------------------------- |
| Session data  | Cookie or token leakage from app data   |
| Tauri surface | Command injection, capability bypass    |
| Updater       | Bypassing the minisign signature check  |
| Stream proxy  | Serving media to unexpected origins     |
| WebView       | XSS that can read the signed-in session |

## Out of scope

| Area             | Examples                                 |
| ---------------- | ---------------------------------------- |
| Platform terms   | YouTube / Google Terms of Service        |
| Windows          | SmartScreen warnings on unsigned builds  |
| Dependencies     | Lyric APIs or yt-dlp after it is on disk |
| Feature requests | Export of audio or paywall bypass        |
