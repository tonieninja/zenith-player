/**
 * keeps a copy of the small localStorage keys in a file next to the app data.
 * WebView2 sometimes lost recent localStorage writes when Zenith quit (it batches and
 * rate-limits commits), which brought the disclaimer back on every start. big values
 * (saved queue, liked tracks) stay in localStorage only.
 */
import { invoke } from '@tauri-apps/api/core';

const MAX_VALUE = 4096;
// never copy anything that looks like a credential into the plain file
const SECRET = /token|secret|session|password|apikey|api_key|cookie/i;
let timer: number | undefined;

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('zenith') || SECRET.test(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null && v.length <= MAX_VALUE) out[k] = v;
  }
  return out;
}

function scheduleSave() {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    void invoke('prefs_save', { prefs: snapshot() }).catch(() => {});
  }, 1000);
}

/** restore keys the webview lost, then mirror every later change. call before render */
export async function initPrefsMirror(): Promise<void> {
  try {
    const saved = await invoke<Record<string, string>>('prefs_load');
    for (const [k, v] of Object.entries(saved || {})) {
      if (SECRET.test(k)) continue;
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }
  } catch {
    return; // no backend (tests, browser preview)
  }
  const proto = Storage.prototype;
  const set = proto.setItem;
  const remove = proto.removeItem;
  proto.setItem = function (this: Storage, k: string, v: string) {
    set.call(this, k, v);
    if (this === localStorage && k.startsWith('zenith')) scheduleSave();
  };
  proto.removeItem = function (this: Storage, k: string) {
    remove.call(this, k);
    if (this === localStorage && k.startsWith('zenith')) scheduleSave();
  };
  scheduleSave();
}
