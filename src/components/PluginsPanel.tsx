import { lastfmErrorText } from '../utils/lastfmErrors';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import {
  X,
  ChevronDown,
  Play,
  SlidersHorizontal,
  Quote,
  Gamepad2,
  Share2,
  LayoutDashboard,
  Search,
} from 'lucide-react';
import { pluginManager, PLUGIN_CATEGORY_LABELS, PLUGIN_CATEGORY_ORDER } from '../plugins';
import type { PluginCategory } from '../plugins/types';
import { Select } from './ui/Select';
import { ModalOverlay } from './ui/ModalOverlay';
import { DownloadsSettings } from './plugins/DownloadsSettings';
import { HotkeySettings } from './plugins/HotkeySettings';
import type { Track } from '../api/youtube';
import { getListenStats, resetListenStats } from '../plugins/statsTracker';
import { clearListeningHistory, getListeningHistory } from '../plugins/listeningHistory';
import {
  getCrossfadeSeconds,
  saveCrossfadeSeconds,
  CROSSFADE_MIN_SECS,
  CROSSFADE_MAX_SECS,
  getGaplessAlbums,
  saveGaplessAlbums,
} from '../plugins/crossfade';
import {
  getSleepTimerMinutes,
  setSleepTimerMinutes,
  SLEEP_TIMER_OPTIONS,
  rearmSleepTimer,
} from '../plugins/sleepTimer';
import { getPlaybackSpeed, setPlaybackSpeed, PLAYBACK_SPEEDS } from '../plugins/playbackSpeed';
import {
  getOverlayFontSize,
  setOverlayFontSize,
  getOverlayAlign,
  setOverlayAlign,
  getOverlayOpacity,
  setOverlayOpacity,
  getOverlayHideMeta,
  setOverlayHideMeta,
  getLyricsSyncOffset,
  setLyricsSyncOffset,
  LYRICS_SYNC_OFFSET_MIN,
  LYRICS_SYNC_OFFSET_MAX,
  LYRICS_SYNC_OFFSET_STEP,
  type OverlayFontSize,
} from '../plugins/lyricsOverlay';
import { getPreloadDepth, setPreloadDepth } from '../plugins/preloadNext';
import { getFadePauseMs, setFadePauseMs } from '../plugins/fadeOnPause';
import { getWebhookUrl, setWebhookUrl } from '../plugins/webhook';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  lastfmStatus,
  lastfmSetKeys,
  lastfmBeginAuth,
  lastfmFinishAuth,
  lastfmLogout,
  type LastfmStatus,
} from '../plugins/lastfm';
import {
  EQ_LABELS,
  EQ_MAX_DB,
  EQ_MIN_DB,
  EQ_PRESETS,
  getEqBands,
  getEqPreset,
  setEqBands,
} from '../plugins/equalizer';
import {
  allowThroughFirewall,
  getFirewallStatus,
  type FirewallStatus,
} from '../plugins/remoteControl';
import {
  forgetRemoteDevices,
  getRemoteInfo,
  getRemotePairMode,
  getRemotePin,
  getRemotePort,
  restartRemote,
  setRemotePairMode,
  setRemotePin,
  setRemotePort,
  type RemoteInfo,
} from '../plugins/remoteControl';
import {
  getDuckLevel,
  setDuckLevel,
  getDuckSensitivity,
  setDuckSensitivity,
} from '../plugins/duckOnVoice';
import {
  isKaraokeMode,
  setKaraokeMode,
  isHighContrastLyrics,
  setHighContrastLyrics,
} from '../plugins/lyricsKaraoke';
import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoomCode,
  refreshRoomPeerCount,
  roomPeerCount,
} from '../plugins/listeningRoom';
import { translations, Language } from '../i18n';
import { pluginText } from '../utils/pluginI18n';
import { pluginQueryMatches } from '../utils/pluginSearch';
import type { PlayerAudio } from '../audio/engine';

interface PluginsPanelProps {
  lang: Language;
  pluginStates: Record<string, boolean>;
  togglePlugin: (id: string) => void;
  onClose: () => void;
  discordClientId: string;
  saveDiscordClientId: (v: string) => void;
  audio: PlayerAudio;
  onPlayTrack?: (track: Track, list: Track[]) => void;
  currentTrack?: Track | null;
}

function PluginCard({
  enabled,
  name,
  description,
  onToggle,
  expanded,
  onExpand,
  settings,
  t,
}: {
  enabled: boolean;
  name: string;
  description: string;
  onToggle: () => void;
  expanded: boolean;
  onExpand: () => void;
  settings?: React.ReactNode;
  t: (typeof translations)['en'];
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    cardRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [expanded]);
  return (
    <div
      ref={cardRef}
      className={`plugin-card ${enabled ? 'enabled' : ''} ${expanded ? 'expanded' : ''}`}
    >
      <div className="plugin-card-header">
        <button
          className="plugin-card-expand"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-label={name}
        >
          <ChevronDown size={18} className={`plugin-card-chevron ${expanded ? 'open' : ''}`} />
        </button>
        <div className="plugin-info" onClick={onExpand}>
          <span className="setting-label">{name}</span>
          <span className="plugin-desc">{description}</span>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          className={`plugin-toggle ${enabled ? 'on' : ''}`}
          data-testid={`plugin-toggle-${name}`}
          onClick={onToggle}
          aria-label={name}
        >
          <span className="plugin-toggle-knob" />
          <span className="plugin-toggle-tip" role="tooltip">
            {enabled ? t.pluginEnabled : t.pluginDisabled}
          </span>
        </button>
      </div>
      {expanded && settings && <div className="plugin-card-settings">{settings}</div>}
    </div>
  );
}

export function PluginsPanel({
  lang,
  pluginStates,
  togglePlugin,
  onClose,
  discordClientId,
  saveDiscordClientId,
  audio,
  onPlayTrack,
  currentTrack,
}: PluginsPanelProps) {
  const t = translations[lang];
  const [crossfadeSecs, setCrossfadeSecs] = useState(getCrossfadeSeconds);
  const [gapless, setGapless] = useState(getGaplessAlbums);
  const [sleepMins, setSleepMins] = useState(getSleepTimerMinutes);
  const [speedRate, setSpeedRate] = useState(() =>
    getPlaybackSpeed(pluginStates['playback-speed'])
  );
  const [overlayFont, setOverlayFont] = useState<OverlayFontSize>(getOverlayFontSize);
  const [overlayAlign, setOverlayAlignState] = useState(getOverlayAlign);
  const [overlayOpacity, setOverlayOpacityState] = useState(getOverlayOpacity);
  const [overlayHideMeta, setOverlayHideMetaState] = useState(getOverlayHideMeta);
  const [lyricsSyncOffset, setLyricsSyncOffsetState] = useState(getLyricsSyncOffset);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [preloadDepth, setPreloadDepthState] = useState(getPreloadDepth);
  const [fadeMs, setFadeMs] = useState(getFadePauseMs);
  const [webhookUrl, setWebhookUrlState] = useState(getWebhookUrl);
  const [duckLvl, setDuckLvl] = useState(getDuckLevel);
  const [duckSens, setDuckSens] = useState(getDuckSensitivity);
  const [karaoke, setKaraoke] = useState(isKaraokeMode);
  const [hiContrast, setHiContrast] = useState(isHighContrastLyrics);
  const [roomCode, setRoomCode] = useState(getRoomCode);
  const [joinInput, setJoinInput] = useState('');
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomError, setRoomError] = useState('');
  const [peers, setPeers] = useState(0);
  const [eqBands, setEqBandsState] = useState(getEqBands);
  const [eqPreset, setEqPresetState] = useState(getEqPreset);
  const [remoteInfo, setRemoteInfo] = useState<RemoteInfo | null>(null);
  const [fw, setFw] = useState<FirewallStatus | null>(null);
  const [fwBusy, setFwBusy] = useState(false);
  const [lfm, setLfm] = useState<LastfmStatus | null>(null);
  const [lfmKey, setLfmKey] = useState('');
  const [lfmSecret, setLfmSecret] = useState('');
  const [lfmErr, setLfmErr] = useState('');
  useEffect(() => {
    lastfmStatus()
      .then(setLfm)
      .catch((err) => console.debug('PluginsPanel', err));
  }, []);
  const lfmRun = (p: Promise<LastfmStatus>) =>
    p
      .then((st) => {
        setLfm(st);
        setLfmErr('');
      })
      .catch((e) => setLfmErr(lastfmErrorText(String(e), t)));
  const [remotePort, setRemotePortState] = useState(() => String(getRemotePort()));
  const [remotePin, setRemotePinState] = useState(getRemotePin);
  const [remoteErr, setRemoteErr] = useState('');
  const [remotePair, setRemotePairState] = useState(getRemotePairMode);
  const [listenStats, setListenStats] = useState(getListenStats);
  const [history, setHistory] = useState(getListeningHistory);

  useEffect(() => {
    if (expandedId === 'stats-tracker') setListenStats(getListenStats());
    if (expandedId === 'stats-tracker' || expandedId === 'listening-history')
      setHistory(getListeningHistory());
  }, [expandedId]);

  useEffect(() => {
    if (!roomCode) return;
    const tick = () => {
      void refreshRoomPeerCount().then((n) => setPeers(n));
    };
    tick();
    const iv = window.setInterval(tick, 8000);
    return () => window.clearInterval(iv);
  }, [roomCode]);

  const remoteOn = Boolean(pluginStates['remote-control']);
  useEffect(() => {
    if (expandedId !== 'remote-control' || !remoteOn) {
      setRemoteInfo(null);
      return;
    }
    const tick = () => void getRemoteInfo().then((i) => setRemoteInfo(i));
    void getFirewallStatus().then(setFw);
    const first = window.setTimeout(tick, 300);
    const iv = window.setInterval(tick, 3000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(iv);
    };
  }, [expandedId, remoteOn]);

  const applyRemoteConfig = () => {
    const n = Number(remotePort);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setRemotePortState(String(getRemotePort()));
      return;
    }
    const changed = n !== getRemotePort() || remotePin.trim() !== getRemotePin();
    setRemotePort(n);
    setRemotePin(remotePin);
    if (!changed || !remoteOn) return;
    setRemoteErr('');
    restartRemote()
      .then((i) => i && setRemoteInfo(i))
      .catch((e) => setRemoteErr(`${t.remoteError}: ${String(e)}`));
  };

  const renderSettings = (id: string) => {
    switch (id) {
      case 'crossfade':
        return (
          <>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.crossfadeDuration}</span>
                <span className="plugin-desc">{t.crossfadeDurationDesc}</span>
              </div>
              <div className="crossfade-secs-control">
                <input
                  type="range"
                  min={CROSSFADE_MIN_SECS}
                  max={CROSSFADE_MAX_SECS}
                  step={1}
                  value={crossfadeSecs}
                  onChange={(e) => {
                    const s = Number(e.target.value);
                    setCrossfadeSecs(s);
                    saveCrossfadeSeconds(s);
                  }}
                />
                <span className="crossfade-secs-value">{crossfadeSecs}s</span>
              </div>
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.gaplessAlbums}</span>
                <span className="plugin-desc">{t.gaplessAlbumsDesc}</span>
              </div>
              <button
                role="switch"
                aria-checked={gapless}
                aria-label={t.gaplessAlbums}
                type="button"
                data-testid="gapless-toggle"
                className={`plugin-toggle ${gapless ? 'on' : ''}`}
                onClick={() => {
                  const next = !gapless;
                  setGapless(next);
                  saveGaplessAlbums(next);
                }}
              >
                <span className="plugin-toggle-knob" />
              </button>
            </div>
          </>
        );
      case 'offline-downloads':
        return <DownloadsSettings t={t} currentTrack={currentTrack} onPlayTrack={onPlayTrack} />;
      case 'global-hotkeys':
        return <HotkeySettings t={t} />;
      case 'sleep-timer':
        return (
          <div className="plugin-setting-row">
            <div className="plugin-setting-label">
              <span>{t.sleepTimerDuration}</span>
              <span className="plugin-desc">{t.sleepTimerDurationDesc}</span>
            </div>
            <Select
              value={sleepMins}
              ariaLabel={t.sleepTimerDuration}
              options={SLEEP_TIMER_OPTIONS.map((m) => ({
                value: m as number,
                label: `${m} ${t.minutesShort}`,
              }))}
              onChange={(m) => {
                setSleepMins(m);
                setSleepTimerMinutes(m);
                rearmSleepTimer();
              }}
            />
          </div>
        );
      case 'playback-speed':
        return (
          <div className="plugin-setting-row">
            <div className="plugin-setting-label">
              <span>{t.playbackSpeed}</span>
              <span className="plugin-desc">{t.playbackSpeedDesc}</span>
            </div>
            <Select
              value={speedRate}
              ariaLabel={t.playbackSpeed}
              options={PLAYBACK_SPEEDS.map((r) => ({ value: r as number, label: `${r}×` }))}
              onChange={(r) => {
                setSpeedRate(r);
                setPlaybackSpeed(r);
                audio.playbackRate = r;
              }}
            />
          </div>
        );
      case 'discord-rpc':
        return (
          <div className="plugin-setting-row">
            <div className="plugin-setting-label">
              <span>{t.discordAppId}</span>
              <span className="plugin-desc">{t.discordAppIdDesc}</span>
            </div>
            <input
              className="settings-text-input"
              type="text"
              inputMode="numeric"
              placeholder="1514342633374486709"
              value={discordClientId}
              onChange={(e) => saveDiscordClientId(e.target.value)}
              spellCheck={false}
            />
          </div>
        );
      case 'lyrics-overlay':
        return (
          <>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.overlayFontSize}</span>
                <span className="plugin-desc">{t.overlayFontSizeDesc}</span>
              </div>
              <Select<OverlayFontSize>
                value={overlayFont}
                ariaLabel={t.overlayFontSize}
                options={[
                  { value: 'auto', label: t.overlaySizeAuto },
                  { value: 'sm', label: t.overlaySizeSm },
                  { value: 'md', label: t.overlaySizeMd },
                  { value: 'lg', label: t.overlaySizeLg },
                  { value: 'xl', label: t.overlaySizeXl },
                ]}
                onChange={(v) => {
                  setOverlayFont(v);
                  setOverlayFontSize(v);
                }}
              />
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.overlayPosition}</span>
                <span className="plugin-desc">{t.overlayPositionDesc}</span>
              </div>
              <Select<'bottom' | 'top' | 'center'>
                value={overlayAlign}
                ariaLabel={t.overlayPosition}
                options={[
                  { value: 'bottom', label: t.overlayPosBottom },
                  { value: 'center', label: t.overlayPosCenter },
                  { value: 'top', label: t.overlayPosTop },
                ]}
                onChange={(v) => {
                  setOverlayAlignState(v);
                  setOverlayAlign(v);
                }}
              />
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.overlayOpacity}</span>
                <span className="plugin-desc">{t.overlayOpacityDesc}</span>
              </div>
              <div className="crossfade-secs-control">
                <input
                  type="range"
                  min={0.45}
                  max={0.95}
                  step={0.01}
                  value={overlayOpacity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setOverlayOpacityState(v);
                    setOverlayOpacity(v);
                  }}
                />
                <span className="crossfade-secs-value">{Math.round(overlayOpacity * 100)}%</span>
              </div>
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.overlayHideMeta}</span>
                <span className="plugin-desc">{t.overlayHideMetaDesc}</span>
              </div>
              <button
                role="switch"
                aria-checked={overlayHideMeta}
                aria-label={t.overlayHideMeta}
                type="button"
                className={`plugin-toggle ${overlayHideMeta ? 'on' : ''}`}
                onClick={() => {
                  const next = !overlayHideMeta;
                  setOverlayHideMetaState(next);
                  setOverlayHideMeta(next);
                }}
                aria-pressed={overlayHideMeta}
              >
                <span className="plugin-toggle-knob" />
              </button>
            </div>
            <div className="plugin-setting-row plugin-setting-row--stacked">
              <div className="plugin-setting-label">
                <span>{t.lyricsSyncOffset}</span>
                <span className="plugin-desc">{t.lyricsSyncOffsetDesc}</span>
              </div>
              <div className="crossfade-secs-control">
                <input
                  type="range"
                  min={LYRICS_SYNC_OFFSET_MIN}
                  max={LYRICS_SYNC_OFFSET_MAX}
                  step={LYRICS_SYNC_OFFSET_STEP}
                  value={lyricsSyncOffset}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setLyricsSyncOffsetState(v);
                    setLyricsSyncOffset(v);
                  }}
                />
                <span className="crossfade-secs-value">
                  {lyricsSyncOffset > 0 ? '+' : ''}
                  {lyricsSyncOffset} ms
                </span>
              </div>
            </div>
          </>
        );
      case 'preload-next':
        return (
          <div className="plugin-setting-row">
            <div className="plugin-setting-label">
              <span>{t.preloadDepth}</span>
              <span className="plugin-desc">{t.preloadDepthDesc}</span>
            </div>
            <Select
              value={preloadDepth}
              ariaLabel={t.preloadDepth}
              options={[1, 2, 3].map((n) => ({ value: n, label: String(n) }))}
              onChange={(n) => {
                setPreloadDepthState(n);
                setPreloadDepth(n);
              }}
            />
          </div>
        );
      case 'fade-on-pause':
        return (
          <div className="plugin-setting-row">
            <div className="plugin-setting-label">
              <span>{t.fadePauseMs}</span>
              <span className="plugin-desc">{t.fadePauseDesc}</span>
            </div>
            <div className="crossfade-secs-control">
              <input
                type="range"
                min={0}
                max={600}
                step={20}
                value={fadeMs}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setFadeMs(v);
                  setFadePauseMs(v);
                }}
              />
              <span className="crossfade-secs-value">{fadeMs}ms</span>
            </div>
          </div>
        );
      case 'webhook':
        return (
          <div className="plugin-setting-row">
            <div className="plugin-setting-label">
              <span>{t.webhookUrl}</span>
              <span className="plugin-desc">{t.webhookUrlDesc}</span>
            </div>
            <input
              className="settings-text-input"
              type="url"
              placeholder="https://discord.com/api/webhooks/..."
              value={webhookUrl}
              onChange={(e) => {
                setWebhookUrlState(e.target.value);
                setWebhookUrl(e.target.value);
              }}
              spellCheck={false}
            />
          </div>
        );
      case 'equalizer':
        return (
          <>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.eqPreset}</span>
              </div>
              <Select
                value={eqPreset}
                ariaLabel={t.eqPreset}
                options={[
                  ...Object.keys(EQ_PRESETS).map((k) => ({
                    value: k,
                    label: (t as unknown as Record<string, string>)[`eqP_${k}`] ?? k,
                  })),
                  ...(eqPreset === 'custom' ? [{ value: 'custom', label: t.eqCustom }] : []),
                ]}
                onChange={(k) => {
                  const b = EQ_PRESETS[k];
                  if (!b) return;
                  setEqPresetState(k);
                  setEqBandsState([...b]);
                  setEqBands([...b], k);
                }}
              />
            </div>
            {eqBands.map((g, i) => (
              <div className="plugin-setting-row" key={EQ_LABELS[i]}>
                <div className="plugin-setting-label">
                  <span>{EQ_LABELS[i]} Hz</span>
                </div>
                <div className="crossfade-secs-control">
                  <input
                    type="range"
                    min={EQ_MIN_DB}
                    max={EQ_MAX_DB}
                    step={1}
                    value={g}
                    aria-label={`${EQ_LABELS[i]} Hz`}
                    onChange={(e) => {
                      const next = [...eqBands];
                      next[i] = Number(e.target.value);
                      setEqBandsState(next);
                      setEqPresetState('custom');
                      setEqBands(next, 'custom');
                    }}
                  />
                  <span className="crossfade-secs-value">{g > 0 ? `+${g}` : g} dB</span>
                </div>
              </div>
            ))}
          </>
        );
      case 'loudness-normalization':
        return <p className="plugin-desc">{t.loudnessHint}</p>;
      case 'lastfm-scrobbler':
        return (
          <>
            {lfm?.user ? (
              <div className="plugin-setting-row">
                <div className="plugin-setting-label">
                  <span>{t.lastfmConnectedAs.replace('{user}', lfm.user)}</span>
                </div>
                <button className="np-cancel-btn" onClick={() => lfmRun(lastfmLogout())}>
                  {t.lastfmDisconnect}
                </button>
              </div>
            ) : !lfm?.configured ? (
              <>
                <p className="plugin-desc">
                  {t.lastfmKeysHint}{' '}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void openUrl('https://www.last.fm/api/account/create').catch((err) =>
                        console.debug('PluginsPanel renderSettings', err)
                      );
                    }}
                  >
                    last.fm/api/account/create
                  </a>
                </p>
                <div className="plugin-setting-row">
                  <div className="plugin-setting-label">
                    <span>{t.lfmApiKey}</span>
                  </div>
                  <input
                    className="settings-text-input"
                    value={lfmKey}
                    aria-label={t.lfmApiKey}
                    onChange={(e) => setLfmKey(e.target.value)}
                    spellCheck={false}
                  />
                </div>
                <div className="plugin-setting-row">
                  <div className="plugin-setting-label">
                    <span>{t.lfmSecret}</span>
                  </div>
                  <input
                    className="settings-text-input"
                    type="password"
                    value={lfmSecret}
                    aria-label={t.lfmSecret}
                    onChange={(e) => setLfmSecret(e.target.value)}
                    spellCheck={false}
                  />
                </div>
                <div className="plugin-setting-row">
                  <span />
                  <button
                    className="np-cancel-btn"
                    onClick={() => lfmRun(lastfmSetKeys(lfmKey, lfmSecret))}
                  >
                    {t.lastfmSave}
                  </button>
                </div>
              </>
            ) : (
              <div className="plugin-setting-row">
                <div className="plugin-setting-label">
                  <span>{lfm.pending ? t.lastfmFinishHint : t.lastfmConnectHint}</span>
                </div>
                {lfm.pending ? (
                  <button className="np-cancel-btn" onClick={() => lfmRun(lastfmFinishAuth())}>
                    {t.lastfmFinish}
                  </button>
                ) : (
                  <button
                    className="np-cancel-btn"
                    onClick={() =>
                      lfmRun(
                        lastfmBeginAuth().then(async (url) => {
                          await openUrl(url).catch((err) =>
                            console.debug('PluginsPanel renderSettings', err)
                          );
                          return lastfmStatus();
                        })
                      )
                    }
                  >
                    {t.lastfmConnect}
                  </button>
                )}
              </div>
            )}
            {lfmErr && <p className="plugin-desc">{lfmErr}</p>}
          </>
        );
      case 'remote-control':
        return (
          <>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.remoteUrl}</span>
                <span className="plugin-desc">{t.remoteUrlDesc}</span>
              </div>
              {remoteOn && remoteInfo?.url ? (
                <span
                  className="remote-url"
                  style={{ userSelect: 'text', fontWeight: 600, textAlign: 'right' }}
                >
                  {remoteInfo.url}
                  {remoteInfo.mdnsUrl && (
                    <span className="plugin-desc" style={{ display: 'block', fontWeight: 400 }}>
                      {remoteInfo.mdnsUrl}
                    </span>
                  )}
                </span>
              ) : (
                <span className="plugin-desc">{remoteOn ? t.remoteStarting : '-'}</span>
              )}
            </div>
            {remoteOn && fw?.windows && !fw.ruleOk && (
              <div className="remote-fw-warn" role="alert" data-testid="remote-fw-warn">
                <span>{fw.publicNetwork ? t.remoteFwPublic : t.remoteFwMissing}</span>
                <button
                  type="button"
                  className="np-cancel-btn"
                  disabled={fwBusy}
                  onClick={async () => {
                    setFwBusy(true);
                    const ok = await allowThroughFirewall();
                    setFwBusy(false);
                    setFw(await getFirewallStatus());
                    if (!ok) setFw((f) => (f ? { ...f, ruleOk: false } : f));
                  }}
                >
                  {fwBusy ? t.remoteFwBusy : t.remoteFwFix}
                </button>
              </div>
            )}
            {remoteOn && remoteInfo?.qrSvg && (
              <div
                className="remote-qr"
                data-testid="remote-qr"
                role="img"
                aria-label={t.remoteQrAlt}
                dangerouslySetInnerHTML={{ __html: remoteInfo.qrSvg }}
              />
            )}
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.remotePairMode}</span>
                <span className="plugin-desc">{t.remotePairModeDesc}</span>
              </div>
              <button
                role="switch"
                aria-checked={remotePair}
                aria-label={t.remotePairMode}
                type="button"
                className={`plugin-toggle ${remotePair ? 'on' : ''}`}
                onClick={() => {
                  const next = !remotePair;
                  setRemotePairState(next);
                  setRemotePairMode(next);
                  if (remoteOn)
                    restartRemote()
                      .then((i) => i && setRemoteInfo(i))
                      .catch((e) => setRemoteErr(`${t.remoteError}: ${String(e)}`));
                }}
              >
                <span className="plugin-toggle-knob" />
              </button>
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.remotePort}</span>
                <span className="plugin-desc">{t.remotePortDesc}</span>
              </div>
              <input
                className="settings-text-input"
                type="number"
                min={1024}
                max={65535}
                style={{ maxWidth: 110 }}
                value={remotePort}
                onChange={(e) => setRemotePortState(e.target.value)}
                onBlur={applyRemoteConfig}
                onKeyDown={(e) => e.key === 'Enter' && applyRemoteConfig()}
              />
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.remotePin}</span>
                <span className="plugin-desc">{t.remotePinDesc}</span>
              </div>
              <input
                className="settings-text-input"
                type="text"
                inputMode="numeric"
                maxLength={32}
                style={{ maxWidth: 140 }}
                value={remotePin}
                onChange={(e) => setRemotePinState(e.target.value)}
                onBlur={applyRemoteConfig}
                onKeyDown={(e) => e.key === 'Enter' && applyRemoteConfig()}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            {remoteOn && remoteInfo && (
              <div className="plugin-setting-row">
                <div className="plugin-setting-label">
                  <span>
                    {t.remoteClients}: {remoteInfo.clients}
                  </span>
                  <span className="plugin-desc">
                    {t.remotePaired}: {remoteInfo.pairedDevices}
                  </span>
                </div>
                {remoteInfo.pairedDevices > 0 && (
                  <button
                    type="button"
                    className="np-cancel-btn"
                    onClick={() => void forgetRemoteDevices().then((i) => i && setRemoteInfo(i))}
                  >
                    {t.remoteForget}
                  </button>
                )}
              </div>
            )}
            {remoteErr && <p className="plugin-desc">{remoteErr}</p>}
            <p className="plugin-desc">{t.remoteFirewall}</p>
          </>
        );
      case 'duck-on-voice':
        return (
          <>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.duckLevel}</span>
                <span className="plugin-desc">{t.duckLevelDesc}</span>
              </div>
              <div className="crossfade-secs-control">
                <input
                  type="range"
                  min={0.05}
                  max={0.5}
                  step={0.05}
                  value={duckLvl}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setDuckLvl(v);
                    setDuckLevel(v);
                  }}
                />
                <span className="crossfade-secs-value">{Math.round(duckLvl * 100)}%</span>
              </div>
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.duckSensitivity}</span>
                <span className="plugin-desc">{t.duckSensitivityDesc}</span>
              </div>
              <div className="crossfade-secs-control">
                <input
                  type="range"
                  min={0.01}
                  max={0.12}
                  step={0.01}
                  value={duckSens}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setDuckSens(v);
                    setDuckSensitivity(v);
                  }}
                />
                <span className="crossfade-secs-value">{Math.round(duckSens * 100)}%</span>
              </div>
            </div>
          </>
        );
      case 'lyrics-karaoke':
        return (
          <>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.karaokeMode}</span>
                <span className="plugin-desc">{t.karaokeModeDesc}</span>
              </div>
              <button
                role="switch"
                aria-checked={karaoke}
                aria-label={t.karaokeMode}
                className={`plugin-toggle ${karaoke ? 'on' : ''}`}
                onClick={() => {
                  const next = !karaoke;
                  setKaraoke(next);
                  setKaraokeMode(next);
                }}
              >
                <span className="plugin-toggle-knob" />
              </button>
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.highContrastLyrics}</span>
                <span className="plugin-desc">{t.highContrastLyricsDesc}</span>
              </div>
              <button
                role="switch"
                aria-checked={hiContrast}
                aria-label={t.highContrastLyrics}
                className={`plugin-toggle ${hiContrast ? 'on' : ''}`}
                onClick={() => {
                  const next = !hiContrast;
                  setHiContrast(next);
                  setHighContrastLyrics(next);
                }}
              >
                <span className="plugin-toggle-knob" />
              </button>
            </div>
          </>
        );
      case 'listening-room':
        return (
          <div className="plugin-setting-col">
            <p className="plugin-desc">{t.roomWebRtcHint}</p>
            {roomCode ? (
              <>
                <div className="room-code-display">
                  {t.roomCode}: <strong>{roomCode}</strong>
                </div>
                <p className="plugin-desc">
                  {t.roomPeers}: {peers}
                </p>
                <button
                  className="np-create-btn"
                  type="button"
                  onClick={() =>
                    leaveRoom().then(() => {
                      setRoomCode('');
                      setPeers(0);
                      setRoomError('');
                    })
                  }
                >
                  {t.roomLeave}
                </button>
              </>
            ) : (
              <>
                <button
                  className="np-create-btn"
                  type="button"
                  disabled={roomBusy}
                  onClick={() => {
                    setRoomBusy(true);
                    setRoomError('');
                    createRoom()
                      .then((c) => {
                        setRoomCode(c);
                        setPeers(roomPeerCount());
                      })
                      .catch(() => setRoomError(t.roomCreateFailed))
                      .finally(() => setRoomBusy(false));
                  }}
                >
                  {t.roomCreate}
                </button>
                <input
                  className="settings-text-input"
                  placeholder={t.roomJoinPlaceholder}
                  value={joinInput}
                  onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
                  maxLength={6}
                />
                <button
                  className="np-create-btn"
                  type="button"
                  disabled={roomBusy}
                  onClick={() => {
                    setRoomBusy(true);
                    setRoomError('');
                    joinRoom(joinInput.trim())
                      .then((ok) => {
                        if (ok) {
                          setRoomCode(joinInput.trim().toUpperCase());
                          setPeers(roomPeerCount());
                        } else setRoomError(t.roomJoinFailed);
                      })
                      .finally(() => setRoomBusy(false));
                  }}
                >
                  {t.roomJoin}
                </button>
              </>
            )}
            {roomError ? <p className="plugin-desc">{roomError}</p> : null}
          </div>
        );
      case 'stats-tracker': {
        const hrs = Math.floor(listenStats.totalSeconds / 3600);
        const mins = Math.floor((listenStats.totalSeconds % 3600) / 60);
        const titles = new Map(history.map((h) => [h.id, `${h.title} - ${h.artist}`]));
        const top = Object.entries(listenStats.trackPlays)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        return (
          <div className="plugin-setting-col">
            <div className="plugin-stats-grid">
              <div className="plugin-stat">
                <span className="plugin-stat-value">
                  {hrs} h {mins} min
                </span>
                <span className="plugin-desc">{t.statsTotalTime}</span>
              </div>
              <div className="plugin-stat">
                <span className="plugin-stat-value">{listenStats.sessions}</span>
                <span className="plugin-desc">{t.statsTrackStarts}</span>
              </div>
            </div>
            {top.length > 0 && (
              <>
                <span className="plugin-setting-subtitle">{t.statsTopTracks}</span>
                <ol className="plugin-mini-list">
                  {top.map(([id, minutes]) => (
                    <li key={id}>
                      <span className="plugin-mini-list-title">{titles.get(id) ?? id}</span>
                      <span className="plugin-desc">
                        {Math.max(1, Math.round(minutes))} {t.minutesShort}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            <div>
              <button
                type="button"
                className="np-cancel-btn"
                onClick={() => {
                  resetListenStats();
                  setListenStats(getListenStats());
                }}
              >
                {t.statsReset}
              </button>
            </div>
          </div>
        );
      }
      case 'listening-history':
        return (
          <div className="plugin-setting-col">
            {history.length === 0 ? (
              <p className="plugin-desc">{t.historyEmpty}</p>
            ) : (
              <ol className="plugin-mini-list">
                {history.slice(0, 12).map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="plugin-mini-list-btn"
                      disabled={!onPlayTrack}
                      onClick={() =>
                        onPlayTrack?.(
                          {
                            id: h.id,
                            type: 'track',
                            title: h.title,
                            artist: h.artist,
                            cover: h.cover || '',
                            coverSmall: h.cover,
                            coverLarge: h.cover,
                          },
                          history.map((x) => ({
                            id: x.id,
                            type: 'track' as const,
                            title: x.title,
                            artist: x.artist,
                            cover: x.cover || '',
                            coverSmall: x.cover,
                            coverLarge: x.cover,
                          }))
                        )
                      }
                    >
                      <span className="plugin-mini-list-title">{h.title}</span>
                      <span className="plugin-desc">
                        {h.artist} ·{' '}
                        {new Date(h.playedAt).toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {history.length > 0 && (
              <div>
                <button
                  type="button"
                  className="np-cancel-btn"
                  onClick={() => {
                    clearListeningHistory();
                    setHistory([]);
                  }}
                >
                  {t.historyClear}
                </button>
              </div>
            )}
          </div>
        );
      case 'zenith-stage':
        return <p className="plugin-desc">{t.stageHint}</p>;
      case 'dualsense-pad':
        return <p className="plugin-desc">{t.dualSenseHint}</p>;
      default:
        return <p className="plugin-no-settings">{t.pluginNoSettings}</p>;
    }
  };

  const hasSettings = (id: string) =>
    [
      'crossfade',
      'sleep-timer',
      'offline-downloads',
      'global-hotkeys',
      'playback-speed',
      'discord-rpc',
      'lyrics-overlay',
      'preload-next',
      'fade-on-pause',
      'webhook',
      'remote-control',
      'equalizer',
      'loudness-normalization',
      'lastfm-scrobbler',
      'duck-on-voice',
      'lyrics-karaoke',
      'listening-room',
      'zenith-stage',
      'dualsense-pad',
      'stats-tracker',
      'listening-history',
    ].includes(id);

  return (
    <ModalOverlay onClick={onClose} testId="plugins-overlay">
      <div className="glass-modal-container plugins-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-polished">
          <h2>{t.plugins}</h2>
          <X size={26} className="modal-close-icon" onClick={onClose} />
        </div>
        <div className="plugins-search">
          <Search size={16} aria-hidden />
          <input
            type="text"
            role="searchbox"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder={t.pluginSearch}
            aria-label={t.pluginSearch}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            data-testid="plugin-search"
          />
          {query && (
            <button
              type="button"
              className="plugins-search-clear"
              aria-label={t.pluginSearchClear}
              title={t.pluginSearchClear}
              onClick={() => setQuery('')}
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
        <div className="modal-body-polished plugins-modal-body">
          {(() => {
            const q = deferredQuery.trim().toLowerCase();
            const groups = pluginManager.byCategory();
            let shown = 0;
            const blocks = PLUGIN_CATEGORY_ORDER.map((cat) => {
              const items = groups[cat]
                .map((plugin) => ({
                  plugin,
                  text: pluginText(lang, plugin.id, {
                    name: plugin.name,
                    desc: plugin.description,
                  }),
                }))
                .filter(({ plugin, text }) => {
                  if (!q) return true;
                  const other = pluginText(lang === 'pl' ? 'en' : 'pl', plugin.id, {
                    name: plugin.name,
                    desc: plugin.description,
                  });
                  return pluginQueryMatches([text.name, text.desc, other.name, other.desc], q);
                });
              if (items.length === 0) return null;
              shown += items.length;
              const Icon = CATEGORY_ICONS[cat];
              const onCount = items.filter(({ plugin }) => pluginStates[plugin.id]).length;
              return (
                <section key={cat} className="plugin-category-block" data-category={cat}>
                  <header className="plugin-category-head">
                    <span className="plugin-category-icon">
                      <Icon size={15} aria-hidden />
                    </span>
                    <h3 className="plugin-category-label">{PLUGIN_CATEGORY_LABELS[cat][lang]}</h3>
                    <span className="plugin-category-count">
                      {t.pluginOnCount
                        .replace('{on}', String(onCount))
                        .replace('{n}', String(items.length))}
                    </span>
                  </header>
                  <div className="plugin-category-list">
                    {items.map(({ plugin, text }) => (
                      <PluginCard
                        key={plugin.id}
                        enabled={Boolean(pluginStates[plugin.id])}
                        name={text.name}
                        description={text.desc}
                        onToggle={() => togglePlugin(plugin.id)}
                        expanded={expandedId === plugin.id}
                        onExpand={() =>
                          setExpandedId((prev) => (prev === plugin.id ? null : plugin.id))
                        }
                        settings={
                          hasSettings(plugin.id)
                            ? renderSettings(plugin.id)
                            : renderSettings('default')
                        }
                        t={t}
                      />
                    ))}
                  </div>
                </section>
              );
            });
            return shown ? blocks : <p className="plugin-desc plugins-empty">{t.pluginNoMatch}</p>;
          })()}
        </div>
      </div>
    </ModalOverlay>
  );
}

const CATEGORY_ICONS: Record<PluginCategory, typeof Play> = {
  playback: Play,
  sound: SlidersHorizontal,
  lyrics: Quote,
  control: Gamepad2,
  integrations: Share2,
  interface: LayoutDashboard,
};
