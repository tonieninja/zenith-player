import capabilities from '../../../src-tauri/capabilities/default.json';

type Init = { method?: string; headers?: Record<string, string>; signal?: AbortSignal };
type Send = (url: string, init: Init) => unknown;

const WEBVIEW_ORIGIN = 'tauri://localhost';

function patternToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

const allowed: RegExp[] = [];
for (const permission of capabilities.permissions) {
  if (typeof permission === 'string' || permission.identifier !== 'http:default') continue;
  for (const entry of permission.allow) allowed.push(patternToRegExp(entry.url));
}

export function scopeAllows(raw: string): boolean {
  const u = new URL(raw);
  const target = `${u.protocol}//${u.host}${u.pathname}`;
  return allowed.some((re) => re.test(target));
}

export function tauriFetch(send: Send) {
  return async (input: string | URL, init: Init = {}) => {
    const url = String(input);
    if (!scopeAllows(url)) throw new Error(`url not allowed on the configured scope: ${url}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    if (!('user-agent' in headers)) headers['user-agent'] = 'tauri-plugin-http/2.5.9';
    if (!('origin' in headers)) headers.origin = WEBVIEW_ORIGIN;
    if (headers.origin === '') delete headers.origin;
    return send(url, { ...init, headers });
  };
}
