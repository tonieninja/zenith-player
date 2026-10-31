# Zenith resident resolver: one warm yt-dlp process answering requests over stdin, so a
# track does not pay for process start, imports and the player JS download every time.
# protocol: one JSON object per line in ({"id", "video", "format", "clients"}), one per
# line out, prefixed with "@@ZW " so stray output can't be mistaken for an answer
import json
import sys
import threading
import time

from yt_dlp.extractor.common import InfoExtractor

# resident node for the JS challenge solve. yt-dlp starts node for every video and feeds
# it the solver library + core + the player; here one sandboxed node (same --permission
# flag yt-dlp uses) keeps the solver loaded and only gets the per-video data
_NODE_SERVER = r"""
const vm = require('vm'); const rl = require('readline').createInterface({input: process.stdin});
const fns = new Map();
// compiled solvers per player: the solver core compiles the ~1 MB player code with
// Function() on every call, which is most of the solve time. same output shape as its main()
const solvers = new Map();
// raw player -> preprocessed player (the meriyah parse + rewrite, ~0.4 s each time),
// keyed by the player's hash so python only has to send the 3 MB player once
const prepared = new Map();
function solve(f, m) {
  const d = m.data;
  if (d.type === 'player' || m.ph) {
    // preprocessed player from the previous session (python keeps it on disk)
    if (m.pp && m.ph && !prepared.has(m.ph)) prepared.set(m.ph, m.pp);
    let pp = m.ph && prepared.get(m.ph);
    if (!pp) {
      if (!d.player) return {need_player: true};
      pp = f({type: 'player', player: d.player, requests: [], output_preprocessed: true}).preprocessed_player;
      if (prepared.size > 4) prepared.clear();
      if (m.ph) prepared.set(m.ph, pp);
      if (m.want_pp) globalThis.__newpp = pp;
    }
    const out = solveCached({type: 'preprocessed', preprocessed_player: pp, requests: d.requests});
    if (d.output_preprocessed) out.preprocessed_player = pp;
    return out;
  }
  if (d.type === 'preprocessed') return solveCached(d);
  return f(d);
}
function solveCached(input) {
  let s = solvers.get(input.preprocessed_player);
  if (!s) {
    s = {n: null, sig: null};
    Function('_result', input.preprocessed_player)(s);
    if (solvers.size > 4) solvers.clear();
    solvers.set(input.preprocessed_player, s);
  }
  const responses = input.requests.map((r) => {
    if (r.type !== 'n' && r.type !== 'sig') return {type: 'error', error: 'Unknown request type: ' + r.type};
    const fn = s[r.type];
    if (!fn) return {type: 'error', error: 'Failed to extract ' + r.type + ' function'};
    try {
      return {type: 'result', data: Object.fromEntries(r.challenges.map((c) => [c, fn(c)]))};
    } catch (e) {
      return {type: 'error', error: e instanceof Error ? e.message + '\n' + e.stack : String(e)};
    }
  });
  return {type: 'result', responses};
}
rl.on('line', (line) => {
  let out;
  try {
    const m = JSON.parse(line);
    let f = fns.get(m.h);
    if (!f) {
      if (!m.code) { out = {need: true}; }
      else { f = vm.runInThisContext(m.code + '\n;jsc'); fns.set(m.h, f); }
    }
    if (f) {
      globalThis.__newpp = undefined;
      out = {ok: solve(f, m)};
      if (globalThis.__newpp) out.pp = globalThis.__newpp;
    }
  } catch (e) { out = {err: String(e && e.stack || e)}; }
  process.stdout.write(JSON.stringify(out) + '\n');
});
"""
_MARK = 'console.log(JSON.stringify(jsc('


def _install_resident_node():
    try:
        import hashlib
        import subprocess as sp
        from yt_dlp.extractor.youtube.jsc._builtin.node import NodeJCP
    except Exception:
        return
    orig = NodeJCP._run_js_runtime
    state = {'proc': None, 'sent': set()}
    lock = threading.Lock()

    def start(path, permission_args):
        flags = 0x08000000 if sys.platform == 'win32' else 0
        return sp.Popen([path, *permission_args, '-e', _NODE_SERVER], stdin=sp.PIPE,
                        stdout=sp.PIPE, stderr=sp.DEVNULL, text=True, encoding='utf-8',
                        bufsize=1, creationflags=flags)

    def ask(proc, msg):
        proc.stdin.write(json.dumps(msg) + '\n')
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError('resident node exited')
        return json.loads(line)

    def run(self, stdin, /):
        i = stdin.rfind(_MARK)
        j = stdin.rfind(')));')
        if i < 0 or j < i:
            return orig(self, stdin)
        code = stdin[:i]
        data = json.loads(stdin[i + len(_MARK):j])
        h = hashlib.sha1(code.encode('utf-8', 'replace')).hexdigest()
        perm = (['--experimental-permission', '--no-warnings=ExperimentalWarning']
                if self.runtime_info.version_tuple < (23, 5, 0) else ['--permission'])
        with lock:
            try:
                p = state['proc']
                if p is None or p.poll() is not None:
                    p = state['proc'] = start(self.runtime_info.path, perm)
                    state['sent'] = set()
                player = data.get('player') if data.get('type') == 'player' else None
                ph = hashlib.sha1(player.encode('utf-8', 'replace')).hexdigest() if player else None
                msg = {'h': h, 'data': data, 'ph': ph}
                if ph and ph not in state['sent']:
                    # the preprocessed player is kept between sessions: the first
                    # track after a start skips the ~0.4 s parse + rewrite
                    try:
                        saved = self.ie.cache.load('zenith-jsc', 'pp-' + ph)
                    except Exception:
                        saved = None
                    if isinstance(saved, str) and saved:
                        msg['pp'] = saved
                        state['sent'].add(ph)
                    else:
                        msg['want_pp'] = True
                if ph and ph in state['sent']:
                    data = dict(data)
                    data.pop('player', None)
                    msg['data'] = data
                if h not in state['sent']:
                    msg['code'] = code
                r = ask(p, msg)
                if r.get('need'):
                    msg['code'] = code
                    r = ask(p, msg)
                if isinstance(r.get('ok'), dict) and r['ok'].get('need_player') and player:
                    msg['data'] = json.loads(stdin[i + len(_MARK):j])
                    r = ask(p, msg)
                state['sent'].add(h)
                if ph:
                    state['sent'].add(ph)
                    if isinstance(r.get('pp'), str):
                        try:
                            self.ie.cache.store('zenith-jsc', 'pp-' + ph, r['pp'])
                        except Exception:
                            pass
                if 'ok' in r:
                    return json.dumps(r['ok'])
            except Exception:
                try:
                    state['proc'] and state['proc'].kill()
                except Exception:
                    pass
                state['proc'] = None
        return orig(self, stdin)

    NodeJCP._run_js_runtime = run


_YTCFG_RESET = [False]


def _install_ytcfg_cache():
    # the music.youtube.com page yt-dlp reads the client config from (~0.5 s) is the same
    # for every track, a browser loads it once per session too. embed configs are per
    # video and stay uncached
    try:
        import copy
        from yt_dlp.extractor.youtube._base import YoutubeBaseInfoExtractor
    except Exception:
        return
    orig = YoutubeBaseInfoExtractor._download_ytcfg
    cache = {}

    def cached(self, client, video_id):
        if _YTCFG_RESET[0]:
            _YTCFG_RESET[0] = False
            cache.clear()
            try:
                self.cache.store('zenith-ytcfg', client, None)
            except Exception:
                pass
            return orig(self, client, video_id)
        if 'embedded' in client:
            return orig(self, client, video_id)
        hit = cache.get(client)
        if not hit:
            # last session's copy (up to 6 h old), so the first track after a start
            # doesn't wait for the page either
            try:
                saved = self.cache.load('zenith-ytcfg', client)
                if saved and time.time() - saved['at'] < 6 * 3600 and saved.get('cfg'):
                    hit = cache[client] = (saved['at'], saved['cfg'])
            except Exception:
                pass
        if hit and time.time() - hit[0] < 6 * 3600:
            return copy.deepcopy(hit[1])
        cfg = orig(self, client, video_id)
        if cfg:
            now = time.time()
            cache[client] = (now, copy.deepcopy(cfg))
            try:
                self.cache.store('zenith-ytcfg', client, {'at': now, 'cfg': cfg})
            except Exception:
                pass
        return cfg

    YoutubeBaseInfoExtractor._download_ytcfg = cached


class ZenithWorkerIE(InfoExtractor):
    IE_NAME = 'zenithworker'
    _VALID_URL = r'zenith-worker:serve'

    def _real_extract(self, url):
        ydl = self._downloader
        out = sys.__stdout__
        lock = threading.Lock()

        def send(obj):
            with lock:
                out.write('@@ZW ' + json.dumps(obj) + '\n')
                out.flush()

        _install_resident_node()
        _install_ytcfg_cache()
        send({'ready': True})
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception:
                continue
            t0 = time.time()
            rid = req.get('id')
            try:
                clients = [c for c in (req.get('clients') or '').split(',') if c]
                ea = dict(ydl.params.get('extractor_args') or {})
                yt = dict(ea.get('youtube') or {})
                if clients:
                    yt['player_client'] = clients
                for k, v in (req.get('ea') or {}).items():
                    yt[k] = v if isinstance(v, list) else [x for x in str(v).split(',') if x]
                ea['youtube'] = yt
                ydl.params['verbose'] = bool(req.get('verbose'))
                ydl.params['extractor_args'] = ea
                fmt = req.get('format') or 'bestaudio/best'
                ydl.params['format'] = fmt
                ydl.format_selector = ydl.build_format_selector(fmt)
                info = ydl.extract_info(
                    (req.get('host') or 'https://music.youtube.com') + '/watch?v=' + req['video'],
                    download=False, force_generic_extractor=False)
                fmts = info.get('requested_formats') or [info]
                f = fmts[0]
                send({'id': rid, 'url': f.get('url') or info.get('url'),
                      'headers': f.get('http_headers') or info.get('http_headers'),
                      'ms': int((time.time() - t0) * 1000)})
            except BaseException as e:  # noqa: B036 - keep serving after any failure
                if isinstance(e, KeyboardInterrupt):
                    raise
                _YTCFG_RESET[0] = True
                send({'id': rid, 'error': str(e)[:400], 'ms': int((time.time() - t0) * 1000)})
        sys.exit(0)
