// Skróty globalne na natywnym Waylandzie przez portal XDG GlobalShortcuts (KDE Plasma 6, GNOME 48+).
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
use zbus::blocking::{Connection, MessageIterator};
use zbus::message::Type;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{MatchRule, Message};

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

const DEST: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";

static STARTED: AtomicBool = AtomicBool::new(false);
// wyłączenie i włączenie w trakcie okna zgody startuje drugi run; pierwszy po odpowiedzi musi zamknąć swoją sesję
static GEN: AtomicU32 = AtomicU32::new(0);
static BOUND: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static SESSION: Mutex<Option<(Connection, String)>> = Mutex::new(None);

fn close_session(conn: &Connection, session: &str) {
    let _ = conn.call_method(
        Some(DEST),
        session,
        Some("org.freedesktop.portal.Session"),
        "Close",
        &(),
    );
}

// wyłączenie w ustawieniach ma oddać kombinacje systemowi; ponowne włączenie tworzy sesję z tymi samymi id bez pytania
// stary wątek run śpi dalej na iteratorze sygnałów (jeden na przełączenie); starcza przy rzadkim klikaniu
pub fn close() {
    let s = SESSION.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((conn, session)) = s {
        std::thread::spawn(move || close_session(&conn, &session));
    }
    BOUND.lock().unwrap_or_else(|e| e.into_inner()).clear();
    GEN.fetch_add(1, Ordering::SeqCst);
    STARTED.store(false, Ordering::SeqCst);
}

// portal wiąże skróty raz na sesję, więc późniejsza zmiana w aplikacji otwiera systemowe ustawienia skrótów
pub fn sync(app: &tauri::AppHandle, bindings: Vec<(String, String)>) {
    if !STARTED.swap(true, Ordering::SeqCst) {
        *BOUND.lock().unwrap_or_else(|e| e.into_inner()) = bindings.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = run(&app, &bindings) {
                eprintln!("[zenith] global shortcuts portal unavailable: {e}");
            }
        });
        return;
    }
    {
        let mut bound = BOUND.lock().unwrap_or_else(|e| e.into_inner());
        if *bound == bindings {
            return;
        }
        *bound = bindings;
    }
    std::thread::spawn(|| {
        let Some((conn, session)) = SESSION.lock().unwrap_or_else(|e| e.into_inner()).clone()
        else {
            return;
        };
        if let Ok(path) = ObjectPath::try_from(session.as_str()) {
            let opts = HashMap::<&str, Value>::new();
            let body = (path, "", opts);
            let _ = conn.call_method(Some(DEST), PATH, Some(IFACE), "ConfigureShortcuts", &body);
        }
    });
}

// wynik przychodzi sygnałem Response na ścieżce znanej z góry, więc nasłuch musi ruszyć przed wywołaniem
fn request(
    conn: &Connection,
    token: &str,
    call: impl FnOnce() -> zbus::Result<Message>,
) -> Res<HashMap<String, OwnedValue>> {
    let sender = conn.unique_name().ok_or("no unique name")?;
    let sender = sender.as_str().trim_start_matches(':').replace('.', "_");
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface("org.freedesktop.portal.Request")?
        .member("Response")?
        .path(format!("{PATH}/request/{sender}/{token}"))?
        .build();
    let mut responses = MessageIterator::for_match_rule(rule, conn, Some(4))?;
    call()?;
    let msg = responses.next().ok_or("no portal response")??;
    let (code, res): (u32, HashMap<String, OwnedValue>) = msg.body().deserialize()?;
    if code != 0 {
        return Err(format!("portal response {code}").into());
    }
    Ok(res)
}

fn run(app: &tauri::AppHandle, bindings: &[(String, String)]) -> Res<()> {
    let gen = GEN.load(Ordering::SeqCst);
    let conn = Connection::session()?;
    // portal 1.21+ odrzuca sesję bez app id; Zenith to nazwa Zenith.desktop z rpm i deb (AppImage go nie ma)
    let _ = conn.call_method(
        Some(DEST),
        PATH,
        Some("org.freedesktop.host.portal.Registry"),
        "Register",
        &("Zenith", HashMap::<&str, Value>::new()),
    );
    let opts = HashMap::from([
        ("handle_token", Value::from("zenith_s")),
        ("session_handle_token", Value::from("zenith")),
    ]);
    let res = request(&conn, "zenith_s", || {
        conn.call_method(Some(DEST), PATH, Some(IFACE), "CreateSession", &(opts,))
    })?;
    // specyfikacja podaje uchwyt jako 's', część implementacji zwraca 'o'
    let session = match res.get("session_handle").map(|v| &**v) {
        Some(Value::Str(s)) => s.to_string(),
        Some(Value::ObjectPath(p)) => p.to_string(),
        _ => return Err("no session handle".into()),
    };
    let path = ObjectPath::try_from(session.as_str())?;
    // puste pola KDE pokazuje w oknie zgody jako „(Brak)”, więc portal dostaje tylko ustawione kombinacje
    let shortcuts: Vec<(&str, HashMap<&str, Value>)> = bindings
        .iter()
        .filter(|(_, acc)| !acc.trim().is_empty())
        .map(|(id, acc)| {
            let mut o = HashMap::from([("description", Value::from(label(id)))]);
            if let Some(t) = crate::parse_accelerator(acc).and_then(|s| xdg_trigger(&s)) {
                o.insert("preferred_trigger", Value::from(t));
            }
            (id.as_str(), o)
        })
        .collect();
    let activated = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(IFACE)?
        .member("Activated")?
        .build();
    let events = MessageIterator::for_match_rule(activated, &conn, Some(16))?;
    let opts = HashMap::from([("handle_token", Value::from("zenith_b"))]);
    request(&conn, "zenith_b", || {
        let body = (&path, &shortcuts, "", opts);
        conn.call_method(Some(DEST), PATH, Some(IFACE), "BindShortcuts", &body)
    })?;
    // użytkownik mógł wyłączyć skróty, zanim portal odpowiedział
    if !crate::GLOBAL_HOTKEYS_ON.load(Ordering::SeqCst) || GEN.load(Ordering::SeqCst) != gen {
        close_session(&conn, &session);
        return Ok(());
    }
    *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = Some((conn.clone(), session.clone()));
    for msg in events.flatten() {
        let body = msg.body();
        let Ok((from, id, _, _)) =
            body.deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>()
        else {
            continue;
        };
        let current = SESSION
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|(_, s)| s == from.as_str());
        if current && crate::GLOBAL_HOTKEYS_ON.load(Ordering::SeqCst) {
            crate::tray_action(app, &id);
        }
    }
    Ok(())
}

fn label(id: &str) -> &'static str {
    match id {
        "toggle-play" => "Play / Pause",
        "next" => "Next track",
        "prev" => "Previous track",
        "volume-up" => "Volume up",
        "volume-down" => "Volume down",
        _ => "Like current track",
    }
}

// format specyfikacji XDG shortcuts: CTRL/ALT/SHIFT/LOGO i nazwa keysym xkb; nieznany klawisz wybiera użytkownik
fn xdg_trigger(sc: &Shortcut) -> Option<String> {
    let code = sc.key.to_string();
    let key = if let Some(k) = code.strip_prefix("Key") {
        k.to_ascii_lowercase()
    } else if let Some(k) = code
        .strip_prefix("Digit")
        .or_else(|| code.strip_prefix("Arrow"))
    {
        k.to_string()
    } else if code.len() > 1 && code.starts_with('F') && code[1..].parse::<u8>().is_ok() {
        code.clone()
    } else {
        match code.as_str() {
            "Space" => "space",
            "Comma" => "comma",
            "Period" => "period",
            "Slash" => "slash",
            "Backslash" => "backslash",
            "Minus" => "minus",
            "Equal" => "equal",
            "Semicolon" => "semicolon",
            "Quote" => "apostrophe",
            "Backquote" => "grave",
            "BracketLeft" => "bracketleft",
            "BracketRight" => "bracketright",
            "Enter" => "Return",
            "Tab" => "Tab",
            "Backspace" => "BackSpace",
            "Insert" => "Insert",
            "Delete" => "Delete",
            "Home" => "Home",
            "End" => "End",
            "PageUp" => "Prior",
            "PageDown" => "Next",
            _ => return None,
        }
        .to_string()
    };
    let mut parts: Vec<String> = [
        (Modifiers::CONTROL, "CTRL"),
        (Modifiers::ALT, "ALT"),
        (Modifiers::SHIFT, "SHIFT"),
        (Modifiers::SUPER, "LOGO"),
    ]
    .into_iter()
    .filter(|(m, _)| sc.mods.contains(*m))
    .map(|(_, n)| n.to_string())
    .collect();
    parts.push(key);
    Some(parts.join("+"))
}

#[cfg(test)]
mod tests {
    use super::xdg_trigger;

    fn t(acc: &str) -> Option<String> {
        crate::parse_accelerator(acc).and_then(|s| xdg_trigger(&s))
    }

    #[test]
    fn accelerators_map_to_xdg_triggers() {
        assert_eq!(t("Ctrl+Alt+Space").as_deref(), Some("CTRL+ALT+space"));
        assert_eq!(t("Ctrl+Alt+ArrowRight").as_deref(), Some("CTRL+ALT+Right"));
        assert_eq!(t("Super+Shift+KeyL").as_deref(), Some("SHIFT+LOGO+l"));
        assert_eq!(t("Alt+Digit5").as_deref(), Some("ALT+5"));
        assert_eq!(t("Ctrl+F7").as_deref(), Some("CTRL+F7"));
        assert_eq!(t("Ctrl+PageDown").as_deref(), Some("CTRL+Next"));
    }
}
