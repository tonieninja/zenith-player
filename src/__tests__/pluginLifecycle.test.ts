import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  listens: new Map<string, number>(),
  roomJoinGate: null as Promise<void> | null,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'remote_start') return { running: true, port: 8765, clients: 0, pairedDevices: 0 };
    if (cmd === 'room_join') {
      await m.roomJoinGate;
      return true;
    }
    if (cmd === 'room_get_port') return 18765;
    if (cmd === 'discover_picks') return [];
    return null;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async (event: string) => {
    m.listens.set(event, (m.listens.get(event) ?? 0) + 1);
    let live = true;
    return () => {
      if (live) m.listens.set(event, m.listens.get(event)! - 1);
      live = false;
    };
  }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getByLabel: async () => null },
}));
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => {
    throw new Error('offline');
  }),
}));

import { ALL_PLUGINS, pluginManager, type ZenithPlugin } from '../plugins';
import { startDuckMonitor } from '../plugins/duckOnVoice';
import { getRoomCode, joinRoom } from '../plugins/listeningRoom';
import { registerRemotePusher, startRemote } from '../plugins/remoteControl';
import { sponsorBlockJump } from '../plugins/sponsorBlock';

// zasoby, które wtyczka może po sobie zostawić; każdy licznik po wyłączeniu ma wrócić do stanu sprzed włączenia
const live = {
  domListeners: new Set<string>(),
  mediaHandlers: new Set<string>(),
  audioContexts: 0,
  micTracks: 0,
  sockets: 0,
};

function snapshot() {
  return {
    timers: vi.getTimerCount(),
    domListeners: [...live.domListeners].sort(),
    tauriListens: [...m.listens].filter(([, n]) => n > 0).sort(),
    mediaHandlers: [...live.mediaHandlers].sort(),
    audioContexts: live.audioContexts,
    micTracks: live.micTracks,
    sockets: live.sockets,
  };
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeAll(() => {
  const ids = new WeakMap<object, number>();
  let next = 0;
  const key = (t: EventTarget, type: string, fn: unknown, opts: unknown) => {
    const capture =
      typeof opts === 'boolean' ? opts : Boolean((opts as AddEventListenerOptions)?.capture);
    const id = (o: object) => ids.get(o) ?? (ids.set(o, ++next), next);
    return `${t === window ? 'window' : t === document ? 'document' : id(t)}:${type}:${id(fn as object)}:${capture}`;
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn) live.domListeners.add(key(this, type, fn, opts));
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (fn) live.domListeners.delete(key(this, type, fn, opts));
    return remove.call(this, type, fn, opts);
  };

  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null,
      playbackState: 'none',
      setPositionState() {},
      setActionHandler(action: string, fn: unknown) {
        if (fn) live.mediaHandlers.add(action);
        else live.mediaHandlers.delete(action);
      },
    },
  });
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(public init: unknown) {}
    }
  );
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        live.audioContexts += 1;
      }
      createMediaStreamSource = () => ({ connect() {} });
      createAnalyser = () => ({ fftSize: 0, frequencyBinCount: 8, getByteFrequencyData() {} });
      close = async () => {
        live.audioContexts -= 1;
      };
    }
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        live.micTracks += 1;
        let on = true;
        const track = {
          stop() {
            if (on) live.micTracks -= 1;
            on = false;
          },
        };
        return { getTracks: () => [track] };
      },
    },
  });
  vi.stubGlobal(
    'WebSocket',
    class {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      private open = true;
      constructor() {
        live.sockets += 1;
        queueMicrotask(() => this.onopen?.());
      }
      close() {
        if (this.open) live.sockets -= 1;
        this.open = false;
      }
    }
  );
});

const info = (id: string, isPlaying = true) => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  duration: 200,
  position: 3,
  isPlaying,
  coverUrl: '',
  artistId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
});

// to, co App robi przy włączonej wtyczce przez jej własne funkcje
const appGlue: Record<string, () => unknown> = {
  'duck-on-voice': () =>
    startDuckMonitor(
      () => 1,
      () => {}
    ),
  'remote-control': async () => {
    registerRemotePusher(() => {});
    await startRemote(() => {});
  },
  'listening-room': () => joinRoom('ABC123'),
  sponsorblock: () => sponsorBlockJump('abcdefghijk', 5, 200),
};

async function drive(p: ZenithPlugin, n: number) {
  await appGlue[p.id]?.();
  pluginManager.notifyTrackChange(info(`track${n}`));
  pluginManager.notifyNowPlaying(info(`track${n}`));
  pluginManager.notifyPlayState(true);
  pluginManager.notifySeek(42);
  pluginManager.notifyPlayState(false);
  pluginManager.notifyPlayState(true);
  await flush();
  await vi.advanceTimersByTimeAsync(5_000);
  // opóźnione wysyłki też muszą zniknąć, gdy wyłączenie przyjdzie tuż po zdarzeniu
  pluginManager.notifySeek(10);
  pluginManager.notifyNowPlaying(info(`track${n}`, false));
  await flush();
}

// wtyczki „always” nie dają się wyłączyć z menedżera, więc ich cykl sprawdzamy na samych hakach
async function setOn(p: ZenithPlugin, on: boolean) {
  if (p.core === 'always') await (on ? p.onEnable?.() : p.onDisable?.());
  else pluginManager.setEnabled(p.id, on);
  await flush();
}

describe('plugin lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    pluginManager.reloadFromStorage();
    for (const p of ALL_PLUGINS) if (p.core !== 'always') pluginManager.setEnabled(p.id, false);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  for (const p of ALL_PLUGINS) {
    it(`${p.id}: disabling leaves nothing behind and re-enabling does not double up`, async () => {
      await setOn(p, false);
      const before = snapshot();
      await setOn(p, true);
      await drive(p, 1);
      const first = snapshot();
      await setOn(p, false);
      expect(snapshot(), 'after disable').toEqual(before);

      await setOn(p, true);
      await drive(p, 2);
      expect(snapshot(), 'after re-enable').toEqual(first);
      await setOn(p, false);
      expect(snapshot(), 'after second disable').toEqual(before);
    });

    it(`${p.id}: toggled off while turning on leaves nothing behind`, async () => {
      await setOn(p, false);
      const before = snapshot();
      if (p.core === 'always') {
        void p.onEnable?.();
        void p.onDisable?.();
      } else {
        pluginManager.setEnabled(p.id, true);
        pluginManager.setEnabled(p.id, false);
      }
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(snapshot()).toEqual(before);
    });
  }

  it('listening-room: turning it off mid-join leaves no socket and no guest role', async () => {
    pluginManager.setEnabled('listening-room', true);
    await flush();
    const before = snapshot();
    let open!: () => void;
    m.roomJoinGate = new Promise<void>((r) => (open = r));
    const joined = joinRoom('ABC123');
    await flush();
    pluginManager.setEnabled('listening-room', false);
    await flush();
    open();
    m.roomJoinGate = null;
    expect(await joined).toBe(false);
    await flush();
    expect(snapshot()).toEqual(before);
    expect(getRoomCode()).toBe('');
  });
});
