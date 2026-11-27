import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { translations, type Language } from '../i18n';
import { pushToast } from './Toast';

function prefsSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = k?.startsWith('zenith') ? localStorage.getItem(k) : null;
    if (k && v != null) out[k] = v;
  }
  return out;
}

export function BackupSetting({ lang }: { lang: Language }) {
  const t = translations[lang];
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
    } catch (e) {
      pushToast(`${t.backupFailed}: ${String(e)}`, 'error', 6000);
    } finally {
      setBusy(false);
    }
  };
  const exportAll = () =>
    run(async () => {
      const path = await invoke<string>('backup_export', { prefs: prefsSnapshot() });
      pushToast(t.backupSaved.replace('{path}', path), 'success', 6000);
    });
  const importFile = (f: File) =>
    run(async () => {
      const prefs = await invoke<Record<string, string>>('backup_import', { body: await f.text() });
      for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v);
      // wtyczki i widoki czytają ustawienia przy starcie, więc najprościej zacząć od nowa
      window.setTimeout(() => location.reload(), 1200);
      pushToast(t.backupRestored, 'success', 4000);
    });
  return (
    <div className="settings-row-item settings-toggle-row">
      <div className="settings-account-info">
        <span className="setting-label">{t.backupTitle}</span>
        <span className="plugin-desc">{t.backupDesc}</span>
      </div>
      <div className="backup-actions">
        <button type="button" className="np-cancel-btn" disabled={busy} onClick={exportAll}>
          {t.backupExport}
        </button>
        <button
          type="button"
          className="np-cancel-btn"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          {t.backupImport}
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="backup-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importFile(f);
          }}
        />
      </div>
    </div>
  );
}
