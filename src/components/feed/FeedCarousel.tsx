import { memo, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Play } from 'lucide-react';
import type { Section, Track } from '../../api/youtube';
import { usePager } from '../../hooks/usePager';
import { useResponsivePageSize } from '../../hooks/useResponsivePageSize';
import { coverAttrs } from '../../utils/imgError';

export const PAGE_SIZE = 8;

type ItemClick = (t: Track, st?: string, si?: Track[]) => void;

const AlbumCard = memo(function AlbumCard({
  track,
  sectionTitle,
  sectionItems,
  onClick,
  priority = false,
}: {
  track: Track;
  sectionTitle?: string;
  sectionItems?: Track[];
  onClick: ItemClick;
  priority?: boolean;
}) {
  const handleClick = useCallback(
    () => onClick(track, sectionTitle, sectionItems),
    [onClick, track, sectionTitle, sectionItems]
  );
  return (
    <div className="yt-card" onClick={handleClick}>
      <div className="yt-card-thumb">
        <img
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'low'}
          decoding="async"
          alt=""
          className="yt-card-img"
          {...coverAttrs(track)}
        />
        <div className="yt-card-overlay">
          <div className="yt-card-play-btn">
            <Play size={22} fill="currentColor" />
          </div>
        </div>
      </div>
      <div className="yt-card-info">
        <div className="yt-card-title">{track.title}</div>
        <div className="yt-card-sub">{track.artist}</div>
      </div>
    </div>
  );
});

export const SectionRow = memo(function SectionRow({
  section,
  sectionIndex,
  onItemClick,
}: {
  section: Section;
  sectionIndex: number;
  onItemClick: ItemClick;
}) {
  const { ref, pageSize } = useResponsivePageSize(176, PAGE_SIZE);
  const pg = usePager(section.items, pageSize);
  return (
    <section className="yt-section" ref={ref}>
      <div className="yt-section-head">
        <h2 className="yt-section-title">{section.title}</h2>
        <div className="yt-section-arrows">
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
        key={pg.epoch}
        className={'yt-scroll-track' + (pg.dir ? ' yt-anim yt-slide-' + pg.dir : '')}
      >
        {pg.visible.map((track, idx) => (
          <AlbumCard
            key={track.id}
            track={track}
            sectionTitle={section.title}
            sectionItems={section.items}
            onClick={onItemClick}
            priority={sectionIndex === 0 && idx < 4}
          />
        ))}
      </div>
    </section>
  );
});

export const QuickPicks = memo(function QuickPicks({
  tracks,
  onItemClick,
  t,
}: {
  tracks: Track[];
  onItemClick: ItemClick;
  t: Record<string, string>;
}) {
  const { ref, pageSize } = useResponsivePageSize(176, PAGE_SIZE);
  const pg = usePager(tracks, pageSize);
  if (!tracks.length) return null;
  return (
    <section className="yt-section" ref={ref}>
      <div className="yt-section-head">
        <h2 className="yt-section-title">{t.quickPicks}</h2>
        <div className="yt-section-arrows">
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
        key={pg.epoch}
        className={'yt-scroll-track' + (pg.dir ? ' yt-anim yt-slide-' + pg.dir : '')}
      >
        {pg.visible.map((track, idx) => (
          <AlbumCard
            key={track.id}
            track={track}
            sectionTitle={t.quickPicks}
            sectionItems={tracks}
            onClick={onItemClick}
            priority={idx < 3}
          />
        ))}
      </div>
    </section>
  );
});
