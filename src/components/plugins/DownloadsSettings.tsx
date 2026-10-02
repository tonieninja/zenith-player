import { useEffect, useState } from 'react';
import type { Track } from '../../api/youtube';
import type { translations } from '../../i18n';
import {
  clearDownloads,
  deleteDownload,
  downloadTrack,
  DownloadEntry,
  entryToTrack,
  formatBytes,
  listDownloads,
  onDownloadProgress,
} from '../../plugins/offlineDownloads';

type T = (typeof translations)['en'];

export function DownloadsSettings({
  t,
  currentTrack,
  onPlayTrack,
}: {
  t: T;
  currentTrack?: Track | null;
  onPlayTrack?: (track: Track, list: Track[]) => void;
}) {
  const [items, setItems] = useState<DownloadEntry[]>([]);
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [err, setErr] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void listDownloads().then(setItems);
    return onDownloadProgress((p) => {
      setBusy((b) => ({ ...b, [p.id]: p.total > 0 ? p.done / p.total : 0 }));
    });
  }, []);

  const saved = new Set(items.map((i) => i.id));
  const cur = currentTrack && currentTrack.type === 'track' ? currentTrack : null;
  const curBusy = cur ? busy[cur.id] : undefined;
  const total = items.reduce((a, i) => a + i.size, 0);

  const start = async () => {
    if (!cur) return;
    setErr('');
    setBusy((b) => ({ ...b, [cur.id]: 0 }));
    try {
      await downloadTrack(cur);
      setItems(await listDownloads());
    } catch (e) {
      setErr(t.dlFailed.replace('{err}', String(e)));
    } finally {
      setBusy((b) => {
        const n = { ...b };
        delete n[cur.id];
        return n;
      });
    }
  };

  let label = t.dlCurrent;
  if (!cur) label = t.dlNothing;
  else if (saved.has(cur.id)) label = t.dlCurrentDone;
  else if (curBusy !== undefined)
    label = t.dlBusy.replace('{pct}', `${Math.round(curBusy * 100)}%`);

  return (
    <div className="plugin-setting-col" data-testid="downloads-settings">
      <p className="plugin-desc">{t.dlHint}</p>
      <div>
        <button
          type="button"
          className="np-cancel-btn"
          data-testid="dl-current"
          disabled={!cur || saved.has(cur.id) || curBusy !== undefined}
          onClick={() => void start()}
        >
          {label}
        </button>
      </div>
      {err && <p className="plugin-desc">{err}</p>}
      {items.length === 0 ? (
        <p className="plugin-desc" data-testid="dl-empty">
          {t.dlEmpty}
        </p>
      ) : (
        <>
          <p className="plugin-desc">
            {(items.length === 1 ? t.dlTotalOne : t.dlTotal)
              .replace('{n}', String(items.length))
              .replace('{size}', formatBytes(total))}
          </p>
          <ol className="plugin-mini-list">
            {items.map((d) => (
              <li key={d.id} className="dl-row">
                <button
                  type="button"
                  className="plugin-mini-list-btn"
                  disabled={!onPlayTrack}
                  title={t.dlPlay}
                  onClick={() => onPlayTrack?.(entryToTrack(d), items.map(entryToTrack))}
                >
                  <span className="plugin-mini-list-title">{d.title}</span>
                  <span className="plugin-desc">
                    {d.artist}
                    {d.duration > 0 ? ` · ${fmtDur(d.duration)}` : ''} · {formatBytes(d.size)}
                  </span>
                </button>
                <button
                  type="button"
                  className="np-cancel-btn"
                  aria-label={`${t.dlDelete} ${d.title}`}
                  onClick={async () => {
                    await deleteDownload(d.id).catch((err) =>
                      console.debug('DownloadsSettings', err)
                    );
                    setItems(await listDownloads());
                  }}
                >
                  {t.dlDelete}
                </button>
              </li>
            ))}
          </ol>
          <div>
            <button
              type="button"
              className="np-cancel-btn"
              onClick={async () => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  return;
                }
                setConfirmClear(false);
                await clearDownloads().catch(() => 0);
                setItems(await listDownloads());
              }}
            >
              {confirmClear ? t.dlClearConfirm : t.dlClearAll}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function fmtDur(secs: number): string {
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
