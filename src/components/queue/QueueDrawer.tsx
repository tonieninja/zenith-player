import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, Trash2, X } from 'lucide-react';
import type { Track } from '../../api/youtube';
import { coverAttrs } from '../../utils/imgError';
import { useWindowedList } from '../../hooks/useWindowedList';

type QueueDrawerProps = {
  open: boolean;
  queue: Track[];
  queueIndex: number;
  t: Record<string, string>;
  onClose: () => void;
  onSelectTrack: (index: number, track: Track) => void;
  onRemoveTrack?: (index: number) => void;
  onClearQueue?: () => void;
  onReorder?: (from: number, to: number) => void;
};

type DragState = { from: number; over: number; pointerId: number; startY: number; moved: boolean };

export function QueueDrawer({
  open,
  queue,
  queueIndex,
  t,
  onClose,
  onSelectTrack,
  onRemoveTrack,
  onClearQueue,
  onReorder,
}: QueueDrawerProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrollRaf = useRef(0);
  const win = useWindowedList(open ? queue.length : 0, { scrollSelf: true });
  const setListRef = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      win.listRef(el);
    },
    [win.listRef]
  );

  const indexAtY = useCallback((clientY: number): number => {
    const list = listRef.current;
    if (!list) return -1;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-queue-index]'));
    if (!rows.length) return -1;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return Number(row.dataset.queueIndex);
    }
    return Number(rows[rows.length - 1].dataset.queueIndex) + 1;
  }, []);

  useEffect(
    () => () => {
      if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
    },
    []
  );

  const stopAutoScroll = () => {
    if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = 0;
  };

  const autoScroll = (clientY: number) => {
    stopAutoScroll();
    const list = listRef.current;
    if (!list) return;
    const r = list.getBoundingClientRect();
    const edge = 48;
    const speed = clientY < r.top + edge ? -10 : clientY > r.bottom - edge ? 10 : 0;
    if (!speed) return;
    const step = () => {
      list.scrollTop += speed;
      scrollRaf.current = requestAnimationFrame(step);
    };
    scrollRaf.current = requestAnimationFrame(step);
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLElement>, idx: number) => {
    if (!onReorder || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const next = { from: idx, over: idx, pointerId: e.pointerId, startY: e.clientY, moved: false };
    dragRef.current = next;
    setDrag(next);
  };

  const onHandleMove = (e: ReactPointerEvent<HTMLElement>) => {
    const cur = dragRef.current;
    if (!cur || cur.pointerId !== e.pointerId) return;
    const moved = cur.moved || Math.abs(e.clientY - cur.startY) > 4;
    const over = indexAtY(e.clientY);
    autoScroll(e.clientY);
    if (over === cur.over && moved === cur.moved) return;
    const next = { ...cur, over: over < 0 ? cur.over : over, moved };
    dragRef.current = next;
    setDrag(next);
  };

  const finishDrag = (e: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const cur = dragRef.current;
    if (!cur || cur.pointerId !== e.pointerId) return;
    stopAutoScroll();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    dragRef.current = null;
    setDrag(null);
    if (!commit || !cur.moved || !onReorder) return;
    let to = cur.over;
    if (to > cur.from) to -= 1;
    to = Math.max(0, Math.min(queue.length - 1, to));
    if (to !== cur.from) onReorder(cur.from, to);
  };

  if (!open) return null;

  const showSlot = (slot: number) =>
    drag?.moved && drag.over === slot && slot !== drag.from && slot !== drag.from + 1;

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
        {queue.length > 1 && onReorder && <p className="queue-drawer-hint">{t.queueDragHint}</p>}
        <div
          ref={setListRef}
          className={`queue-drawer-list${drag?.moved ? ' is-reordering' : ''}`}
          role="list"
        >
          {queue.length === 0 ? (
            <div className="up-next-empty">{t.upNextEmpty}</div>
          ) : (
            <>
              {win.padTop > 0 && (
                <div
                  data-vspacer=""
                  aria-hidden="true"
                  style={{ height: win.padTop, flexShrink: 0 }}
                />
              )}
              {queue.slice(win.start, win.end).map((track, i) => {
                const idx = win.start + i;
                return (
                  <div
                    key={`${track.id}-${idx}`}
                    data-queue-index={idx}
                    role="listitem"
                    className={[
                      'up-next-item queue-drawer-item',
                      idx === queueIndex ? 'active' : '',
                      drag?.moved && drag.from === idx ? 'is-dragging' : '',
                      showSlot(idx) ? 'drop-before' : '',
                      idx === queue.length - 1 && showSlot(queue.length) ? 'drop-after' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onKeyDown={(e) => {
                      if (!onReorder || !e.altKey) return;
                      if (e.key === 'ArrowUp' && idx > 0) {
                        e.preventDefault();
                        onReorder(idx, idx - 1);
                      } else if (e.key === 'ArrowDown' && idx < queue.length - 1) {
                        e.preventDefault();
                        onReorder(idx, idx + 1);
                      }
                    }}
                  >
                    {onReorder && queue.length > 1 && (
                      <span
                        className="queue-drag-handle"
                        title={t.queueDragHandle}
                        aria-label={t.queueDragHandle}
                        onPointerDown={(e) => onHandleDown(e, idx)}
                        onPointerMove={onHandleMove}
                        onPointerUp={(e) => finishDrag(e, true)}
                        onPointerCancel={(e) => finishDrag(e, false)}
                      >
                        <GripVertical size={16} />
                      </span>
                    )}
                    <button
                      type="button"
                      className="queue-drawer-select"
                      onClick={() => {
                        if (drag) return;
                        onSelectTrack(idx, track);
                        onClose();
                      }}
                    >
                      <img
                        loading="lazy"
                        decoding="async"
                        alt=""
                        className="up-next-cover"
                        draggable={false}
                        {...coverAttrs(track, 'thumb')}
                      />
                      <div className="up-next-meta">
                        <span className="up-next-title">{track.title}</span>
                        <span className="up-next-artist">{track.artist}</span>
                      </div>
                      {idx === queueIndex && (
                        <span className="queue-now-badge">{t.nowPlaying}</span>
                      )}
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
                );
              })}
              {win.padBottom > 0 && (
                <div
                  data-vspacer=""
                  aria-hidden="true"
                  style={{ height: win.padBottom, flexShrink: 0 }}
                />
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
