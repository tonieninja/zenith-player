import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { X } from 'lucide-react';
import { errorText, translations, type Language } from '../i18n';
import { pushToast } from './Toast';

const KEY = 'zenith_local_folders';

function readFolders(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

let retryTimer = 0;

// Rust skanuje jeden zestaw naraz; lista zmieniona w trakcie skanu czeka na jego koniec, a nie na restart
function scanFolders(): Promise<void> {
  window.clearTimeout(retryTimer);
  return invoke('local_scan', { folders: readFolders() }).then(
    () => undefined,
    (e) => {
      if (!/already running/i.test(String(e))) throw e;
      retryTimer = window.setTimeout(() => void scanFolders().catch(() => undefined), 1000);
    }
  );
}

/** Przy starcie dopisuje nowe pliki; niezmienione Rust pomija po dacie modyfikacji. */
export function rescanLocalFolders() {
  if (readFolders().length) void scanFolders().catch(() => undefined);
}

export function LocalFilesSetting({ lang }: { lang: Language }) {
  const t = translations[lang];
  const [folders, setFolders] = useState(readFolders);
  const [path, setPath] = useState('');
  const [count, setCount] = useState(0);
  const [scan, setScan] = useState<{ seen: number; total: number } | null>(null);

  useEffect(() => {
    void invoke<{ count: number }>('local_status').then(
      (s) => setCount(s?.count ?? 0),
      () => undefined
    );
    const off = listen<{ done: boolean; seen: number; total: number; count?: number }>(
      'local-scan',
      (e) => {
        if (e.payload.done) {
          setScan(null);
          setCount(e.payload.count ?? 0);
        } else setScan(e.payload);
      }
    );
    return () => void off.then((f) => f());
  }, []);

  const save = (next: string[]) => {
    setFolders(next);
    localStorage.setItem(KEY, JSON.stringify(next));
    // zdarzenie końca pustego skanu potrafi przyjść przed odpowiedzią komendy, więc stan ustawiamy wcześniej
    setScan({ seen: 0, total: 0 });
    scanFolders().catch((e) => {
      setScan(null);
      pushToast(errorText(t, e), 'error');
    });
  };

  return (
    <div className="settings-row-item local-files-row">
      <div className="settings-account-info">
        <span className="setting-label">{t.localTitle}</span>
        <span className="plugin-desc">{t.localDesc}</span>
        <span className="plugin-desc">
          {scan
            ? t.localScanning
                .replace('{seen}', String(scan.seen))
                .replace('{total}', String(scan.total))
            : t.localCount.replace('{n}', String(count))}
        </span>
      </div>
      {folders.map((f) => (
        <div key={f} className="local-files-folder">
          <span title={f}>{f}</span>
          <button
            type="button"
            className="local-lib-icon"
            aria-label={t.localRemove}
            title={t.localRemove}
            onClick={() => save(folders.filter((x) => x !== f))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <form
        className="stats-import"
        onSubmit={(e) => {
          e.preventDefault();
          const p = path.trim();
          if (!p || folders.includes(p)) return;
          setPath('');
          save([...folders, p]);
        }}
      >
        {/* shortcut: ścieżka wpisywana ręcznie, okno wyboru folderu wymagałoby wtyczki dialog */}
        <input
          className="lib-input"
          aria-label={t.localPathPlaceholder}
          placeholder={t.localPathPlaceholder}
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="submit" className="np-cancel-btn" disabled={!path.trim()}>
          {t.localAdd}
        </button>
      </form>
    </div>
  );
}
