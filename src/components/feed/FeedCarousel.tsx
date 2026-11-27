import { memo, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, EyeOff, Play } from 'lucide-react';
import type { Section, Track } from '../../api/youtube';
import { usePager } from '../../hooks/usePager';
import { useResponsivePageSize } from '../../hooks/useResponsivePageSize';
import { coverAttrs } from '../../utils/covers';
import { currentT } from '../../i18n';
import { QUICK_PICKS_SHELF } from '../../utils/feed';
import { ctxTrackAttr, isPrimaryButton } from '../../utils/tracks';
import { clickOnKey } from '../ui/keyboard';

export const PAGE_SIZE = 8;

type ItemClick = (t: Track, st?: string, si?: Track[]) => void;
type ItemHover = (t: Track) => void;

// strzałka bez disabled łapała fokus z Tab, a półka mieszcząca się na jednej stronie nie potrzebuje ich wcale
export function PagerArrows({
  pg,
  className = 'yt-section-arrows',
}: {
  pg: { canPrev: boolean; canNext: boolean; prev: () => void; next: () => void };
  className?: string | null;
}) {
  if (!pg.canPrev && !pg.canNext) return null;
  const buttons = (
    <>
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
    </>
  );
  // null: strzałki trafiają do cudzego kontenera nagłówka, obok „Więcej” i „Ukryj”
  return className === null ? buttons : <div className={className}>{buttons}</div>;
}

const AlbumCard = memo(function AlbumCard({
  track,
  sectionTitle,
  sectionItems,
  onClick,
  onHover,
  priority = false,
}: {
  track: Track;
  sectionTitle?: string;
  sectionItems?: Track[];
  onClick: ItemClick;
  onHover?: ItemHover;
  priority?: boolean;
}) {
  const hoverTimer = useRef(0);
  const handleClick = useCallback(
    (e: { button?: number }) => {
      if (!isPrimaryButton(e.button)) return;
      // klik sam wczytuje stronę, więc spóźniony prefetch wysłałby to samo zapytanie drugi raz
      window.clearTimeout(hoverTimer.current);
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
      // przejazd kursorem przez rząd kart nie wysyła zapytań, dopiero zatrzymanie na karcie
      onPointerEnter={
        onHover &&
        (() => {
          hoverTimer.current = window.setTimeout(() => onHover(track), 150);
        })
      }
      onPointerLeave={() => window.clearTimeout(hoverTimer.current)}
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
  onItemHover,
  onMore,
  onHide,
}: {
  section: Section;
  sectionIndex: number;
  onItemClick: ItemClick;
  onItemHover?: ItemHover;
  onMore?: (section: Section) => void;
  onHide?: (section: Section) => void;
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
          {!grid && <PagerArrows pg={pg} className={null} />}
          {onHide && (
            <button
              type="button"
              className="yt-arrow yt-section-hide"
              onClick={() => onHide(section)}
              aria-label={t.hideShelf}
              title={t.hideShelf}
            >
              <EyeOff size={15} />
            </button>
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
              onHover={onItemHover}
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
          style={{ '--cols': pageSize } as CSSProperties}
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
                onHover={onItemHover}
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
  onHide,
  t,
}: {
  tracks: Track[];
  onItemClick: ItemClick;
  onHide?: (section: Section) => void;
  t: Record<string, string>;
}) {
  const section = useMemo<Section>(
    () => ({ id: QUICK_PICKS_SHELF, title: t.quickPicks, items: tracks, layout: 'list' }),
    [t.quickPicks, tracks]
  );
  if (!tracks.length) return null;
  return (
    <SectionRow section={section} sectionIndex={0} onItemClick={onItemClick} onHide={onHide} />
  );
});
