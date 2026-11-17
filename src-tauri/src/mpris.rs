use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use tauri::AppHandle;
use zbus::blocking::connection;
use zbus::interface;
use zbus::object_server::SignalEmitter;
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
    at: Option<Instant>,
    volume: f64,
    rate: f64,
    loop_mode: String,
    shuffle: bool,
}

impl State {
    // panel i ekran blokady czytają Position w dowolnej chwili, a aplikacja wysyła ją tylko przy zmianach
    fn position_at(&self, now: Instant) -> i64 {
        let mut p = self.position_us;
        if let (true, Some(at)) = (self.playing, self.at) {
            p += (now.saturating_duration_since(at).as_secs_f64() * self.rate() * 1e6) as i64;
        }
        if self.length_us > 0 {
            p.min(self.length_us)
        } else {
            p
        }
    }
    fn rate(&self) -> f64 {
        if self.rate > 0.0 {
            self.rate
        } else {
            1.0
        }
    }
    fn track_id(&self) -> String {
        format!("/com/zenithplayer/track/{}", self.track_no)
    }
    // specyfikacja MPRIS: skok za koniec utworu działa jak Next
    fn seek_action(&self, target_us: i64) -> String {
        if self.length_us > 0 && target_us > self.length_us {
            "next".into()
        } else {
            format!("seek:{}", target_us.max(0) as f64 / 1e6)
        }
    }
}

fn loop_status(mode: &str) -> &'static str {
    match mode {
        "one" => "Track",
        "all" => "Playlist",
        _ => "None",
    }
}

fn loop_mode(status: &str) -> Option<&'static str> {
    match status {
        "None" => Some("off"),
        "Track" => Some("one"),
        "Playlist" => Some("all"),
        _ => None,
    }
}

// skok w aplikacji klient widzi tylko przez Seeked; 1,5 s zapasu pokrywa opóźnienie między pozycją a zegarem
fn seeked(prev: &State, st: &State, now: Instant) -> Option<i64> {
    let same = prev.has_track && st.has_track && prev.track_no == st.track_no;
    (same && (st.position_us - prev.position_at(now)).abs() > 1_500_000).then_some(st.position_us)
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
    // bez utworu (także po wyłączeniu Media Session) klawisze mediów nie mogą niczego uruchomić
    fn act(&self, a: &str) {
        if self.st.has_track {
            crate::tray_action(&self.app, a);
        }
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
    fn seek(&self, offset: i64) {
        let target = self.st.position_at(Instant::now()).saturating_add(offset);
        self.act(&self.st.seek_action(target));
    }
    fn set_position(&self, track: ObjectPath<'_>, pos: i64) {
        // stare trackid albo pozycja poza utworem: specyfikacja każe zignorować
        let valid = (0..=self.st.length_us).contains(&pos) || (self.st.length_us == 0 && pos >= 0);
        if track.as_str() == self.st.track_id() && valid {
            self.act(&self.st.seek_action(pos));
        }
    }

    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;

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
        let id = self.st.track_id();
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
    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        self.st.position_at(Instant::now())
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        self.st.rate()
    }
    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        self.st.rate().min(1.0)
    }
    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        self.st.rate().max(1.0)
    }
    #[zbus(property)]
    fn volume(&self) -> f64 {
        self.st.volume
    }
    #[zbus(property)]
    fn set_volume(&mut self, v: f64) {
        if v.is_finite() {
            self.st.volume = v.clamp(0.0, 1.0);
            crate::tray_action(&self.app, &format!("volume:{}", self.st.volume));
        }
    }
    #[zbus(property)]
    fn loop_status(&self) -> &str {
        loop_status(&self.st.loop_mode)
    }
    #[zbus(property)]
    fn set_loop_status(&mut self, s: String) {
        if let Some(m) = loop_mode(&s) {
            self.st.loop_mode = m.into();
            crate::tray_action(&self.app, &format!("loop:{m}"));
        }
    }
    #[zbus(property)]
    fn shuffle(&self) -> bool {
        self.st.shuffle
    }
    // aplikacja zna tylko przełącznik, a stan zmienia jej echo, bo bez okna przełącznik nic nie robi
    #[zbus(property)]
    fn set_shuffle(&mut self, on: bool) {
        if on != self.st.shuffle {
            crate::tray_action(&self.app, "toggle-shuffle");
        }
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
        true
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
    volume: Option<f64>,
    rate: Option<f64>,
    loop_mode: Option<String>,
    shuffle: Option<bool>,
) {
    std::thread::spawn(move || {
        let Some(c) = conn(&app) else { return };
        let Ok(iface) = c.object_server().interface::<_, Player>(PATH) else {
            return;
        };
        let now = Instant::now();
        let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
        let prev = last.clone().unwrap_or_default();
        // brak pola = nadawca go nie zna (np. zasobnik bez tempa), więc zostaje poprzednia wartość
        let mut st = State {
            has_track: title.is_some(),
            title: title.unwrap_or_default(),
            artist: artist.unwrap_or_default(),
            art: art.unwrap_or_default(),
            playing,
            position_us: (position.max(0.0) * 1e6) as i64,
            length_us: (duration.max(0.0) * 1e6) as i64,
            track_no: prev.track_no,
            at: Some(now),
            volume: volume
                .filter(|v| v.is_finite())
                .map_or(prev.volume, |v| v.clamp(0.0, 1.0)),
            rate: rate.filter(|r| *r > 0.0).unwrap_or(prev.rate),
            loop_mode: loop_mode.unwrap_or_else(|| prev.loop_mode.clone()),
            shuffle: shuffle.unwrap_or(prev.shuffle),
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
        let jumped = seeked(&prev, &st, now);
        iface.get_mut().st = st.clone();
        *last = Some(st.clone());
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
            if st.volume != prev.volume {
                let _ = p.volume_changed(em).await;
            }
            if st.rate() != prev.rate() {
                let _ = p.rate_changed(em).await;
                let _ = p.minimum_rate_changed(em).await;
                let _ = p.maximum_rate_changed(em).await;
            }
            if st.loop_mode != prev.loop_mode {
                let _ = p.loop_status_changed(em).await;
            }
            if st.shuffle != prev.shuffle {
                let _ = p.shuffle_changed(em).await;
            }
            if let Some(pos) = jumped {
                let _ = Player::seeked(em, pos).await;
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn playing_at(pos_s: i64, len_s: i64, rate: f64, at: Instant) -> State {
        State {
            has_track: true,
            playing: true,
            position_us: pos_s * 1_000_000,
            length_us: len_s * 1_000_000,
            rate,
            at: Some(at),
            track_no: 1,
            ..State::default()
        }
    }

    #[test]
    fn position_runs_with_clock_and_rate() {
        let t0 = Instant::now();
        let st = playing_at(10, 200, 1.5, t0);
        assert_eq!(st.position_at(t0 + Duration::from_secs(4)), 16_000_000);
        assert_eq!(st.position_at(t0 + Duration::from_secs(500)), 200_000_000);
        let paused = State {
            playing: false,
            ..st.clone()
        };
        assert_eq!(paused.position_at(t0 + Duration::from_secs(4)), 10_000_000);
        let no_rate = State { rate: 0.0, ..st };
        assert_eq!(no_rate.position_at(t0 + Duration::from_secs(2)), 12_000_000);
    }

    #[test]
    fn seeked_only_on_jump_within_same_track() {
        let t0 = Instant::now();
        let prev = playing_at(10, 200, 1.0, t0);
        let now = t0 + Duration::from_secs(5);
        assert_eq!(seeked(&prev, &playing_at(15, 200, 1.0, now), now), None);
        assert_eq!(
            seeked(&prev, &playing_at(90, 200, 1.0, now), now),
            Some(90_000_000)
        );
        let next = State {
            track_no: 2,
            ..playing_at(0, 180, 1.0, now)
        };
        assert_eq!(seeked(&prev, &next, now), None);
    }

    #[test]
    fn seek_past_end_goes_next() {
        let st = playing_at(10, 200, 1.0, Instant::now());
        assert_eq!(st.seek_action(201_000_000), "next");
        assert_eq!(st.seek_action(-5), "seek:0");
        assert_eq!(st.seek_action(42_500_000), "seek:42.5");
    }

    #[test]
    fn loop_modes_round_trip() {
        for (mode, status) in [("off", "None"), ("one", "Track"), ("all", "Playlist")] {
            assert_eq!(loop_status(mode), status);
            assert_eq!(loop_mode(status), Some(mode));
        }
        assert_eq!(loop_mode("Bogus"), None);
    }
}
