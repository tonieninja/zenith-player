import { invoke } from '@tauri-apps/api/core';

const LETTER_COVER = 'data:image/svg+xml;charset=utf-8,';

// okładka z liter rysowana lokalnie, żeby nazwy playlist nie szły do zewnętrznego serwisu
export function letterCover(text: string, bg = '#1a1a2e', fg = '#ffffff'): string {
  const t = ([...(text || '?').trim()].slice(0, 2).join('') || '?')
    .toUpperCase()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${bg}"/><text x="50" y="50" dy=".35em" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="40" font-weight="700" fill="${fg}">${t}</text></svg>`;
  return LETTER_COVER + encodeURIComponent(svg);
}

export function isPlaceholderCover(url: string | undefined | null): boolean {
  return !!url && (url.startsWith(LETTER_COVER) || url.includes('ui-avatars'));
}

// stare adresy ui-avatars zapisane w playlistach i historii zamieniamy na lokalne
export function localCover(url: string): string {
  if (!url.includes('ui-avatars.com')) return url;
  const p = new URLSearchParams(url.split('?')[1] || '');
  const hex = (v: string | null, d: string) => '#' + (/^[0-9a-f]{3,8}$/i.test(v || '') ? v : d);
  return letterCover(
    p.get('name') || '?',
    hex(p.get('background'), '1a1a2e'),
    hex(p.get('color'), 'fff')
  );
}

const FALLBACK_AVATAR = letterCover('?', '#111827', '#6b7280');

const YTIMG = 'https://i.ytimg.com/vi/';

export function isYouTubeVideoId(id: string | undefined | null): boolean {
  return !!id && /^[\w-]{11}$/.test(id);
}

const COVER_HOSTS =
  /^https:\/\/(i9?\.ytimg\.com|lh3\.googleusercontent\.com|yt3\.ggpht\.com|yt3\.googleusercontent\.com)\//;
let coverBase = '';

export async function initCoverCache(): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  const base = await invoke<string>('cover_cache_base').catch(() => '');
  if (/^http:\/\/127\.0\.0\.1:\d+\/cover\/[^/]+\/$/.test(base)) coverBase = base;
}

export function cachedCoverUrl(src: string, px: 120 | 240 | 544): string {
  if (!coverBase || !src || !COVER_HOSTS.test(src)) return src;
  return `${coverBase}${px}/${encodeURIComponent(src)}`;
}

type CoverTrack = {
  id: string;
  cover?: string;
  coverSmall?: string;
  coverLarge?: string;
};

export function coverAttrs(track: CoverTrack, size: 'thumb' | 'small' | 'large' = 'small') {
  const src = localCover(
    size === 'large'
      ? track.coverLarge || track.cover || track.coverSmall || ''
      : track.coverSmall || track.cover || track.coverLarge || ''
  );
  const cached = cachedCoverUrl(src, size === 'large' ? 544 : size === 'thumb' ? 120 : 240);
  return {
    src: cached,
    onError: imgErr,
    ...(cached !== src ? { 'data-orig': src } : {}),
    ...(isYouTubeVideoId(track.id) ? { 'data-video-id': track.id } : {}),
  };
}

export function imgErr(e: React.SyntheticEvent<HTMLImageElement>) {
  const el = e.currentTarget;
  if (el.dataset.coverFail === '1') return;

  const orig = el.dataset.orig;
  if (orig && (el.getAttribute('src') || '') !== orig && el.dataset.origTried !== orig) {
    el.dataset.origTried = orig;
    el.src = orig;
    return;
  }

  const src = el.getAttribute('src') || el.src || '';
  const videoId = el.dataset.videoId || '';

  if (src.includes('maxresdefault')) {
    el.src = src.replace('maxresdefault', 'hqdefault');
    return;
  }

  const size = src.match(/=w(\d+)-h\d+/i);
  if (size) {
    const w = Number(size[1]);
    if (w > 544) {
      el.src = src.replace(/=w\d+-h\d+/i, '=w544-h544');
      return;
    }
    if (w > 226) {
      el.src = src.replace(/=w\d+-h\d+/i, '=w226-h226');
      return;
    }
  }

  const sSize = src.match(/=s(\d+)/i);
  if (sSize && Number(sSize[1]) > 226) {
    el.src = src.replace(/=s\d+/i, '=s226');
    return;
  }

  if (src.includes('hqdefault')) {
    el.src = src.replace('hqdefault', 'mqdefault');
    return;
  }
  if (src.includes('mqdefault')) {
    el.src = src.replace('mqdefault', 'default');
    return;
  }

  if (videoId && !src.includes(`/vi/${videoId}/`)) {
    el.src = `${YTIMG}${videoId}/hqdefault.jpg`;
    return;
  }

  el.dataset.coverFail = '1';
  if (!isPlaceholderCover(src)) {
    el.src = FALLBACK_AVATAR;
  }
}
