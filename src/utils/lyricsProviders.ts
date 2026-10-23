export const LYRICS_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const GENIUS_BROWSER_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': LYRICS_BROWSER_UA,
  Referer: 'https://genius.com/',
  Origin: 'https://genius.com',
};

export function geniusHttpError(status: number, phase: 'search' | 'page' = 'search'): string {
  if (status === 403) {
    return phase === 'page'
      ? 'Genius blocked this request (HTTP 403). The site denied automated access; try another lyrics provider.'
      : 'Genius search was blocked (HTTP 403). The site denied automated access; try another lyrics provider.';
  }
  return phase === 'page' ? `Genius page HTTP ${status}` : `Genius search HTTP ${status}`;
}

export const MXM_SECRET_MISSING =
  'Musixmatch signature is unavailable (the site layout may have changed)';

export function absolutizeMusixmatchUrl(src: string): string {
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `https://www.musixmatch.com${src}`;
  return src;
}

export function collectMusixmatchBundleUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const src = absolutizeMusixmatchUrl(raw);
    if (!src.includes('.js')) return;
    if (seen.has(src)) return;
    seen.add(src);
    urls.push(src);
  };
  for (const m of html.matchAll(/src="([^"]+\.js[^"]*)"/g)) add(m[1]);
  for (const m of html.matchAll(/src='([^']+\.js[^']*)'/g)) add(m[1]);
  for (const m of html.matchAll(/href="([^"]+\.js[^"]*)"/g)) add(m[1]);
  const rank = (u: string) => {
    const name = u.toLowerCase();
    if (name.includes('pages/_app-')) return 0;
    if (name.includes('_app-')) return 1;
    if (name.includes('manifest') || name.includes('turbopack') || name.includes('middleware')) {
      return 100;
    }
    if (name.includes('mxmcdn.net') && name.includes('/chunks/')) return 2;
    if (name.includes('/_next/static/chunks/')) return 3;
    return 10;
  };
  urls.sort((a, b) => rank(a) - rank(b));
  return urls;
}

export function extractMusixmatchSecretFromJs(js: string): string | null {
  const patterns = [/from\(\s*"([^"]+)"\s*\.split/g, /from\(\s*'([^']+)'\s*\.split/g];
  for (const re of patterns) {
    for (const match of js.matchAll(re)) {
      if (!match[1] || match[1].length < 8) continue;
      try {
        const secret = atob(match[1].split('').reverse().join(''));
        if (secret && secret.length >= 8 && secret.length <= 128 && /^[\x20-\x7E]+$/.test(secret)) {
          return secret;
        }
      } catch {}
    }
  }
  return null;
}
