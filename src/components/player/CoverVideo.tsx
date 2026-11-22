import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PlayerAudio } from '../../audio/engine';
import { proxiedId, videoStep } from '../../audio/videoSync';

type Props = {
  audio: PlayerAudio | null;
  trackId: string;
  buffering: boolean;
  onShown: (shown: boolean) => void;
};

const AUDIO_EVENTS = ['timeupdate', 'play', 'pause', 'waiting', 'canplay', 'ended'];

let avcOk: boolean | null = null;
// WebKitGTK bez gst-libav nie zdekoduje H.264, wtedy Rust wybiera vp9
const canAvc = () =>
  (avcOk ??= document.createElement('video').canPlayType('video/mp4; codecs="avc1.4d401f"') !== '');

// wyciszony obraz teledysku nad okładką; dźwięk zostaje w silniku audio, a obraz tylko goni jego zegar
export function CoverVideo({ audio, trackId, buffering, onShown }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [url, setUrl] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [shown, setShown] = useState(false);
  const bufferingRef = useRef(buffering);
  bufferingRef.current = buffering;

  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // pyta o obraz dopiero, gdy dźwięk tego utworu już gra, żeby nie konkurować z jego rozwiązywaniem
  useEffect(() => {
    if (!audio || off || url || hidden) return;
    let dead = false;
    let asked = false;
    // tuż po zmianie utworu src wskazuje jeszcze poprzedni, więc inne id tu tylko wstrzymuje, a nie wyłącza
    const check = () => {
      if (asked || proxiedId(audio.src) !== trackId || audio.paused) return;
      asked = true;
      invoke<string | null>('zvideo_stream', { videoId: trackId, maxHeight: 720, avc: canAvc() })
        .then((u) => !dead && (u ? setUrl(u) : setOff(true)))
        .catch(() => !dead && setOff(true));
    };
    check();
    AUDIO_EVENTS.forEach((e) => audio.addEventListener(e, check));
    return () => {
      dead = true;
      AUDIO_EVENTS.forEach((e) => audio.removeEventListener(e, check));
    };
  }, [audio, trackId, off, url, hidden]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !audio || !url || hidden || off) return;
    const tick = () => {
      if (proxiedId(audio.src) !== trackId) return setOff(true);
      const clock = {
        t: audio.currentTime,
        paused: audio.paused,
        buffering: bufferingRef.current,
        rate: audio.playbackRate,
      };
      const s = videoStep(clock, v.currentTime);
      if (v.playbackRate !== s.rate) v.playbackRate = s.rate;
      if (s.seekTo !== null && !v.seeking) v.currentTime = s.seekTo;
      if (s.play && v.paused) v.play().catch(() => {});
      else if (!s.play && !v.paused) v.pause();
    };
    const onPlaying = () => setShown(true);
    const onError = () => setOff(true);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('error', onError);
    v.muted = true;
    v.src = url;
    AUDIO_EVENTS.forEach((e) => audio.addEventListener(e, tick));
    const timer = window.setInterval(tick, 250);
    tick();
    return () => {
      window.clearInterval(timer);
      AUDIO_EVENTS.forEach((e) => audio.removeEventListener(e, tick));
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('error', onError);
      // bez load() WebView2 trzyma dekoder sprzętowy i połączenie z proxy do końca życia elementu
      v.pause();
      v.removeAttribute('src');
      v.load();
      setShown(false);
    };
  }, [audio, trackId, url, hidden, off]);

  useEffect(() => {
    onShown(shown);
  }, [shown, onShown]);
  useEffect(() => () => onShown(false), [onShown]);

  if (hidden || off || !url) return null;
  return (
    <video
      ref={ref}
      className={`player-view-cover-video${shown ? ' is-shown' : ''}`}
      muted
      playsInline
      disablePictureInPicture
      disableRemotePlayback
      preload="auto"
      aria-hidden="true"
    />
  );
}
