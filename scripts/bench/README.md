# Soak test

Samples a running Zenith on Windows (`zenith-player.exe` and every WebView2 process under it) into a CSV,
then checks the run for leaks.

Start Zenith first and leave it doing what you want to test, for example a long queue playing or the window
hidden in the tray. Then:

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bench/soak.ps1 -Minutes 480 -Out soak.csv
```

| Parameter   | Default                  | Meaning                             |
| ----------- | ------------------------ | ----------------------------------- |
| `-Interval` | 30                       | seconds between samples             |
| `-Minutes`  | 60                       | length of the run                   |
| `-Out`      | `zenith-soak-<date>.csv` | CSV path                            |
| `-SkipMin`  | 10                       | warm-up minutes the summary ignores |
| `-Name`     | `zenith-player`          | root process name without `.exe`    |

CSV columns, all summed over the process tree:

- `processes`: how many processes the tree had. 0 means Zenith was gone at that moment.
- `ws_private_mb`: private working set, the number Task Manager shows as Memory.
- `cpu_pct`: share of the whole machine since the previous sample, as in Task Manager. Empty on the first row.
- `handles`: handle count.

Rows are written as they're taken, so a run stopped with Ctrl+C keeps its data.

## Summary

Runs by itself at the end when `node` is on PATH. By hand:

```
node scripts/bench/summary.mjs soak.csv --skip-min=10 ws_private_mb=20 handles=200
```

For each column after the warm-up it prints min, median, max and the least-squares slope per hour. A column
growing faster than its limit gets `LEAK?` and the script exits with 1, as it does when Zenith was gone in
any sample. Default limits are 10 MB/h for `ws_private_mb` and 100/h for `handles`; `column=limit` changes
one or adds another (`processes=1`).
The slope of a run under an hour is rough, so give a real check a few hours.

Tests: `vitest run scripts/bench`.
