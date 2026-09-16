# Security

Signed-in sessions store YouTube cookies in the app data directory. On Windows
the file is DPAPI-protected for the current user (`CryptProtectData`). On Linux
and macOS the file is mode `0600`. Treat it like a browser profile anyway.

## Reporting

Use a private GitHub security advisory if available, otherwise email the
maintainer on the GitHub profile. Do not open a public issue for session
theft, cookie leaks, or remote code execution.

Trademark, copyright, and terms-of-service matters go in an issue titled
`legal:` or to the same maintainer contact. See [DISCLAIMER.md](./DISCLAIMER.md).

## In scope

| Area          | Examples                                |
| ------------- | --------------------------------------- |
| Session data  | Cookie or token leakage from app data   |
| Tauri surface | Command injection, capability bypass    |
| Stream proxy  | Serving media to unexpected origins     |
| WebView       | XSS that can read the signed-in session |

## Out of scope

| Area             | Examples                                 |
| ---------------- | ---------------------------------------- |
| Platform terms   | YouTube / Google Terms of Service        |
| Windows          | SmartScreen on unsigned or unsigned-reputation builds |
| Dependencies     | Lyric APIs or yt-dlp after it is on disk |
| Feature requests | Download-to-disk or paywall bypass       |
