import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { emit, listen } from '@tauri-apps/api/event';
import { imgErr, isYouTubeVideoId } from '../utils/imgError';
import { AUX_STRINGS, closeThisWindow, startWindowDrag, useAuxLang } from '../utils/auxWindow';
import './mini.css';

export interface MiniPlayerPayload {
  title: string;
  artist: string;
  trackId?: string;
  coverUrl?: string;
  progress: number;
  duration: number;
  isPlaying: boolean;
}

function CloseButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="mini-close"
      onClick={() => void closeThisWindow()}
      aria-label={label}
      title={label}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

function MiniApp() {
  const lang = useAuxLang();
  const s = AUX_STRINGS[lang];
  const [data, setData] = useState<MiniPlayerPayload | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<MiniPlayerPayload>('zenith-mini-state', (e) => setData(e.payload)).then((fn) => {
      unlisten = fn;
      void emit('zenith-mini-ready').catch(() => {});
    });
    return () => unlisten?.();
  }, []);

  const act = (action: string) => emit('zenith-mini-action', action);

  if (!data?.title) {
    return (
      <div className="mini-root" onMouseDown={startWindowDrag} title={s.drag}>
        <span className="mini-idle">{s.miniIdle}</span>
        <CloseButton label={s.close} />
      </div>
    );
  }

  const pct =
    data.duration > 0 ? Math.max(0, Math.min(100, (data.progress / data.duration) * 100)) : 0;

  return (
    <div className="mini-root" onMouseDown={startWindowDrag}>
      <CloseButton label={s.close} />
      {data.coverUrl && (
        <img
          src={data.coverUrl}
          alt=""
          className="mini-cover"
          onError={imgErr}
          {...(isYouTubeVideoId(data.trackId) ? { 'data-video-id': data.trackId } : {})}
        />
      )}
      <div className="mini-info">
        <div className="mini-title">{data.title}</div>
        <div className="mini-artist">{data.artist}</div>
        <div className="mini-progress">
          <div className="mini-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="mini-controls">
        <button className="mini-btn" onClick={() => act('prev')} aria-label={s.prev} title={s.prev}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
          </svg>
        </button>
        <button
          className="mini-btn play"
          onClick={() => act('toggle-play')}
          aria-label={data.isPlaying ? s.pause : s.play}
          title={data.isPlaying ? s.pause : s.play}
        >
          {data.isPlaying ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button className="mini-btn" onClick={() => act('next')} aria-label={s.next} title={s.next}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MiniApp />
  </StrictMode>
);
