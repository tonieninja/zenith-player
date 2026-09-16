import { memo, useCallback, useRef, type CSSProperties } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Flame, Play, Smile } from 'lucide-react';
import type { Section, Track } from '../api/youtube';
import type { Language } from '../i18n';
import { usePager } from '../hooks/usePager';
import { useResponsivePageSize } from '../hooks/useResponsivePageSize';
import { coverAttrs } from '../utils/imgError';
import { getExploreLayout } from '../utils/pluginI18n';

export { coverAttrs };

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
      <img
        alt=""
        className="feed-hero-bg"
        loading="lazy"
        decoding="async"
        aria-hidden
        {...coverAttrs(track)}
      />
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
const EXPLORE_TRENDING_COL_W = 200;

const ExploreTrendingShelf = memo(function ExploreTrendingShelf({
  section,
  onItemClick,
}: {
  section: Section;
  onItemClick: (t: Track, st?: string, si?: Track[]) => void;
}) {
  const { ref: listRef, pageSize: cols } = useResponsivePageSize<HTMLDivElement>(
    EXPLORE_TRENDING_COL_W,
    10,
    4
  );
  const pageSize = Math.max(EXPLORE_TRENDING_MIN, cols * EXPLORE_TRENDING_ROWS);
  const pg = usePager(section.items, pageSize);
  return (
    <section className="explore-section">
      <div className="explore-section-header">
        <h2 className="explore-section-title">{section.title}</h2>
        <div className="explore-header-right">
          <button
            type="button"
            className={'yt-arrow' + (!pg.canPrev ? ' yt-arrow-disabled' : '')}
            onClick={pg.prev}
            aria-label="Previous"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className={'yt-arrow' + (!pg.canNext ? ' yt-arrow-disabled' : '')}
            onClick={pg.next}
            aria-label="Next"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <div
        ref={listRef}
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
    sectionRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
