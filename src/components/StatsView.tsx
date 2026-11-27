import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { X } from 'lucide-react';
import type { Track } from '../api/youtube';
import { translations, type Language } from '../i18n';
import { ModalOverlay } from './ui/ModalOverlay';
import { pushToast } from './Toast';

interface ArtistStat {
  name: string;
  plays: number;
  minutes: number;
  before: number;
}
interface Overview {
  plays: number;
  minutes: number;
  artists: number;
  skipped: number;
  topArtists: ArtistStat[];
  topTracks: { videoId: string; title: string; artist: string; plays: number }[];
  rising: ArtistStat[];
  hours: number[];
  weekdays: number[];
  daily: [string, number][];
  firstAt?: number | null;
}
interface ImportState {
  page?: number;
  pages?: number;
  added?: number;
  done?: boolean;
  error?: string | null;
}

const RANGES = [7, 30, 90, 365, 0] as const;

function Bars({
  values,
  labels,
  unit,
  height = 110,
}: {
  values: number[];
  labels: string[];
  unit: (v: number) => string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...values);
  const w = 100 / Math.max(1, values.length);
  return (
    <div className="stats-bars">
      <div className="stats-bars-caption">
        {hover !== null ? `${labels[hover]}: ${unit(values[hover])}` : ' '}
      </div>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        role="img"
        aria-label={values.map((v, i) => `${labels[i]} ${unit(v)}`).join(', ')}
        onMouseLeave={() => setHover(null)}
      >
        {values.map((v, i) => {
          const h = v > 0 ? Math.max(2, (v / max) * (height - 4)) : 0;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              {/* pole trafienia na całą wysokość, żeby niski słupek też dało się wskazać */}
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              <rect
                className={`stats-bar${hover === i ? ' hover' : ''}`}
                x={i * w + Math.min(0.4, w * 0.15)}
                y={height - h}
                width={Math.max(0.3, w - Math.min(0.8, w * 0.3))}
                height={h}
                rx={Math.min(1.2, w * 0.3)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function StatsView({
  lang,
  onClose,
  onPlay,
}: {
  lang: Language;
  onClose: () => void;
  onPlay: (track: Track) => void;
}) {
  const t = translations[lang];
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<Overview | null>(null);
  const [artist, setArtist] = useState<string | null>(null);
  const [artistTracks, setArtistTracks] = useState<
    { videoId: string; title: string; plays: number }[]
  >([]);
  const [lfmUser, setLfmUser] = useState('');
  const [imp, setImp] = useState<ImportState | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void invoke<Overview>('stats_overview', { days }).then(setData, () => setData(null));
  }, [days, reload]);
  useEffect(() => {
    if (!artist) return;
    void invoke<typeof artistTracks>('stats_artist', { name: artist, days }).then(
      setArtistTracks,
      () => setArtistTracks([])
    );
  }, [artist, days]);
  useEffect(() => {
    void invoke<{ user?: string | null }>('lastfm_status').then(
      (s) => setLfmUser((u) => u || s?.user || ''),
      () => undefined
    );
    const off = listen<ImportState>('lastfm-import', (e) => {
      setImp(e.payload);
      if (e.payload.done) setReload((n) => n + 1);
    });
    return () => void off.then((f) => f());
  }, []);

  const hours = (m: number) =>
    m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)} h` : `${Math.round(m)} min`;
  const rangeLabel = (d: number) => (d === 0 ? t.statsAll : t.statsDays.replace('{n}', String(d)));
  const play = (videoId: string, title: string, by: string) =>
    /^[\w-]{11}$/.test(videoId) &&
    onPlay({ id: videoId, type: 'track', title, artist: by, cover: '' });
  const maxBubble = Math.max(1, ...(data?.topArtists.slice(0, 24).map((a) => a.minutes) ?? []));
  const weekdays = t.statsWeekdays.split(',');

  return (
    <ModalOverlay onClick={onClose} testId="stats-view">
      <div className="glass-modal-container stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t.statsTitle}</h2>
          <button
            type="button"
            className="modal-close-icon"
            aria-label={t.winClose}
            onClick={onClose}
          >
            <X size={26} />
          </button>
        </div>
        <div className="stats-body">
          <div className="lib-chips stats-ranges" role="group" aria-label={t.statsRange}>
            {RANGES.map((d) => (
              <button
                key={d}
                type="button"
                className={`lib-chip${d === days ? ' active' : ''}`}
                aria-pressed={d === days}
                onClick={() => setDays(d)}
              >
                {rangeLabel(d)}
              </button>
            ))}
          </div>
          {!data || data.plays === 0 ? (
            <p className="plugin-desc">{t.statsEmpty}</p>
          ) : (
            <>
              <div className="stats-tiles">
                <div className="stats-tile">
                  <span className="stats-tile-value">{hours(data.minutes)}</span>
                  <span className="stats-tile-label">{t.statsListened}</span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile-value">{data.plays}</span>
                  <span className="stats-tile-label">{t.statsPlays}</span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile-value">{data.artists}</span>
                  <span className="stats-tile-label">{t.statsArtists}</span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile-value">
                    {Math.round((100 * data.skipped) / Math.max(1, data.plays + data.skipped))}%
                  </span>
                  <span className="stats-tile-label">{t.statsSkipRate}</span>
                </div>
              </div>

              <h3 className="settings-group-title">{t.statsOverTime}</h3>
              <Bars
                values={data.daily.map((d) => d[1])}
                labels={data.daily.map((d) => d[0])}
                unit={hours}
              />

              <div className="stats-two">
                <div>
                  <h3 className="settings-group-title">{t.statsByHour}</h3>
                  <Bars
                    values={data.hours}
                    labels={data.hours.map((_, h) => `${h}:00`)}
                    unit={hours}
                    height={80}
                  />
                </div>
                <div>
                  <h3 className="settings-group-title">{t.statsByWeekday}</h3>
                  <Bars values={data.weekdays} labels={weekdays} unit={hours} height={80} />
                </div>
              </div>

              <h3 className="settings-group-title">{t.statsTasteMap}</h3>
              <p className="plugin-desc">{t.statsTasteMapDesc}</p>
              <div className="stats-bubbles">
                {data.topArtists.slice(0, 24).map((a) => {
                  const size = 44 + 76 * Math.sqrt(a.minutes / maxBubble);
                  return (
                    <button
                      key={a.name}
                      type="button"
                      className={`stats-bubble${artist === a.name ? ' active' : ''}`}
                      style={{ width: size, height: size }}
                      title={`${a.name}: ${hours(a.minutes)}, ${a.plays}×`}
                      onClick={() => setArtist(artist === a.name ? null : a.name)}
                    >
                      <span>{a.name}</span>
                    </button>
                  );
                })}
              </div>
              {artist && (
                <ol className="stats-list">
                  {artistTracks.map((r) => (
                    <li key={r.title}>
                      <button type="button" onClick={() => play(r.videoId, r.title, artist)}>
                        <span>{r.title}</span>
                        <span className="local-lib-count">{r.plays}×</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}

              <div className="stats-two">
                <div>
                  <h3 className="settings-group-title">{t.statsTopTracks}</h3>
                  <ol className="stats-list">
                    {data.topTracks.slice(0, 10).map((r) => (
                      <li key={`${r.artist}-${r.title}`}>
                        <button type="button" onClick={() => play(r.videoId, r.title, r.artist)}>
                          <span>
                            {r.title}
                            <span className="local-lib-artist"> · {r.artist}</span>
                          </span>
                          <span className="local-lib-count">{r.plays}×</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h3 className="settings-group-title">{t.statsRising}</h3>
                  {data.rising.length === 0 ? (
                    <p className="plugin-desc">
                      {days === 0 ? t.statsRisingAll : t.statsRisingNone}
                    </p>
                  ) : (
                    <ol className="stats-list">
                      {data.rising.map((a) => (
                        <li key={a.name}>
                          <button type="button" onClick={() => setArtist(a.name)}>
                            <span>{a.name}</span>
                            <span className="local-lib-count">
                              {a.before} → {a.plays}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            </>
          )}

          <h3 className="settings-group-title">{t.statsImportTitle}</h3>
          <p className="plugin-desc">{t.statsImportDesc}</p>
          <form
            className="stats-import"
            onSubmit={(e) => {
              e.preventDefault();
              void invoke('lastfm_import', { user: lfmUser || null }).then(
                () => setImp({ page: 0, pages: 1, added: 0 }),
                (err) => pushToast(String(err), 'error', 6000)
              );
            }}
          >
            <input
              className="lib-input"
              placeholder={t.statsImportUser}
              value={lfmUser}
              maxLength={64}
              onChange={(e) => setLfmUser(e.target.value)}
            />
            <button type="submit" className="np-cancel-btn" disabled={!!imp && !imp.done}>
              {t.statsImportBtn}
            </button>
          </form>
          {imp && (
            <p className="plugin-desc" aria-live="polite">
              {imp.done
                ? imp.error
                  ? `${t.statsImportFailed}: ${imp.error}`
                  : t.statsImportDone.replace('{n}', String(imp.added ?? 0))
                : t.statsImportProgress
                    .replace('{page}', String(imp.page ?? 0))
                    .replace('{pages}', String(imp.pages ?? 1))
                    .replace('{n}', String(imp.added ?? 0))}
            </p>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
