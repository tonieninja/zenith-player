use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;
use zbus::blocking::connection;
use zbus::interface;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

const PATH: &str = "/org/mpris/MediaPlayer2";

#[derive(Clone, Default)]
struct State {
    title: String,
    artist: String,
    art: String,
    playing: bool,
    has_track: bool,
    position_us: i64,
    length_us: i64,
    track_no: u64,
}

struct Root {
    app: AppHandle,
}

#[interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    fn raise(&self) {
        crate::show_main_window(&self.app);
    }
    fn quit(&self) {}
    #[zbus(property)]
    fn can_quit(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn identity(&self) -> &str {
        "Zenith"
    }
    #[zbus(property)]
    fn desktop_entry(&self) -> &str {
        "Zenith"
    }
    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        vec![]
    }
    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        vec![]
    }
}

struct Player {
    app: AppHandle,
    st: State,
}

impl Player {
    fn act(&self, a: &str) {
        crate::tray_action(&self.app, a);
    }
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    fn next(&self) {
        self.act("next");
    }
    fn previous(&self) {
        self.act("prev");
    }
    fn play_pause(&self) {
        self.act("toggle-play");
    }
    fn play(&self) {
        if !self.st.playing {
            self.act("toggle-play");
        }
    }
    fn pause(&self) {
        if self.st.playing {
            self.act("toggle-play");
        }
    }
    fn stop(&self) {
        self.pause();
    }
    fn seek(&self, _offset: i64) {}
    fn set_position(&self, _track: ObjectPath<'_>, _pos: i64) {}

    #[zbus(property)]
    fn playback_status(&self) -> &str {
        match (self.st.has_track, self.st.playing) {
            (false, _) => "Stopped",
            (true, true) => "Playing",
            (true, false) => "Paused",
        }
    }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        let mut m = HashMap::new();
        if !self.st.has_track {
            return m;
        }
        let id = format!("/com/zenithplayer/track/{}", self.st.track_no);
        let mut put = |k: &str, v: Value<'_>| {
            if let Ok(o) = OwnedValue::try_from(v) {
                m.insert(k.to_string(), o);
            }
        };
        if let Ok(p) = ObjectPath::try_from(id.as_str()) {
            put("mpris:trackid", Value::from(p));
        }
        put("xesam:title", Value::from(self.st.title.as_str()));
        put("xesam:artist", Value::from(vec![self.st.artist.as_str()]));
        if !self.st.art.is_empty() {
            put("mpris:artUrl", Value::from(self.st.art.as_str()));
        }
        if self.st.length_us > 0 {
            put("mpris:length", Value::from(self.st.length_us));
        }
        m
    }
    #[zbus(property)]
    fn position(&self) -> i64 {
        self.st.position_us
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_play(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_pause(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
}

static CONN: OnceLock<Option<zbus::blocking::Connection>> = OnceLock::new();
static LAST: Mutex<Option<State>> = Mutex::new(None);

fn conn(app: &AppHandle) -> Option<&'static zbus::blocking::Connection> {
    CONN.get_or_init(|| {
        let r = connection::Builder::session()
            .and_then(|b| b.name("org.mpris.MediaPlayer2.zenith"))
            .and_then(|b| b.serve_at(PATH, Root { app: app.clone() }))
            .and_then(|b| {
                b.serve_at(
                    PATH,
                    Player {
                        app: app.clone(),
                        st: State::default(),
                    },
                )
            })
            .and_then(|b| b.build());
        match r {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[Zenith] mpris unavailable: {e}");
                None
            }
        }
    })
    .as_ref()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mpris_update(
    app: AppHandle,
    title: Option<String>,
    artist: Option<String>,
    art: Option<String>,
    playing: bool,
    position: f64,
    duration: f64,
) {
    std::thread::spawn(move || {
        let Some(c) = conn(&app) else { return };
        let Ok(iface) = c.object_server().interface::<_, Player>(PATH) else {
            return;
        };
        let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
        let prev = last.clone().unwrap_or_default();
        let mut st = State {
            has_track: title.is_some(),
            title: title.unwrap_or_default(),
            artist: artist.unwrap_or_default(),
            art: art.unwrap_or_default(),
            playing,
            position_us: (position.max(0.0) * 1e6) as i64,
            length_us: (duration.max(0.0) * 1e6) as i64,
            track_no: prev.track_no,
        };
        let meta_changed = st.title != prev.title
            || st.artist != prev.artist
            || st.art != prev.art
            || st.length_us != prev.length_us
            || st.has_track != prev.has_track;
        if st.title != prev.title || st.artist != prev.artist {
            st.track_no += 1;
        }
        let status_changed = st.playing != prev.playing || st.has_track != prev.has_track;
        iface.get_mut().st = st.clone();
        *last = Some(st);
        drop(last);
        let em = iface.signal_emitter();
        let p = iface.get();
        zbus::block_on(async {
            if meta_changed {
                let _ = p.metadata_changed(em).await;
            }
            if status_changed {
                let _ = p.playback_status_changed(em).await;
            }
        });
    });
}
