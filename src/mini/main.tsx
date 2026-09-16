import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { emit } from '@tauri-apps/api/event';
import { imgErr, isYouTubeVideoId } from '../utils/imgError';
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

function MiniApp() {
  const [data, setData] = useState<MiniPlayerPayload | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<MiniPlayerPayload>('zenith-mini-state', (e) => setData(e.payload)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const act = (action: string) => emit('zenith-mini-action', action);

  if (!data?.title) {
    return (
      <div className="mini-root">
        <span className="mini-idle">Zenith Mini</span>
      </div>
    );
  }

  const pct = data.duration > 0 ? (data.progress / data.duration) * 100 : 0;

  return (
    <div className="mini-root">
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
        <button className="mini-btn" onClick={() => act('prev')} aria-label="Previous">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
          </svg>
        </button>
        <button className="mini-btn play" onClick={() => act('toggle-play')} aria-label="Play">
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
        <button className="mini-btn" onClick={() => act('next')} aria-label="Next">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 18h2V6h-2zm-11-7 8.5-6v12z" />
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
