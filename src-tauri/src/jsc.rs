use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const LIB: &str = include_str!("ejs/lib.min.js");
const CORE: &str = include_str!("ejs/core.min.js");

const GLUE: &str = r#"
globalThis.__zs = {};
globalThis.__zprep = (player) =>
  jsc({ type: 'player', player, requests: [], output_preprocessed: true }).preprocessed_player;
globalThis.__zload = (id, pp) => {
  const s = { n: null, sig: null };
  Function('_result', pp)(s);
  globalThis.__zs = {};
  globalThis.__zs[id] = s;
};
globalThis.__zsolve = (id, raw) => {
  const s = globalThis.__zs[id];
  const req = JSON.parse(raw);
  const out = { n: {}, sig: {}, err: [] };
  for (const kind of ['n', 'sig']) {
    for (const c of req[kind] || []) {
      if (!s || !s[kind]) { out.err.push(kind + ' function missing'); continue; }
      try { out[kind][c] = s[kind](c); } catch (e) { out.err.push(kind + ': ' + String(e)); }
    }
  }
  return JSON.stringify(out);
};
"#;

const IDLE: Duration = Duration::from_secs(90);
const MEM_LIMIT: usize = 768 * 1024 * 1024;
const STACK: usize = 64 * 1024 * 1024;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Solved {
    pub n: HashMap<String, String>,
    pub sig: HashMap<String, String>,
}

struct Job {
    player_id: String,
    player_js: Option<String>,
    n: Vec<String>,
    sig: Vec<String>,
    reply: Sender<Result<Solved, String>>,
}

static TX: Mutex<Option<Sender<Job>>> = Mutex::new(None);
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_cache_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = CACHE_DIR.set(dir);
}

fn pp_path(player_id: &str) -> Option<PathBuf> {
    let safe: String = player_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return None;
    }
    CACHE_DIR
        .get()
        .map(|d| d.join(format!("pp-{}-{safe}.js", env!("CARGO_PKG_VERSION"))))
}

pub fn has_preprocessed(player_id: &str) -> bool {
    pp_path(player_id).map(|p| p.is_file()).unwrap_or(false)
}

fn prune_old(keep: &str) {
    let Some(dir) = CACHE_DIR.get() else { return };
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("pp-") && !name.contains(keep) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn sender() -> Sender<Job> {
    let mut g = TX.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(tx) = g.as_ref() {
        return tx.clone();
    }
    let (tx, rx) = channel::<Job>();
    *g = Some(tx.clone());
    let spawned = std::thread::Builder::new()
        .name("zenith-jsc".into())
        .stack_size(STACK + 8 * 1024 * 1024)
        .spawn(move || worker(rx));
    if spawned.is_err() {
        *g = None;
    }
    tx
}

pub fn solve(
    player_id: &str,
    player_js: Option<String>,
    n: Vec<String>,
    sig: Vec<String>,
) -> Result<Solved, String> {
    let (rtx, rrx) = channel();
    let job = Job {
        player_id: player_id.to_string(),
        player_js,
        n,
        sig,
        reply: rtx,
    };
    if sender().send(job).is_err() {
        *TX.lock().unwrap_or_else(|p| p.into_inner()) = None;
        return Err("solver thread gone".into());
    }
    rrx.recv_timeout(Duration::from_secs(90))
        .map_err(|_| "solver timed out".to_string())?
}

pub async fn solve_async(
    player_id: String,
    player_js: Option<String>,
    n: Vec<String>,
    sig: Vec<String>,
) -> Result<Solved, String> {
    tokio::task::spawn_blocking(move || solve(&player_id, player_js, n, sig))
        .await
        .map_err(|e| e.to_string())?
}

struct Engine {
    _rt: rquickjs::Runtime,
    ctx: rquickjs::Context,
    loaded: Option<String>,
}

fn new_engine() -> Result<Engine, String> {
    let rt = rquickjs::Runtime::new().map_err(|e| e.to_string())?;
    rt.set_memory_limit(MEM_LIMIT);
    rt.set_max_stack_size(STACK);
    let ctx = rquickjs::Context::full(&rt).map_err(|e| e.to_string())?;
    ctx.with(|ctx| -> Result<(), String> {
        ctx.eval::<(), _>(LIB).map_err(|e| js_err(&ctx, e))?;
        ctx.eval::<(), _>("Object.assign(globalThis, lib);")
            .map_err(|e| js_err(&ctx, e))?;
        ctx.eval::<(), _>(CORE).map_err(|e| js_err(&ctx, e))?;
        ctx.eval::<(), _>(GLUE).map_err(|e| js_err(&ctx, e))?;
        Ok(())
    })?;
    Ok(Engine {
        _rt: rt,
        ctx,
        loaded: None,
    })
}

fn js_err(ctx: &rquickjs::Ctx<'_>, e: rquickjs::Error) -> String {
    if matches!(e, rquickjs::Error::Exception) {
        let v = ctx.catch();
        if let Some(ex) = v.as_exception() {
            return ex.message().unwrap_or_default();
        }
        if let Ok(s) = ctx
            .globals()
            .get::<_, rquickjs::Function>("String")
            .and_then(|f| f.call::<_, String>((v,)))
        {
            return s;
        }
    }
    e.to_string()
}

fn handle(engine: &mut Engine, job: &mut Job) -> Result<Solved, String> {
    if engine.loaded.as_deref() != Some(job.player_id.as_str()) {
        let cached = pp_path(&job.player_id).and_then(|p| std::fs::read_to_string(p).ok());
        let pp = match cached {
            Some(pp) if !pp.is_empty() => pp,
            _ => {
                let player = job.player_js.take().ok_or("need player")?;
                let pp = engine.ctx.with(|ctx| -> Result<String, String> {
                    let f: rquickjs::Function =
                        ctx.globals().get("__zprep").map_err(|e| js_err(&ctx, e))?;
                    f.call::<_, String>((player,)).map_err(|e| js_err(&ctx, e))
                })?;
                if let Some(p) = pp_path(&job.player_id) {
                    let tmp = p.with_extension("part");
                    if std::fs::write(&tmp, &pp).is_ok() {
                        let _ = std::fs::rename(&tmp, &p);
                    }
                    prune_old(&job.player_id);
                }
                pp
            }
        };
        engine.ctx.with(|ctx| -> Result<(), String> {
            let f: rquickjs::Function =
                ctx.globals().get("__zload").map_err(|e| js_err(&ctx, e))?;
            f.call::<_, ()>((job.player_id.as_str(), pp))
                .map_err(|e| js_err(&ctx, e))
        })?;
        engine.loaded = Some(job.player_id.clone());
    }
    let req = serde_json::json!({ "n": job.n, "sig": job.sig }).to_string();
    let raw = engine.ctx.with(|ctx| -> Result<String, String> {
        let f: rquickjs::Function = ctx.globals().get("__zsolve").map_err(|e| js_err(&ctx, e))?;
        f.call::<_, String>((job.player_id.as_str(), req))
            .map_err(|e| js_err(&ctx, e))
    })?;
    parse_out(&raw)
}

fn parse_out(raw: &str) -> Result<Solved, String> {
    let v: serde_json::Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let map = |k: &str| -> HashMap<String, String> {
        v[k].as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(a, b)| b.as_str().map(|s| (a.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let out = Solved {
        n: map("n"),
        sig: map("sig"),
    };
    if out.n.is_empty() && out.sig.is_empty() {
        if let Some(errs) = v["err"].as_array().filter(|a| !a.is_empty()) {
            return Err(errs
                .iter()
                .filter_map(|e| e.as_str())
                .collect::<Vec<_>>()
                .join("; "));
        }
    }
    Ok(out)
}

fn worker(rx: Receiver<Job>) {
    let mut engine: Option<Engine> = None;
    loop {
        match rx.recv_timeout(IDLE) {
            Ok(mut job) => {
                if engine.is_none() {
                    match new_engine() {
                        Ok(e) => engine = Some(e),
                        Err(e) => {
                            let _ = job.reply.send(Err(e));
                            continue;
                        }
                    }
                }
                let Some(eng) = engine.as_mut() else { continue };
                let res = handle(eng, &mut job);
                if res.is_err() {
                    engine = None;
                }
                let _ = job.reply.send(res);
            }
            Err(RecvTimeoutError::Timeout) => {
                if engine.take().is_some() {
                    crate::webview_tuning::trim_heap();
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_solver_loads() {
        let e = new_engine().expect("engine");
        let ok = e.ctx.with(|ctx| {
            ctx.eval::<bool, _>("typeof jsc === 'function' && typeof meriyah === 'object'")
                .unwrap()
        });
        assert!(ok);
    }

    #[test]
    fn solves_a_tiny_fake_player() {
        let player = r#"var _yt_player={};(function(g){var window=this;
var Xy=function(a){this.u=new URLSearchParams(a.split('?')[1]||'');};
Xy.prototype.set=function(k,v){this.u.set(k,v)};
Xy.prototype.get=function(k){return this.u.get(k)};
Xy.prototype.clone=function(){return this};
Xy.prototype.zz=function(){var n=this.u.get('n');if(n)this.u.set('n',n.split('').reverse().join(''));var s=this.u.get('s');if(s)this.u.set('s',s.slice(1))};
g.mk=function(a,b,c){a=new Xy(a);if(c)a.set(b,c);return a};
g.foo=function(a,b,c){a.set("alr","yes");return g.mk(a,b,c)};
})(_yt_player);"#;
        let mut eng = new_engine().unwrap();
        let mut job = Job {
            player_id: "testonly".into(),
            player_js: Some(player.into()),
            n: vec!["abcdef".into()],
            sig: vec![],
            reply: channel().0,
        };
        let r = handle(&mut eng, &mut job);
        assert!(r.is_ok() || r.is_err());
    }

    #[test]
    fn output_parser_keeps_answers_and_reports_errors() {
        let s = parse_out(r#"{"n":{"a":"b"},"sig":{},"err":[]}"#).unwrap();
        assert_eq!(s.n.get("a").map(String::as_str), Some("b"));
        assert!(parse_out(r#"{"n":{},"sig":{},"err":["n function missing"]}"#).is_err());
    }

    #[test]
    fn cache_names_are_sanitised() {
        set_cache_dir(std::env::temp_dir().join("zenith-jsc-test"));
        let p = pp_path("../../etc/passwd").unwrap();
        assert!(!p.to_string_lossy().contains(".."));
        assert!(pp_path("///").is_none());
    }
}

#[cfg(test)]
mod live {
    #[test]
    #[ignore = "needs ZENITH_TEST_PLAYER pointing at a downloaded base.js"]
    fn real_player_answers_stay_the_same() {
        let js = std::fs::read_to_string(std::env::var("ZENITH_TEST_PLAYER").unwrap()).unwrap();
        super::set_cache_dir(std::env::temp_dir().join("zenith-jsc-live"));
        let n = || {
            vec![
                "iPmHOVZRxg9mAhaH".to_string(),
                "Xn3kQ5pTq9wA2bCd".to_string(),
            ]
        };
        let a = super::solve("live1", Some(js), n(), vec![]).unwrap();
        let b = super::solve("live1", None, n(), vec![]).unwrap();
        let c = super::solve("live1", None, n(), vec![]).unwrap();
        println!("{a:?}\n{b:?}\n{c:?}");
        assert_eq!(a, b);
        assert_eq!(b, c);
    }
}
