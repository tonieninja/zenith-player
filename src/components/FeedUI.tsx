import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { BarChart3, Flame, Play, Smile } from 'lucide-react';
import type { Section, Track } from '../api/youtube';
import type { Language } from '../i18n';
import { usePager } from '../hooks/usePager';
import { useResponsivePageSize } from '../hooks/useResponsivePageSize';
import { coverAttrs } from '../utils/covers';
import { PagerArrows } from './feed/FeedCarousel';
import { getExploreLayout } from '../i18n/plugins';
import { preBlur, preBlurred } from '../utils/preBlur';

export { coverAttrs };

export function HeroBackdrop({
  track,
  className = 'feed-hero-bg',
  size,
}: {
  track: Track;
  className?: string;
  size?: 'thumb' | 'small';
}) {
  const attrs = coverAttrs(track, size);
  const orig = (attrs as { 'data-orig'?: string })['data-orig'];
  const key = attrs.src || orig || '';
  const [blurred, setBlurred] = useState<string | null | undefined>(() => preBlurred(key));
  useEffect(() => {
    let live = true;
    setBlurred(preBlurred(key));
    preBlur([attrs.src, orig || ''].filter(Boolean)).then((b) => {
      if (live) setBlurred(b);
    });
    return () => {
      live = false;
    };
  }, [key, attrs.src, orig]);
  if (blurred === undefined) return null;
  if (blurred)
    return <img alt="" className={`${className} pre-blurred`} aria-hidden src={blurred} />;
  return (
    <img alt="" className={className} loading="lazy" decoding="async" aria-hidden {...attrs} />
  );
}

export const FeedHero = memo(function FeedHero({
  track,
  onPlay,
  eyebrow,
  playLabel,
}: {
  track: Track;
  onPlay: () => void;
  eyebrow: string;
  playLabel: string;
}) {
  return (
    <section className="feed-hero">
      <HeroBackdrop track={track} />
      <div className="feed-hero-scrim" />
      <div className="feed-hero-body">
        <span className="feed-hero-eyebrow">{eyebrow}</span>
        <h1 className="feed-hero-title">{track.title}</h1>
        <p className="feed-hero-artist">{track.artist}</p>
        <button type="button" className="feed-hero-play" onClick={onPlay}>
          <Play size={20} fill="currentColor" /> {playLabel}
        </button>
      </div>
    </section>
  );
});

export const FeedSkeleton = memo(function FeedSkeleton() {
  return (
    <div className="feed-skeleton" aria-hidden>
      {[0, 1, 2].map((i) => (
        <section key={i} className="yt-section skeleton-section">
          <div className="skeleton-line skeleton-title" />
          <div className="skeleton-cards-row">
            {Array.from({ length: 6 }).map((_, j) => (
              <div key={j} className="skeleton-card" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});

export const LibrarySkeleton = memo(function LibrarySkeleton() {
  return (
    <div className="library-skeleton" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="library-skeleton-row">
          <div className="skeleton-cover" />
          <div className="skeleton-lines">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        </div>
      ))}
    </div>
  );
});

const EXPLORE_TRENDING_MIN = 12;
const EXPLORE_TRENDING_ROWS = 3;
const EXPLORE_TRENDING_COL_W = 300;

const ExploreTrendingShelf = memo(function ExploreTrendingShelf({
  section,
  onItemClick,
}: {
  section: Section;
  onItemClick: (t: Track, st?: string, si?: Track[]) => void;
}) {
  const { ref: listRef, pageSize: cols } = useResponsivePageSize<HTMLElement>(
    EXPLORE_TRENDING_COL_W,
    10,
    2
  );
  const pageSize = Math.max(EXPLORE_TRENDING_MIN, cols * EXPLORE_TRENDING_ROWS);
  const pg = usePager(section.items, pageSize);
  return (
    // ref na sekcji, bo siatka z key={pg.epoch} po przewinięciu strony to nowy węzeł, którego RO już nie śledzi
    <section className="explore-section" ref={listRef}>
      <div className="explore-section-header">
        <h2 className="explore-section-title">{section.title}</h2>
        <PagerArrows pg={pg} className="explore-header-right" />
      </div>
      <div
        key={pg.epoch}
        style={{ '--cols': cols } as CSSProperties}
        className={'explore-trending-list' + (pg.dir ? ' yt-anim yt-slide-' + pg.dir : '')}
      >
        {pg.visible.map((track, idx) => (
          <button
            key={track.id}
            type="button"
            className="explore-trending-row"
            style={{ '--card-i': idx } as CSSProperties}
            onClick={() => onItemClick(track, section.title, section.items)}
          >
            <span className="explore-trending-num">{pg.start + idx + 1}</span>
            <div className="explore-trending-cover-wrap">
              <img
                alt=""
                className="explore-trending-cover"
                loading="lazy"
                decoding="async"
                {...coverAttrs(track)}
              />
              <div className="explore-trending-play">
                <Play size={12} fill="currentColor" />
              </div>
            </div>
            <div className="explore-trending-meta">
              <span className="explore-trending-title">{track.title}</span>
              <span className="explore-trending-artist">{track.artist}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
});

type ExploreProps = {
  sections: Section[];
  onItemClick: (t: Track, st?: string, si?: Track[]) => void;
  onNavigateMoods: () => void;
  t: Record<string, string>;
  lang: Language;
  renderSection: (section: Section, index: number) => React.ReactNode;
};

export const ExploreView = memo(function ExploreView({
  sections,
  onItemClick,
  onNavigateMoods,
  t,
  renderSection,
}: ExploreProps) {
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  const scrollToSection = useCallback((index: number) => {
    const el = sectionRefs.current[index];
    if (!el) return;
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && scroller.scrollHeight > scroller.clientHeight)
        break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return;
    const top =
      el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
  }, []);
  const heroTrack = sections[0]?.items[0];
  const chartsIdx = sections.findIndex((s) => getExploreLayout(s.title) === 'trending');

  return (
    <div className="explore-view-wrapper">
      {heroTrack && (
        <FeedHero
          track={heroTrack}
          eyebrow={t.featured}
          playLabel={t.play}
          onPlay={() => onItemClick(heroTrack, sections[0].title, sections[0].items)}
        />
      )}
      <div className="explore-top-nav">
        <button type="button" className="explore-nav-btn" onClick={() => scrollToSection(0)}>
          <Flame size={16} />
          {t.newReleases}
        </button>
        {chartsIdx >= 0 && (
          <button
            type="button"
            className="explore-nav-btn"
            onClick={() => scrollToSection(chartsIdx)}
          >
            <BarChart3 size={16} />
            {t.charts}
          </button>
        )}
        <button type="button" className="explore-nav-btn" onClick={onNavigateMoods}>
          <Smile size={16} />
          {t.moodsAndGenres}
        </button>
      </div>
      {sections.map((section, idx) => (
        <div
          key={`${section.title}-${idx}`}
          ref={(el) => {
            sectionRefs.current[idx] = el;
          }}
        >
          {getExploreLayout(section.title) === 'trending' ? (
            <ExploreTrendingShelf section={section} onItemClick={onItemClick} />
          ) : (
            renderSection(section, idx)
          )}
        </div>
      ))}
    </div>
  );
});
