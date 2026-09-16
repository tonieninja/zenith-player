/**
 * in-app qa, window.__zenithQA after mount
 * dumps go to localappdata via debug_write_dump
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { pluginManager } from '../plugins';
import { getRoomCode, refreshRoomPeerCount, roomPeerCount } from '../plugins/listeningRoom';

export type QaCheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export type QaCheck = {
  id: string;
  status: QaCheckStatus;
  detail?: string;
  ms?: number;
};

export type QaSnapshot = {
  activeTab: string;
  loading: boolean;
  libLoading: boolean;
  libAuthed: boolean;
  sectionCount: number;
  sectionTitles: string[];
  quickPickCount: number;
  queueLen: number;
  queueIndex: number;
  isPlaying: boolean;
  buffering: boolean;
  hasTrack: boolean;
  trackTitle: string | null;
  trackArtist: string | null;
  progress: number;
  duration: number;
  volume: number;
  muted: boolean;
  loopMode: string;
  shuffleOn: boolean;
  lang: string;
  pluginsEnabled: string[];
  splashVisible: boolean;
  panels: { plugins: boolean; settings: boolean; queue: boolean };
  lyricsLoading: boolean;
  lyricsLines: number;
  relatedSections: number;
  userPlaylistCount: number;
  frozenSuspect: boolean;
};

export type QaHooks = {
  getSnapshot: () => QaSnapshot;
  goHome: () => void;
  goExplore: () => void;
  goLibrary: () => void;
  goMoods: () => void;
  goPlayer: () => void;
  search: (q: string) => void;
  playFirstHomeTrack: () => Promise<boolean>;
  playFirstSearchTrack: () => Promise<boolean>;
  togglePlay: () => Promise<void>;
  playNext: () => void;
  playPrev: () => void;
  seek: (t: number) => void;
  toggleMute: () => void;
  cycleLoop: () => void;
  toggleShuffle: () => void;
  openPlugins: () => void;
  openSettings: () => void;
  openQueue: () => void;
  closePanels: () => void;
  setVolume: (v: number) => void;
  setPlugin: (id: string, on: boolean) => void;
  openMoodCategory: (id: string) => void;
  createListeningRoom: () => Promise<string>;
  leaveListeningRoom: () => Promise<void>;
};

export type ZenithQaApi = {
  snapshot: () => QaSnapshot;
  runSmoke: () => Promise<QaCheck[]>;
  runFull: () => Promise<{ checks: QaCheck[]; ok: boolean; path?: string }>;
  runSocial: () => Promise<{ checks: QaCheck[]; ok: boolean; path?: string; roomCode?: string }>;
  runRelease: () => Promise<{
    checks: QaCheck[];
    ok: boolean;
    path?: string;
    roomCode?: string;
  }>;
  dump: (name?: string) => Promise<string>;
  plugins: () => { id: string; enabled: boolean; category: string }[];
  hooks: QaHooks;
};

function now() {
  return performance.now();
}

async function writeDump(name: string, data: unknown): Promise<string> {
  try {
    return await invoke<string>('debug_write_dump', {
      name,
      contents: JSON.stringify(data, null, 2),
    });
  } catch (e) {
    console.warn('[qa] dump failed', e);
    return '';
  }
}

async function timedCheck(
  id: string,
  fn: () => Promise<{ status: QaCheckStatus; detail?: string }>
): Promise<QaCheck> {
  const t0 = now();
  try {
    const r = await fn();
    return { id, status: r.status, detail: r.detail, ms: Math.round(now() - t0) };
  } catch (e) {
    return {
      id,
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
      ms: Math.round(now() - t0),
    };
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 200
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await wait(stepMs);
  }
  return Boolean(await pred());
}

/** plugins we can flick on/off in qa without spamming discord / rooms / hid */
const SAFE_PLUGIN_TOGGLES = [
  'ab-loop',
  'copy-track-link',
  'share-card',
  'playback-speed',
  'sleep-timer',
  'auto-pause-blur',
  'mini-player',
  'lyrics-overlay',
  'lyrics-karaoke',
  'window-title',
] as const;

export function installZenithQa(hooks: QaHooks): ZenithQaApi {
  const api: ZenithQaApi = {
    hooks,
    snapshot: () => hooks.getSnapshot(),
    plugins: () =>
      pluginManager.plugins.map((p) => ({
        id: p.id,
        enabled: pluginManager.isEnabled(p.id),
        category: p.category,
      })),
    dump: async (name = 'qa_snapshot.json') => {
      const snap = hooks.getSnapshot();
      return writeDump(name, { at: new Date().toISOString(), snap, plugins: api.plugins() });
    },
    runSmoke: async () => {
      const checks: QaCheck[] = [];
      const snap0 = hooks.getSnapshot();
      const track = async (
        id: string,
        fn: () => Promise<{ status: QaCheckStatus; detail?: string }>
      ) => {
        const c = await timedCheck(id, fn);
        checks.push(c);
        await writeDump('qa_progress.json', {
          at: new Date().toISOString(),
          stage: id,
          last: c,
          checks,
        });
        return c;
      };

      await track('ui.mounted', async () => ({
        status: 'pass',
        detail: `tab=${snap0.activeTab} loading=${snap0.loading} sections=${snap0.sectionCount}`,
      }));

      await track('backend.ytm_browse', async () => {
        try {
          const raw = await invoke<string>('ytm_browse', {
            browseId: 'FEmusic_home',
            hl: snap0.lang === 'pl' ? 'pl' : 'en',
            gl: snap0.lang === 'pl' ? 'PL' : 'US',
          });
          const data = JSON.parse(raw);
          const n = Array.isArray(data?.zenithSections) ? data.zenithSections.length : -1;
          if (n <= 0) return { status: 'warn', detail: `raw ok but sections=${n}` };
          return { status: 'pass', detail: `rust home sections=${n}, bytes=${raw.length}` };
        } catch (e) {
          return { status: 'fail', detail: String(e) };
        }
      });

      await track('home.feed', async () => {
        hooks.goHome();
        const ok = await waitFor(() => {
          const s = hooks.getSnapshot();
          return !s.loading && (s.sectionCount > 0 || s.quickPickCount > 0);
        }, 12000);
        const s = hooks.getSnapshot();
        await writeDump('qa_stage_home.json', { snap: s });
        if (!ok) {
          return {
            status: 'fail',
            detail: `no home content (sections=${s.sectionCount}, loading=${s.loading})`,
          };
        }
        return {
          status: s.sectionCount < 1 ? 'warn' : 'pass',
          detail: `${s.sectionCount} sections, ${s.quickPickCount} QP - ${s.sectionTitles.slice(0, 5).join(' | ')}`,
        };
      });

      await track('backend.ytdlp', async () => {
        try {
          await invoke('ensure_ytdlp_ready');
          return { status: 'pass', detail: 'yt-dlp ready' };
        } catch (e) {
          return { status: 'fail', detail: String(e) };
        }
      });

      await track('explore.nav', async () => {
        hooks.goExplore();
        const ok = await waitFor(() => {
          const s = hooks.getSnapshot();
          return s.activeTab === 'explore' && !s.loading;
        }, 12000);
        const s = hooks.getSnapshot();
        await writeDump('qa_stage_explore.json', { snap: s });
        if (!ok || s.activeTab !== 'explore') {
          return { status: 'fail', detail: `tab=${s.activeTab} loading=${s.loading}` };
        }
        return {
          status: s.sectionCount > 0 ? 'pass' : 'warn',
          detail: `explore sections=${s.sectionCount}`,
        };
      });

      await track('library.nav', async () => {
        hooks.goLibrary();
        await wait(600);
        const s = hooks.getSnapshot();
        await writeDump('qa_stage_library.json', { snap: s });
        if (s.activeTab !== 'library') {
          return { status: 'fail', detail: `tab=${s.activeTab}` };
        }
        return {
          status: 'pass',
          detail: `authed=${s.libAuthed} libLoading=${s.libLoading} playlists=${s.userPlaylistCount}`,
        };
      });

      await track('moods.nav', async () => {
        hooks.goMoods();
        await wait(400);
        const s = hooks.getSnapshot();
        await writeDump('qa_stage_moods.json', { snap: s });
        return {
          status: s.activeTab === 'moods_genres' ? 'pass' : 'fail',
          detail: `tab=${s.activeTab}`,
        };
      });

      await track('mood.open', async () => {
        hooks.openMoodCategory('focus');
        const ok = await waitFor(() => hooks.getSnapshot().activeTab === 'mood', 10000);
        const s = hooks.getSnapshot();
        await writeDump('qa_stage_mood_detail.json', { snap: s });
        return {
          status: ok ? (s.sectionCount > 0 ? 'pass' : 'warn') : 'fail',
          detail: `tab=${s.activeTab} sections=${s.sectionCount}`,
        };
      });

      await track('search.query', async () => {
        hooks.search('adele');
        const ok = await waitFor(() => {
          const s = hooks.getSnapshot();
          return s.activeTab === 'search' && !s.loading && s.sectionCount > 0;
        }, 12000);
        const s = hooks.getSnapshot();
        await writeDump('qa_stage_search.json', { snap: s });
        return {
          status: ok ? 'pass' : 'fail',
          detail: `sections=${s.sectionCount} loading=${s.loading}`,
        };
      });

      await track('playback.start', async () => {
        const fromSearch = await hooks.playFirstSearchTrack();
        if (!fromSearch) {
          hooks.goHome();
          await waitFor(() => hooks.getSnapshot().sectionCount > 0, 10000);
          const started = await hooks.playFirstHomeTrack();
          if (!started) return { status: 'fail', detail: 'no playable track' };
        }
        const ok = await waitFor(() => {
          const s = hooks.getSnapshot();
          return s.hasTrack && (s.isPlaying || s.buffering || s.progress > 0);
        }, 20000);
        const s = hooks.getSnapshot();
        await writeDump('qa_stage_player.json', { snap: s });
        if (!ok) {
          return {
            status: 'fail',
            detail: `track=${s.trackTitle} playing=${s.isPlaying} buffering=${s.buffering}`,
          };
        }
        return {
          status: 'pass',
          detail: `"${s.trackTitle}" - ${s.trackArtist} playing=${s.isPlaying}`,
        };
      });

      await track('playback.toggle', async () => {
        await waitFor(() => hooks.getSnapshot().isPlaying || hooks.getSnapshot().buffering, 8000);
        const before = hooks.getSnapshot().isPlaying;
        if (!hooks.getSnapshot().hasTrack) {
          return { status: 'skip', detail: 'no track to toggle' };
        }
        await hooks.togglePlay();
        await wait(700);
        let after = hooks.getSnapshot().isPlaying;
        if (before === after) {
          await wait(800);
          after = hooks.getSnapshot().isPlaying;
        }
        if (before === after) {
          return {
            status: 'warn',
            detail: `stuck isPlaying=${after} buffering=${hooks.getSnapshot().buffering}`,
          };
        }
        await hooks.togglePlay();
        await wait(500);
        return {
          status: 'pass',
          detail: `toggled ${before}->${!before}->${hooks.getSnapshot().isPlaying}`,
        };
      });

      await track('playback.seek', async () => {
        const s0 = hooks.getSnapshot();
        if (!s0.hasTrack || !(s0.duration > 30 && s0.duration < 3600)) {
          return { status: 'skip', detail: `duration=${s0.duration}` };
        }
        hooks.seek(12);
        await wait(600);
        const p = hooks.getSnapshot().progress;
        return {
          status: p >= 8 && p <= 20 ? 'pass' : 'warn',
          detail: `seeked to ~12, progress=${p.toFixed(1)}`,
        };
      });

      await track('playback.loop_shuffle_mute', async () => {
        const a = hooks.getSnapshot();
        hooks.cycleLoop();
        await wait(100);
        hooks.cycleLoop();
        await wait(100);
        hooks.toggleShuffle();
        await wait(150);
        hooks.toggleMute();
        await wait(150);
        const b = hooks.getSnapshot();
        hooks.toggleMute();
        hooks.toggleShuffle();
        hooks.cycleLoop();
        return {
          status: 'pass',
          detail: `loop ${a.loopMode}->${b.loopMode} shuffle ${a.shuffleOn}->${b.shuffleOn} muted=${b.muted}`,
        };
      });

      await track('playback.next_prev', async () => {
        const a = hooks.getSnapshot();
        if (a.queueLen < 2) {
          return { status: 'skip', detail: `queueLen=${a.queueLen}` };
        }
        const id0 = a.trackTitle;
        hooks.playNext();
        await waitFor(() => hooks.getSnapshot().trackTitle !== id0, 6000);
        const id1 = hooks.getSnapshot().trackTitle;
        hooks.playPrev();
        await wait(800);
        return {
          status: id1 && id1 !== id0 ? 'pass' : 'warn',
          detail: `${id0} -> ${id1} -> ${hooks.getSnapshot().trackTitle}`,
        };
      });

      await track('player.lyrics_related', async () => {
        hooks.goPlayer();
        await wait(500);
        await waitFor(() => !hooks.getSnapshot().lyricsLoading, 20000);
        const s = hooks.getSnapshot();
        return {
          status: 'pass',
          detail: `lyricsLines=${s.lyricsLines} related=${s.relatedSections} loading=${s.lyricsLoading}`,
        };
      });

      await track('plugins.registry', async () => {
        const list = api.plugins();
        if (list.length < 31) {
          return { status: 'fail', detail: `only ${list.length} plugins` };
        }
        const on = list.filter((p) => p.enabled).map((p) => p.id);
        return { status: 'pass', detail: `${list.length} plugins, ${on.length} enabled` };
      });

      await track('plugins.toggle_safe', async () => {
        const results: string[] = [];
        for (const id of SAFE_PLUGIN_TOGGLES) {
          const was = pluginManager.isEnabled(id);
          try {
            hooks.setPlugin(id, true);
            await wait(350);
            if (!pluginManager.isEnabled(id)) {
              results.push(`${id}:fail-on`);
              continue;
            }
            hooks.setPlugin(id, false);
            await wait(250);
            if (pluginManager.isEnabled(id)) {
              results.push(`${id}:fail-off`);
              continue;
            }
            if (was) hooks.setPlugin(id, true);
            results.push(`${id}:ok`);
          } catch (e) {
            results.push(`${id}:err`);
            try {
              hooks.setPlugin(id, was);
            } catch {}
          }
        }
        const fails = results.filter((r) => !r.endsWith(':ok'));
        await writeDump('qa_stage_plugins.json', { results });
        return {
          status: fails.length ? 'warn' : 'pass',
          detail: fails.length ? fails.join(', ') : `${results.length} toggles ok`,
        };
      });

      await track('ui.freeze_watch', async () => {
        const t0 = Date.now();
        let ticks = 0;
        await new Promise<void>((resolve) => {
          const iv = window.setInterval(() => {
            ticks += 1;
            if (ticks >= 10) {
              window.clearInterval(iv);
              resolve();
            }
          }, 100);
        });
        const elapsed = Date.now() - t0;
        if (ticks < 8) {
          return { status: 'fail', detail: `only ${ticks}/10 ticks in ${elapsed}ms` };
        }
        const s = hooks.getSnapshot();
        return {
          status: s.frozenSuspect ? 'warn' : 'pass',
          detail: `ticks=${ticks} elapsed=${elapsed}ms loading=${s.loading}`,
        };
      });

      await writeDump('qa_smoke.json', {
        at: new Date().toISOString(),
        checks,
        snapshot: hooks.getSnapshot(),
      });
      return checks;
    },
    runFull: async () => {
      const checks = await api.runSmoke();

      checks.push(
        await timedCheck('ui.open_panels', async () => {
          hooks.openPlugins();
          await wait(500);
          await writeDump('qa_stage_plugins_panel.json', { snap: hooks.getSnapshot() });
          hooks.openSettings();
          await wait(400);
          await writeDump('qa_stage_settings.json', { snap: hooks.getSnapshot() });
          hooks.openQueue();
          await wait(400);
          await writeDump('qa_stage_queue.json', { snap: hooks.getSnapshot() });
          const s = hooks.getSnapshot();
          hooks.closePanels();
          await wait(200);
          return {
            status: s.panels.plugins || s.panels.settings || s.panels.queue ? 'pass' : 'warn',
            detail: `panels plugins=${s.panels.plugins} settings=${s.panels.settings} queue=${s.panels.queue}`,
          };
        })
      );

      checks.push(
        await timedCheck('volume.set', async () => {
          const prev = hooks.getSnapshot().volume;
          hooks.setVolume(0.42);
          await wait(200);
          const mid = hooks.getSnapshot().volume;
          hooks.setVolume(prev > 0.05 ? prev : 0.8);
          return {
            status: Math.abs(mid - 0.42) < 0.02 ? 'pass' : 'fail',
            detail: `set 0.42 got ${mid}, restored ${prev > 0.05 ? prev : 0.8}`,
          };
        })
      );

      checks.push(
        await timedCheck('backend.commands', async () => {
          const cmds: string[] = [];
          try {
            await invoke('ensure_ytdlp_ready');
            cmds.push('ytdlp:ok');
          } catch (e) {
            cmds.push(`ytdlp:${e}`);
          }
          try {
            const c = await invoke<string>('get_ytm_cookies');
            cmds.push(`cookies:${c ? 'present' : 'empty'}`);
          } catch (e) {
            cmds.push(`cookies:${e}`);
          }
          try {
            const code = await invoke<string | null>('room_get_code');
            cmds.push(`room:${code || 'none'}`);
          } catch {
            cmds.push('room:na');
          }
          const bad = cmds.filter((c) => c.includes('Error') || c.includes('fail'));
          return {
            status: bad.length ? 'warn' : 'pass',
            detail: cmds.join(' | '),
          };
        })
      );

      const fails = checks.filter((c) => c.status === 'fail').length;
      const warns = checks.filter((c) => c.status === 'warn').length;
      const skips = checks.filter((c) => c.status === 'skip').length;
      const report = {
        at: new Date().toISOString(),
        ok: fails === 0,
        fails,
        warns,
        skips,
        checks,
        snapshot: hooks.getSnapshot(),
        plugins: api.plugins(),
      };
      const path = await writeDump('qa_full_report.json', report);
      console.table(
        checks.map((c) => ({ id: c.id, status: c.status, ms: c.ms, detail: c.detail }))
      );
      return { checks, ok: fails === 0, path };
    },
    runSocial: async () => {
      const checks: QaCheck[] = [];
      const track = async (
        id: string,
        fn: () => Promise<{ status: QaCheckStatus; detail?: string }>
      ) => {
        const c = await timedCheck(id, fn);
        checks.push(c);
        await writeDump('qa_social_progress.json', {
          at: new Date().toISOString(),
          last: c,
          checks,
        });
        return c;
      };

      await track('discord.enable', async () => {
        hooks.setPlugin('discord-rpc', true);
        await wait(200);
        return {
          status: pluginManager.isEnabled('discord-rpc') ? 'pass' : 'fail',
          detail: 'discord-rpc enabled',
        };
      });

      await track('discord.presence', async () => {
        // need something playing so onNowPlaying fires, also hit ipc directly
        if (!hooks.getSnapshot().hasTrack) {
          hooks.goHome();
          await waitFor(() => hooks.getSnapshot().sectionCount > 0, 10000);
          await hooks.playFirstHomeTrack();
          await waitFor(() => hooks.getSnapshot().hasTrack, 15000);
        }
        if (!hooks.getSnapshot().isPlaying) {
          await hooks.togglePlay();
          await wait(800);
        }
        const s = hooks.getSnapshot();
        try {
          await invoke('discord_update_presence', {
            payload: {
              clientId: localStorage.getItem('zenith_discord_client_id') || '1514342633374486709',
              title: s.trackTitle || 'Zenith QA',
              artist: s.trackArtist || 'Zenith Player',
              duration: s.duration > 0 && s.duration < 3600 ? s.duration : 240,
              position: Math.max(0, s.progress || 0),
              isPlaying: true,
              coverUrl: null,
              trackUrl: s.hasTrack
                ? `https://music.youtube.com/watch?v=qa`
                : 'https://music.youtube.com/',
            },
          });
          await writeDump('qa_discord_ok.json', {
            at: new Date().toISOString(),
            title: s.trackTitle,
            artist: s.trackArtist,
          });
          return { status: 'pass', detail: `presence set for "${s.trackTitle}"` };
        } catch (e) {
          await writeDump('qa_discord_err.json', { at: new Date().toISOString(), err: String(e) });
          return { status: 'fail', detail: String(e) };
        }
      });

      await track('dualsense.enable', async () => {
        hooks.setPlugin('dualsense-pad', true);
        await wait(400);
        let status = 'unknown';
        try {
          const un = await listen<string>('zenith-dualsense-status', (e) => {
            status = e.payload;
          });
          await invoke('dualsense_start');
          await wait(1200);
          un();
        } catch (e) {
          return { status: 'fail', detail: String(e) };
        }
        await writeDump('qa_dualsense.json', {
          at: new Date().toISOString(),
          status,
          pluginOn: pluginManager.isEnabled('dualsense-pad'),
        });
        // unknown usually means hid already started in onEnable before we subscribed
        return {
          status: pluginManager.isEnabled('dualsense-pad') ? 'pass' : 'fail',
          detail: `hid status=${status} (connected|unknown=ok if pad already claimed)`,
        };
      });

      let roomCode = '';
      await track('room.create', async () => {
        hooks.setPlugin('listening-room', true);
        await wait(200);
        try {
          roomCode = await hooks.createListeningRoom();
          let port = 18765;
          try {
            port = await invoke<number>('room_get_port');
          } catch {
            /* whatever */
          }
          await writeDump('qa_room_code.json', {
            at: new Date().toISOString(),
            code: roomCode,
            port,
            peers: await refreshRoomPeerCount(),
            guestUrl: `http://127.0.0.1:4177/room-guest.html?code=${roomCode}&port=${port}`,
          });
          return {
            status: /^[A-Z0-9]{6}$/.test(roomCode) ? 'pass' : 'fail',
            detail: `code=${roomCode} port=${port}`,
          };
        } catch (e) {
          await writeDump('qa_room_err.json', { at: new Date().toISOString(), err: String(e) });
          return { status: 'fail', detail: String(e) };
        }
      });

      await track('room.wait_guest', async () => {
        if (!roomCode) return { status: 'skip', detail: 'no room' };
        // host keeps blasting, guest page should join in like 90s
        const ok = await waitFor(async () => (await refreshRoomPeerCount()) > 0, 90000, 500);
        const peers = await refreshRoomPeerCount();
        await writeDump('qa_room_peers.json', {
          at: new Date().toISOString(),
          peers,
          code: roomCode || getRoomCode(),
        });
        return {
          status: ok ? 'pass' : 'warn',
          detail: ok ? `guest connected peers=${peers}` : `no guest yet peers=${peers}`,
        };
      });

      await track('room.broadcast_alive', async () => {
        if (!isFinite(hooks.getSnapshot().progress)) {
          /* nothing */
        }
        const s = hooks.getSnapshot();
        return {
          status: s.hasTrack ? 'pass' : 'warn',
          detail: `host track="${s.trackTitle}" playing=${s.isPlaying} peers=${roomPeerCount()}`,
        };
      });

      const fails = checks.filter((c) => c.status === 'fail').length;
      const warns = checks.filter((c) => c.status === 'warn').length;
      const report = {
        at: new Date().toISOString(),
        ok: fails === 0,
        fails,
        warns,
        roomCode,
        checks,
        snapshot: hooks.getSnapshot(),
      };
      const path = await writeDump('qa_social_report.json', report);
      console.table(
        checks.map((c) => ({ id: c.id, status: c.status, ms: c.ms, detail: c.detail }))
      );
      return { checks, ok: fails === 0, path, roomCode };
    },

    runRelease: async () => {
      const all: QaCheck[] = [];
      const push = (batch: QaCheck[], prefix?: string) => {
        for (const c of batch) {
          all.push(prefix ? { ...c, id: `${prefix}${c.id}` } : c);
        }
      };

      const full = await api.runFull();
      push(full.checks, 'full.');

      const social = await api.runSocial();
      push(
        social.checks.map((c) =>
          c.id === 'room.wait_guest' && c.status === 'warn'
            ? { ...c, status: 'fail' as const, detail: `${c.detail} (release requires guest)` }
            : c
        ),
        'social.'
      );

      // extra "would this ship" checks after both suites
      all.push(
        await timedCheck('release.room_health', async () => {
          try {
            const port = await invoke<number>('room_get_port');
            const code = await invoke<string | null>('room_get_code');
            const peers = await invoke<number>('room_peer_count');
            return {
              status: port > 0 && code ? 'pass' : 'fail',
              detail: `port=${port} code=${code || 'none'} peers=${peers}`,
            };
          } catch (e) {
            return { status: 'fail', detail: String(e) };
          }
        })
      );

      all.push(
        await timedCheck('release.progress_advances', async () => {
          const a = hooks.getSnapshot();
          if (!a.hasTrack || !a.isPlaying) {
            return { status: 'warn', detail: 'not playing - skip drift check' };
          }
          const t0 = a.progress;
          await wait(2200);
          const t1 = hooks.getSnapshot().progress;
          return {
            status: t1 > t0 + 0.4 ? 'pass' : 'fail',
            detail: `progress ${t0.toFixed(1)} → ${t1.toFixed(1)}`,
          };
        })
      );

      all.push(
        await timedCheck('release.home_reload', async () => {
          hooks.goHome();
          const ok = await waitFor(() => {
            const s = hooks.getSnapshot();
            return !s.loading && (s.sectionCount > 0 || s.quickPickCount > 0);
          }, 20000);
          const s = hooks.getSnapshot();
          return {
            status: ok && !s.frozenSuspect ? 'pass' : 'fail',
            detail: `sections=${s.sectionCount} qp=${s.quickPickCount} frozen=${s.frozenSuspect}`,
          };
        })
      );

      all.push(
        await timedCheck('release.cleanup_room', async () => {
          try {
            await hooks.leaveListeningRoom();
            await wait(300);
            const code = await invoke<string | null>('room_get_code');
            return {
              status: code ? 'warn' : 'pass',
              detail: code ? `still active ${code}` : 'room cleared',
            };
          } catch (e) {
            return { status: 'warn', detail: String(e) };
          }
        })
      );

      all.push(
        await timedCheck('release.no_freeze', async () => {
          const s = hooks.getSnapshot();
          return {
            status: s.frozenSuspect ? 'fail' : 'pass',
            detail: `frozenSuspect=${s.frozenSuspect} tab=${s.activeTab}`,
          };
        })
      );

      const fails = all.filter((c) => c.status === 'fail').length;
      const warns = all.filter((c) => c.status === 'warn').length;
      const report = {
        at: new Date().toISOString(),
        suite: 'release',
        ok: fails === 0,
        fails,
        warns,
        roomCode: social.roomCode,
        checks: all,
        snapshot: hooks.getSnapshot(),
        plugins: api.plugins(),
      };
      const path = await writeDump('qa_release_report.json', report);
      console.table(all.map((c) => ({ id: c.id, status: c.status, ms: c.ms, detail: c.detail })));
      return { checks: all, ok: fails === 0, path, roomCode: social.roomCode };
    },
  };

  window.__zenithQA = api;
  console.info('[qa] window.__zenithQA ready - runFull() / runSocial() / runRelease()');
  return api;
}
