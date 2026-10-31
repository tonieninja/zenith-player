import type { Update } from '@tauri-apps/plugin-updater';
import { fetch } from '@tauri-apps/plugin-http';

export const GITHUB_REPO = 'tonieninja/zenith-player';
export const GITHUB_RELEASES = `https://github.com/${GITHUB_REPO}/releases`;

function parseVer(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((p) => Number.parseInt(p, 10) || 0);
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVer(latest);
  const b = parseVer(current);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export type UpdateCheck =
  | { status: 'newer'; tag: string; url: string }
  | { status: 'current'; tag: string }
  | { status: 'missing' };

const UPDATE_TIMEOUT_MS = 10000;

export async function checkGithubUpdate(currentVersion: string): Promise<UpdateCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('GitHub request timed out')), UPDATE_TIMEOUT_MS);
  });
  const res = await Promise.race([
    fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      method: 'GET',
      connectTimeout: UPDATE_TIMEOUT_MS,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ZenithPlayer',
      },
    }),
    timeout,
  ]).finally(() => clearTimeout(timer));
  if (res.status === 404) return { status: 'missing' };
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const data = JSON.parse(await res.text()) as { tag_name?: string; html_url?: string };
  const tag = String(data.tag_name || '').trim();
  if (!tag) return { status: 'missing' };
  const url = data.html_url || `${GITHUB_RELEASES}/latest`;
  if (isNewerVersion(tag, currentVersion)) return { status: 'newer', tag, url };
  return { status: 'current', tag };
}

/* Signed in-app updates (tauri-plugin-updater, latest.json on GitHub Releases). */
let pendingUpdate: Update | null = null;

/** Asks the signed updater endpoint; resolves to the version string or null. Never throws. */
export async function checkSignedUpdate(): Promise<{ version: string } | null> {
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const upd = await check({ timeout: UPDATE_TIMEOUT_MS });
    pendingUpdate = upd;
    return upd ? { version: upd.version } : null;
  } catch (e) {
    console.warn('[update] signed check failed', e);
    return null;
  }
}

export function hasPendingUpdate(): boolean {
  return pendingUpdate !== null;
}

/** Downloads, verifies the minisign signature (done by the plugin) and installs, then restarts. */
export async function installPendingUpdate(
  onProgress?: (pct: number | null) => void
): Promise<void> {
  const upd = pendingUpdate;
  if (!upd) throw new Error('no update');
  let total = 0;
  let got = 0;
  await upd.downloadAndInstall((ev) => {
    if (ev.event === 'Started') total = ev.data.contentLength || 0;
    else if (ev.event === 'Progress') {
      got += ev.data.chunkLength;
      onProgress?.(total ? Math.min(100, Math.round((got * 100) / total)) : null);
    }
  });
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
