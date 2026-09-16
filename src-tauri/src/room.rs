//! listening room, host pushes state over tauri ipc and rust fans it out on a websocket
//! guests (browser / second client) hit ws://127.0.0.1:{port}/ws?code=XXXXXX
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::OnceCell;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomState {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub cover_url: Option<String>,
    pub position: f64,
    pub is_playing: bool,
    pub host_id: String,
    #[serde(default)]
    pub sent_at: Option<u64>,
}

struct RoomInner {
    code: String,
    state: Option<RoomState>,
    clients: HashSet<u64>,
}

struct Hub {
    room: Mutex<Option<RoomInner>>,
    next_id: Mutex<u64>,
    /// outbound queue, client_id -> latest json, broadcast dumps it on everyone
    tx: tokio::sync::broadcast::Sender<String>,
}

lazy_static::lazy_static! {
    static ref HUB: Arc<Hub> = {
        let (tx, _) = tokio::sync::broadcast::channel(64);
        Arc::new(Hub {
            room: Mutex::new(None),
            next_id: Mutex::new(1),
            tx,
        })
    };
}

static WS_PORT: OnceCell<u16> = OnceCell::const_new();

fn gen_code() -> String {
    const ALPH: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = [0u8; 6];
    if getrandom::getrandom(&mut bytes).is_err() {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = ((seed >> (i * 8)) & 0xFF) as u8;
        }
    }
    bytes
        .iter()
        .map(|&b| ALPH[(b as usize) % ALPH.len()] as char)
        .collect()
}

async fn ensure_ws_server() -> Result<u16, String> {
    let port = *WS_PORT
        .get_or_try_init(|| async {
            let listener = match tokio::net::TcpListener::bind("127.0.0.1:18765").await {
                Ok(l) => l,
                Err(_) => tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|e| e.to_string())?,
            };

            let port = listener.local_addr().map_err(|e| e.to_string())?.port();

            let hub = HUB.clone();
            let app = Router::new()
                .route("/ws", get(ws_handler))
                .route("/health", get(|| async { "zenith-room-ok" }))
                .route(
                    "/peers",
                    get(|| async {
                        let n = HUB
                            .room
                            .lock()
                            .ok()
                            .and_then(|g| g.as_ref().map(|r| r.clients.len()))
                            .unwrap_or(0);
                        n.to_string()
                    }),
                )
                .with_state(hub);

            tokio::spawn(async move {
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("[Zenith] room ws error: {e}");
                }
            });

            println!("[Zenith] listening-room ws on 127.0.0.1:{port}");
            Ok::<u16, String>(port)
        })
        .await?;
    Ok(port)
}

#[derive(Deserialize)]
struct WsQuery {
    code: String,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(hub): State<Arc<Hub>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| client_loop(socket, q.code, hub))
}

async fn client_loop(socket: WebSocket, code: String, hub: Arc<Hub>) {
    let cleaned = code.trim().to_uppercase();
    let client_id = {
        let mut n = hub.next_id.lock().ok();
        let id = n
            .as_mut()
            .map(|x| {
                let v = **x;
                **x += 1;
                v
            })
            .unwrap_or(0);
        id
    };

    {
        let mut guard = match hub.room.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(room) = guard.as_mut() else {
            return;
        };
        if room.code != cleaned {
            return;
        }
        room.clients.insert(client_id);
    }

    let mut rx = hub.tx.subscribe();
    let (mut sink, mut stream) = socket.split();

    let snapshot = hub.room.lock().ok().and_then(|guard| {
        guard
            .as_ref()
            .and_then(|room| room.state.as_ref())
            .and_then(|state| serde_json::to_string(state).ok())
    });
    if let Some(json) = snapshot {
        let _ = sink.send(Message::Text(json.into())).await;
    }

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(json) => {
                        let still_in_room = hub
                            .room
                            .lock()
                            .ok()
                            .and_then(|guard| guard.as_ref().map(|room| room.code == cleaned))
                            .unwrap_or(false);
                        if !still_in_room {
                            break;
                        }
                        if sink.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(p))) => {
                        let _ = sink.send(Message::Pong(p)).await;
                    }
                    _ => {}
                }
            }
        }
    }

    if let Ok(mut guard) = hub.room.lock() {
        if let Some(room) = guard.as_mut() {
            room.clients.remove(&client_id);
        }
    }
}

#[tauri::command]
pub async fn room_create() -> Result<String, String> {
    let _port = ensure_ws_server().await?;
    let code = gen_code();
    {
        let mut guard = HUB.room.lock().map_err(|e| e.to_string())?;
        *guard = Some(RoomInner {
            code: code.clone(),
            state: None,
            clients: HashSet::new(),
        });
    }
    Ok(code)
}

#[tauri::command]
pub async fn room_get_port() -> Result<u16, String> {
    WS_PORT
        .get()
        .copied()
        .ok_or_else(|| "room server not started".into())
}

#[tauri::command]
pub fn room_join(code: String) -> Result<bool, String> {
    let guard = HUB.room.lock().map_err(|e| e.to_string())?;
    if let Some(room) = guard.as_ref() {
        return Ok(room.code == code.trim().to_uppercase());
    }
    Ok(false)
}

#[tauri::command]
pub fn room_leave() -> Result<(), String> {
    let mut guard = HUB.room.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn room_get_code() -> Result<Option<String>, String> {
    let guard = HUB.room.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().map(|r| r.code.clone()))
}

#[tauri::command]
pub fn room_peer_count() -> Result<usize, String> {
    let guard = HUB.room.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().map(|r| r.clients.len()).unwrap_or(0))
}

#[tauri::command]
pub fn room_broadcast(app: AppHandle, state: RoomState) -> Result<(), String> {
    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    {
        let mut guard = HUB.room.lock().map_err(|e| e.to_string())?;
        if let Some(room) = guard.as_mut() {
            room.state = Some(state.clone());
        } else {
            return Err("no active room".into());
        }
    }
    let _ = HUB.tx.send(json);
    let _ = app.emit("zenith-room-sync", &state);
    let _ = app.emit("zenith-room-peers", room_peer_count().unwrap_or(0));
    Ok(())
}
