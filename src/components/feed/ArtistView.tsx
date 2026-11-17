import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Play, Radio, Shuffle } from 'lucide-react';
import type { ArtistHeader, Section, Track } from '../../api/youtube';
import { coverAttrs } from '../../utils/covers';
import { formatTime } from '../../utils/playback';
import { ctxTrackAttr } from '../../utils/tracks';
import { SectionRow } from './FeedCarousel';

export type ArtistPlayMode = 'all' | 'shuffle' | 'radio';

type ItemClick = (t: Track, st?: string, si?: Track[]) => void;

function ArtistAbout({ text, t }: { text: string; t: Record<string, string> }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    // przycisk ma sens tylko wtedy, gdy trzy linie faktycznie ucinają opis przy obecnej szerokości
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <div className="artist-hero-about">
      <p
        ref={ref}
        id="artist-description"
        className={'artist-hero-description' + (open ? ' expanded' : '')}
      >
        {text}
      </p>
      {(clamped || open) && (
        <button
          type="button"
          className="artist-hero-more"
          aria-expanded={open}
          aria-controls="artist-description"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t.less : t.more}
        </button>
      )}
    </div>
  );
}

export const ArtistView = memo(function ArtistView({
  avatar,
  header,
  sections,
  onItemClick,
  onPlay,
  onShowAll,
  t,
}: {
  avatar: Track;
  header: ArtistHeader;
  sections: Section[];
  onItemClick: ItemClick;
  onPlay: (mode: ArtistPlayMode) => void;
  onShowAll: () => void;
  t: Record<string, string>;
}) {
  const top = header.songsTitle ? sections.find((s) => s.title === header.songsTitle) : undefined;
  const rest = top ? sections.filter((s) => s !== top) : sections;
  const meta = [
    header.subscribers && t.artistSubscribers.replace('{n}', header.subscribers),
    header.listeners,
  ].filter(Boolean);
  const hasAvatar = !!(avatar.cover || avatar.coverLarge || avatar.coverSmall);
  const canPlay = !!header.songsId || !!top?.items.length;

  return (
    <div className="artist-view">
      <section className="artist-hero" aria-labelledby="artist-name">
        {header.banner && (
          <img
            className="artist-hero-banner"
            src={header.banner}
            alt=""
            aria-hidden
            decoding="async"
            fetchPriority="high"
          />
        )}
        <div className="artist-hero-scrim" />
        <div className="artist-hero-body">
          <div className="artist-hero-identity">
            {hasAvatar && (
              <img
                className="artist-hero-avatar"
                alt=""
                width={120}
                height={120}
                decoding="async"
                {...coverAttrs(avatar, 'large')}
              />
            )}
            <div className="artist-hero-text">
              <h1 id="artist-name" className="artist-hero-name">
                {header.name || avatar.title}
              </h1>
              {meta.length > 0 && <p className="artist-hero-meta">{meta.join(' • ')}</p>}
            </div>
          </div>
          {header.description && <ArtistAbout key={header.name} text={header.description} t={t} />}
          {canPlay && (
            <div className="artist-hero-actions">
              <button
                type="button"
                className="feed-hero-play artist-play-all"
                onClick={() => onPlay('all')}
              >
                <Play size={20} fill="currentColor" /> {t.artistPlayAll}
              </button>
              <button
                type="button"
                className="primary-action-btn artist-action-btn"
                onClick={() => onPlay('shuffle')}
              >
                <Shuffle size={18} /> {t.shuffle}
              </button>
              {header.radioId && (
                <button
                  type="button"
                  className="primary-action-btn artist-action-btn"
                  onClick={() => onPlay('radio')}
                >
                  <Radio size={18} /> {t.artistRadio}
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {top && (
        <section className="yt-section artist-top-section" aria-labelledby="artist-top-title">
          <div className="yt-section-head">
            <h2 id="artist-top-title" className="yt-section-title">
              {top.title}
            </h2>
            {header.songsId && (
              <button type="button" className="artist-show-all" onClick={onShowAll}>
                {t.artistShowAll}
              </button>
            )}
          </div>
          <ol className="artist-top-songs">
            {top.items.map((item, i) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="search-result-row artist-song-row"
                  data-ctx-track={ctxTrackAttr(item)}
                  onClick={() => onItemClick(item, top.title, top.items)}
                >
                  <span className="artist-song-index" aria-hidden>
                    {i + 1}
                  </span>
                  <div className="search-result-cover-wrap artist-song-cover">
                    <img
                      alt=""
                      className="search-result-cover"
                      loading="lazy"
                      decoding="async"
                      {...coverAttrs(item)}
                    />
                    <div className="search-result-play-icon">
                      <Play size={14} fill="currentColor" />
                    </div>
                  </div>
                  <div className="search-result-meta">
                    <span className="search-result-title">{item.title}</span>
                    <span className="search-result-artist">{item.artist}</span>
                  </div>
                  {!!item.durationSec && (
                    <span className="artist-song-duration">{formatTime(item.durationSec)}</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {rest.map((section, idx) => (
        <SectionRow
          key={`${section.title}-${idx}`}
          section={section}
          sectionIndex={idx}
          onItemClick={onItemClick}
        />
      ))}
    </div>
  );
});

export const ArtistSkeleton = memo(function ArtistSkeleton() {
  return (
    <div className="artist-skeleton" aria-hidden>
      <div className="skeleton-card artist-skeleton-hero" />
      <div className="library-skeleton">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="library-skeleton-row">
            <div className="skeleton-cover" />
            <div className="skeleton-lines">
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
            </div>
          </div>
        ))}
      </div>
      <div className="skeleton-cards-row">
        {Array.from({ length: 6 }).map((_, j) => (
          <div key={j} className="skeleton-card" />
        ))}
      </div>
    </div>
  );
});
