import { memo, useCallback, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, Play } from 'lucide-react';
import type { Section, Track } from '../../api/youtube';
import { usePager } from '../../hooks/usePager';
import { useResponsivePageSize } from '../../hooks/useResponsivePageSize';
import { coverAttrs } from '../../utils/covers';
import { currentT } from '../../i18n';
import { ctxTrackAttr, isPrimaryButton } from '../../utils/tracks';
import { clickOnKey } from '../ui/keyboard';

export const PAGE_SIZE = 8;

type ItemClick = (t: Track, st?: string, si?: Track[]) => void;

// strzałka bez disabled łapała fokus z Tab, a półka mieszcząca się na jednej stronie nie potrzebuje ich wcale
export function PagerArrows({
  pg,
  className = 'yt-section-arrows',
}: {
  pg: { canPrev: boolean; canNext: boolean; prev: () => void; next: () => void };
  className?: string;
}) {
  if (!pg.canPrev && !pg.canNext) return null;
  return (
    <div className={className}>
      <button
        type="button"
        className="yt-arrow"
        disabled={!pg.canPrev}
        onClick={pg.prev}
        aria-label={currentT().previousTrack}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        type="button"
        className="yt-arrow"
        disabled={!pg.canNext}
        onClick={pg.next}
        aria-label={currentT().nextTrack}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

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
    (e: { button?: number }) => {
      if (!isPrimaryButton(e.button)) return;
      onClick(track, sectionTitle, sectionItems);
    },
    [onClick, track, sectionTitle, sectionItems]
  );
  // teledysk w kwadracie pokazywał czarne pasy z hqdefault, więc dostaje kartę 16:9 także w półce mieszanej
  const wide = track.cover.includes('i.ytimg.com/vi/');
  return (
    <div
      className={`yt-card yt-card-${track.type}${wide ? ' yt-card-wide' : ''}`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={clickOnKey}
      data-ctx-track={ctxTrackAttr(track)}
    >
      <div className="yt-card-thumb">
        <img
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'low'}
          decoding="async"
          alt=""
          className="yt-card-img"
          {...coverAttrs(track, devicePixelRatio >= 2 ? 'large' : 'medium')}
        />
        <div className="yt-card-overlay">
          <div className="yt-card-play-btn">
            <Play size={22} fill="currentColor" />
          </div>
        </div>
      </div>
      <div className="yt-card-info">
        <div className="yt-card-title" title={track.title}>
          {track.title}
        </div>
        <div className="yt-card-sub" title={track.artist}>
          {track.artist}
        </div>
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
  // miniatura teledysku w kwadracie traci boki kadru, więc taka sekcja dostaje szersze karty 16:9
  const video =
    section.items.length > 0 && section.items.every((i) => i.cover.includes('i.ytimg.com/vi/'));
  const { ref, pageSize } = useResponsivePageSize(video ? 260 : 176, video ? 5 : PAGE_SIZE);
  const pg = usePager(section.items, pageSize);
  return (
    <section className={'yt-section' + (video ? ' yt-section-video' : '')} ref={ref}>
      <div className="yt-section-head">
        <h2 className="yt-section-title">{section.title}</h2>
        <PagerArrows pg={pg} />
      </div>
      <div
        key={pg.epoch}
        style={{ '--cols': pageSize } as CSSProperties}
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
        <PagerArrows pg={pg} />
      </div>
      <div
        key={pg.epoch}
        style={{ '--cols': pageSize } as CSSProperties}
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
