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

export async function checkGithubUpdate(currentVersion: string): Promise<UpdateCheck> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ZenithPlayer',
    },
  });
  if (res.status === 404) return { status: 'missing' };
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const data = JSON.parse(await res.text()) as { tag_name?: string; html_url?: string };
  const tag = String(data.tag_name || '').trim();
  if (!tag) return { status: 'missing' };
  const url = data.html_url || `${GITHUB_RELEASES}/latest`;
  if (isNewerVersion(tag, currentVersion)) return { status: 'newer', tag, url };
  return { status: 'current', tag };
}
