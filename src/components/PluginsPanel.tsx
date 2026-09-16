import { useEffect, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { pluginManager, PLUGIN_CATEGORY_LABELS } from '../plugins';
import {
  getCrossfadeSeconds,
  saveCrossfadeSeconds,
  CROSSFADE_MIN_SECS,
  CROSSFADE_MAX_SECS,
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
import type { DualAudio } from '../audio/dualAudio';

interface PluginsPanelProps {
  lang: Language;
  pluginStates: Record<string, boolean>;
  togglePlugin: (id: string) => void;
  onClose: () => void;
  discordClientId: string;
  saveDiscordClientId: (v: string) => void;
  audio: DualAudio;
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
  return (
    <div className={`plugin-card ${enabled ? 'enabled' : ''} ${expanded ? 'expanded' : ''}`}>
      <div className="plugin-card-header">
        <button className="plugin-card-expand" onClick={onExpand} aria-expanded={expanded}>
          <ChevronDown size={18} className={`plugin-card-chevron ${expanded ? 'open' : ''}`} />
        </button>
        <div className="plugin-info" onClick={onExpand}>
          <span className="setting-label">{name}</span>
          <span className="plugin-desc">{description}</span>
        </div>
        <button
          className={`plugin-toggle ${enabled ? 'on' : ''}`}
          onClick={onToggle}
          aria-label={enabled ? t.pluginEnabled : t.pluginDisabled}
        >
          <span className="plugin-toggle-knob" />
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
}: PluginsPanelProps) {
  const t = translations[lang];
  const [crossfadeSecs, setCrossfadeSecs] = useState(getCrossfadeSeconds);
  const [sleepMins, setSleepMins] = useState(getSleepTimerMinutes);
  const [speedRate, setSpeedRate] = useState(() =>
    getPlaybackSpeed(pluginStates['playback-speed'])
  );
  const [overlayFont, setOverlayFont] = useState<OverlayFontSize>(getOverlayFontSize);
  const [overlayAlign, setOverlayAlignState] = useState(getOverlayAlign);
  const [overlayOpacity, setOverlayOpacityState] = useState(getOverlayOpacity);
  const [overlayHideMeta, setOverlayHideMetaState] = useState(getOverlayHideMeta);
  const [lyricsSyncOffset, setLyricsSyncOffsetState] = useState(getLyricsSyncOffset);
  const [expandedId, setExpandedId] = useState<string | null>('lyrics-overlay');
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

  useEffect(() => {
    if (!roomCode) return;
    const tick = () => {
      void refreshRoomPeerCount().then((n) => setPeers(n));
    };
    tick();
    const iv = window.setInterval(tick, 8000);
    return () => window.clearInterval(iv);
  }, [roomCode]);

  const renderSettings = (id: string) => {
    switch (id) {
      case 'crossfade':
        return (
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
        );
      case 'sleep-timer':
        return (
          <div className="plugin-setting-row">
            <div className="plugin-setting-label">
              <span>{t.sleepTimerDuration}</span>
              <span className="plugin-desc">{t.sleepTimerDurationDesc}</span>
            </div>
            <select
              className="settings-select"
              value={sleepMins}
              onChange={(e) => {
                const m = Number(e.target.value);
                setSleepMins(m);
                setSleepTimerMinutes(m);
                rearmSleepTimer();
              }}
            >
              {SLEEP_TIMER_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </div>
        );
      case 'playback-speed':
        return (
          <div className="plugin-setting-row">
            <div className="plugin-setting-label">
              <span>{t.playbackSpeed}</span>
              <span className="plugin-desc">{t.playbackSpeedDesc}</span>
            </div>
            <select
              className="settings-select"
              value={speedRate}
              onChange={(e) => {
                const r = Number(e.target.value);
                setSpeedRate(r);
                setPlaybackSpeed(r);
                audio.playbackRate = r;
              }}
            >
              {PLAYBACK_SPEEDS.map((r) => (
                <option key={r} value={r}>
                  {r}x
                </option>
              ))}
            </select>
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
              <select
                className="settings-select"
                value={overlayFont}
                onChange={(e) => {
                  const v = e.target.value as OverlayFontSize;
                  setOverlayFont(v);
                  setOverlayFontSize(v);
                }}
              >
                <option value="auto">{t.overlaySizeAuto}</option>
                <option value="sm">{t.overlaySizeSm}</option>
                <option value="md">{t.overlaySizeMd}</option>
                <option value="lg">{t.overlaySizeLg}</option>
                <option value="xl">{t.overlaySizeXl}</option>
              </select>
            </div>
            <div className="plugin-setting-row">
              <div className="plugin-setting-label">
                <span>{t.overlayPosition}</span>
                <span className="plugin-desc">{t.overlayPositionDesc}</span>
              </div>
              <select
                className="settings-select"
                value={overlayAlign}
                onChange={(e) => {
                  const v = e.target.value as 'bottom' | 'top' | 'center';
                  setOverlayAlignState(v);
                  setOverlayAlign(v);
                }}
              >
                <option value="bottom">{t.overlayPosBottom}</option>
                <option value="center">{t.overlayPosCenter}</option>
                <option value="top">{t.overlayPosTop}</option>
              </select>
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
            <div className="plugin-setting-row">
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
            <select
              className="settings-select"
              value={preloadDepth}
              onChange={(e) => {
                const n = Number(e.target.value);
                setPreloadDepthState(n);
                setPreloadDepth(n);
              }}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
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
                      .catch(() => setRoomError('Could not create room'))
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
                        } else setRoomError('Join failed - check code / network');
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
      'playback-speed',
      'discord-rpc',
      'lyrics-overlay',
      'preload-next',
      'fade-on-pause',
      'webhook',
      'duck-on-voice',
      'lyrics-karaoke',
      'listening-room',
      'zenith-stage',
      'dualsense-pad',
    ].includes(id);

  return (
    <div className="global-modal-overlay" onClick={onClose}>
      <div className="glass-modal-container plugins-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-polished">
          <h2>{t.plugins}</h2>
          <X size={26} className="modal-close-icon" onClick={onClose} />
        </div>
        <div className="modal-body-polished plugins-modal-body">
          {(['playback', 'visual', 'social', 'utility'] as const).map((cat) => (
            <div key={cat} className="plugin-category-block">
              <div className="plugin-category-label">{PLUGIN_CATEGORY_LABELS[cat][lang]}</div>
              {pluginManager.byCategory()[cat].map((plugin) => {
                const text = pluginText(lang, plugin.id, {
                  name: plugin.name,
                  desc: plugin.description,
                });
                return (
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
                      hasSettings(plugin.id) ? renderSettings(plugin.id) : renderSettings('default')
                    }
                    t={t}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
