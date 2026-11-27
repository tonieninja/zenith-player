import { memo, useCallback, useMemo } from 'react';
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
  return (
    <div
      className={`yt-card yt-card-${track.type}`}
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
          {...coverAttrs(track, devicePixelRatio > 1 ? 'large' : 'small')}
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

const LIST_ROWS = 4;

const ListRow = memo(function ListRow({
  track,
  sectionTitle,
  sectionItems,
  onClick,
  priority,
}: {
  track: Track;
  sectionTitle: string;
  sectionItems: Track[];
  onClick: ItemClick;
  priority: boolean;
}) {
  return (
    <button
      type="button"
      className={`search-result-row yt-list-row search-result-type-${track.type}`}
      data-ctx-track={ctxTrackAttr(track)}
      onClick={() => onClick(track, sectionTitle, sectionItems)}
    >
      <div className="search-result-cover-wrap">
        <img
          alt=""
          className="search-result-cover"
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          {...coverAttrs(track, 'thumb')}
        />
        <div className="search-result-play-icon">
          <Play size={14} fill="currentColor" />
        </div>
      </div>
      <div className="search-result-meta">
        <span className="search-result-title" title={track.title}>
          {track.title}
        </span>
        <span className="search-result-artist" title={track.artist}>
          {track.artist}
        </span>
      </div>
    </button>
  );
});

export const SectionRow = memo(function SectionRow({
  section,
  sectionIndex,
  onItemClick,
  onMore,
}: {
  section: Section;
  sectionIndex: number;
  onItemClick: ItemClick;
  onMore?: (section: Section) => void;
}) {
  const t = currentT();
  const list = section.layout === 'list';
  const grid = section.layout === 'grid';
  // miniatura teledysku w kwadracie traci boki kadru, więc taka sekcja dostaje szersze karty 16:9
  const video =
    !list &&
    section.items.length > 0 &&
    section.items.every((i) => i.cover.includes('i.ytimg.com/vi/'));
  // pager półki-listy przesuwa całe kolumny po cztery utwory, jak w YouTube Music
  const pages = useMemo<(Track | Track[])[]>(
    () =>
      list
        ? Array.from({ length: Math.ceil(section.items.length / LIST_ROWS) }, (_, i) =>
            section.items.slice(i * LIST_ROWS, i * LIST_ROWS + LIST_ROWS)
          )
        : section.items,
    [list, section.items]
  );
  const { ref, pageSize } = useResponsivePageSize(
    list ? 300 : video ? 260 : 176,
    list ? 4 : video ? 5 : PAGE_SIZE,
    list ? 1 : 2
  );
  const pg = usePager(pages, pageSize);
  const more = onMore && section.more ? () => onMore(section) : undefined;
  return (
    <section
      className={
        'yt-section' + (video ? ' yt-section-video' : '') + (grid ? ' yt-section-grid' : '')
      }
      ref={ref}
    >
      <div className="yt-section-head">
        <div className="yt-section-heading">
          {section.strapline && <div className="yt-section-strap">{section.strapline}</div>}
          <h2 className="yt-section-title">
            {more ? (
              <button type="button" className="yt-section-title-link" onClick={more}>
                {section.title}
              </button>
            ) : (
              section.title
            )}
          </h2>
        </div>
        <div className="yt-section-arrows">
          {more && (
            <button type="button" className="yt-section-more" onClick={more}>
              {t.more}
            </button>
          )}
          {!grid && (
            <>
              <button
                type="button"
                className={'yt-arrow' + (!pg.canPrev ? ' yt-arrow-disabled' : '')}
                onClick={pg.prev}
                aria-label={t.previousTrack}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                className={'yt-arrow' + (!pg.canNext ? ' yt-arrow-disabled' : '')}
                onClick={pg.next}
                aria-label={t.nextTrack}
              >
                <ChevronRight size={18} />
              </button>
            </>
          )}
        </div>
      </div>
      {grid ? (
        <div className="yt-grid-wrap">
          {section.items.map((track, idx) => (
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
      ) : (
        <div
          key={pg.epoch}
          className={
            (list ? 'yt-list-track' : 'yt-scroll-track') +
            (pg.dir ? ' yt-anim yt-slide-' + pg.dir : '')
          }
          style={list ? ({ '--cols': pageSize } as React.CSSProperties) : undefined}
        >
          {pg.visible.map((entry, idx) =>
            Array.isArray(entry) ? (
              <div className="yt-list-col" key={entry[0].id}>
                {entry.map((track) => (
                  <ListRow
                    key={track.id}
                    track={track}
                    sectionTitle={section.title}
                    sectionItems={section.items}
                    onClick={onItemClick}
                    priority={sectionIndex === 0 && idx === 0}
                  />
                ))}
              </div>
            ) : (
              <AlbumCard
                key={entry.id}
                track={entry}
                sectionTitle={section.title}
                sectionItems={section.items}
                onClick={onItemClick}
                priority={sectionIndex === 0 && idx < 4}
              />
            )
          )}
        </div>
      )}
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
  const section = useMemo<Section>(
    () => ({ title: t.quickPicks, items: tracks, layout: 'list' }),
    [t.quickPicks, tracks]
  );
  if (!tracks.length) return null;
  return <SectionRow section={section} sectionIndex={0} onItemClick={onItemClick} />;
});
