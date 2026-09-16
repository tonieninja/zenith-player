import { Trash2, X } from 'lucide-react';
import type { Track } from '../../api/youtube';
import { coverAttrs } from '../../utils/imgError';

type QueueDrawerProps = {
  open: boolean;
  queue: Track[];
  queueIndex: number;
  t: Record<string, string>;
  onClose: () => void;
  onSelectTrack: (index: number, track: Track) => void;
  onRemoveTrack?: (index: number) => void;
  onClearQueue?: () => void;
};

export function QueueDrawer({
  open,
  queue,
  queueIndex,
  t,
  onClose,
  onSelectTrack,
  onRemoveTrack,
  onClearQueue,
}: QueueDrawerProps) {
  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="queue-drawer-backdrop"
        aria-label={t.closeQueue}
        onClick={onClose}
      />
      <aside className="queue-drawer" aria-label={t.openQueue}>
        <div className="queue-drawer-head">
          <h3>{t.openQueue}</h3>
          <div className="queue-drawer-head-actions">
            {queue.length > 1 && onClearQueue && (
              <button
                type="button"
                className="queue-clear-btn"
                onClick={onClearQueue}
                title={t.clearQueue}
              >
                {t.clearQueue}
              </button>
            )}
            <button
              type="button"
              className="queue-drawer-close"
              aria-label={t.closeQueue}
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="queue-drawer-list">
          {queue.length === 0 ? (
            <div className="up-next-empty">{t.upNextEmpty}</div>
          ) : (
            queue.map((track, idx) => (
              <div
                key={`${track.id}-${idx}`}
                className={`up-next-item queue-drawer-item ${idx === queueIndex ? 'active' : ''}`}
              >
                <button
                  type="button"
                  className="queue-drawer-select"
                  onClick={() => {
                    onSelectTrack(idx, track);
                    onClose();
                  }}
                >
                  <img
                    loading="lazy"
                    decoding="async"
                    alt=""
                    className="up-next-cover"
                    {...coverAttrs(track)}
                  />
                  <div className="up-next-meta">
                    <span className="up-next-title">{track.title}</span>
                    <span className="up-next-artist">{track.artist}</span>
                  </div>
                  {idx === queueIndex && <span className="queue-now-badge">{t.nowPlaying}</span>}
                </button>
                {onRemoveTrack && (
                  <button
                    type="button"
                    className="queue-remove-btn"
                    aria-label={t.removeFromQueue}
                    title={t.removeFromQueue}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveTrack(idx);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
