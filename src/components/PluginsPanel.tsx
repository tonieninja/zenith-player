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
