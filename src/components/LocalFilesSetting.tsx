import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { X } from 'lucide-react';
import { translations, type Language } from '../i18n';
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

/** Przy starcie dopisuje nowe pliki; niezmienione Rust pomija po dacie modyfikacji. */
export function rescanLocalFolders() {
  const folders = readFolders();
  if (folders.length) void invoke('local_scan', { folders }).catch(() => undefined);
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
    void invoke('local_scan', { folders: next }).then(
      () => setScan({ seen: 0, total: 0 }),
      (e) => pushToast(String(e), 'error')
    );
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
