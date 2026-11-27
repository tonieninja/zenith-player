import { invoke } from '@tauri-apps/api/core';
import type { Track } from '../api/youtube';

let cur: { track: Track; at: number; t: number } | null = null;

export function playLogTick(id: string, t: number) {
  if (cur && cur.track.id === id && t > cur.t) cur.t = t;
}

/** Powtórka w trybie „jeden utwór” to nowe odtworzenie, choć id się nie zmienia. */
export function playLogRepeat() {
  const track = cur?.track;
  if (!track) return;
  playLogSwitch(null);
  playLogSwitch(track);
}

/** Zapisuje w bazie poprzedni utwór, gdy zaczyna się następny; Rust liczy z tego gust i pomijane. */
export function playLogSwitch(next: Track | null, duration?: number) {
  const prev = cur;
  if (prev && next && prev.track.id === next.id) return;
  cur = next ? { track: next, at: Date.now(), t: 0 } : null;
  if (!prev) return;
  // shortcut: najdalsza pozycja zamiast realnie przesłuchanych sekund, przewinięcie do końca liczy się jak całość
  void invoke('db_log_play', {
    play: {
      videoId: prev.track.id,
      title: prev.track.title,
      artist: prev.track.artist,
      album: prev.track.album ?? null,
      duration: prev.track.durationSec ?? duration ?? null,
      listened: prev.t,
      at: prev.at,
    },
  }).catch(() => undefined);
}
