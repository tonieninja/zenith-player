import { memo, useCallback, useRef, useState, type MouseEvent } from 'react';
import { Loader2, Play } from 'lucide-react';
import { searchFilterPage, type SearchChip, type Section, type Track } from '../../api/youtube';
import type { Language } from '../../i18n';
import { coverAttrs } from '../../utils/covers';
import { ctxTrackAttr, hitsPlayIcon, trackTypeLabel } from '../../utils/tracks';
import type { ArtistPlayMode } from '../feed/ArtistView';
import { HeroSection } from '../feed/HeroSection';
import { LoadMoreSentinel } from '../feed/LoadMoreSentinel';

type ItemClick = (item: Track, sectionTitle?: string, items?: Track[], play?: boolean) => unknown;

const ResultRow = memo(function ResultRow({
  item,
  badge,
  onClick,
}: {
  item: Track;
  badge: string | null;
  onClick: (item: Track, e: MouseEvent) => void;
}) {
  return (
    <button
      data-ctx-track={ctxTrackAttr(item)}
      className={`search-result-row search-result-type-${item.type}`}
      onClick={(e) => onClick(item, e)}
    >
      <div className="search-result-cover-wrap">
        <img
          alt=""
          className="search-result-cover"
          loading="lazy"
          decoding="async"
          {...coverAttrs(item, 'thumb')}
        />
        <div className="search-result-play-icon">
          <Play size={14} fill="currentColor" />
        </div>
      </div>
      <div className="search-result-meta">
        <span className="search-result-title">{item.title}</span>
        <span className="search-result-artist">{item.artist}</span>
      </div>
      {badge && <span className="search-result-badge">{badge}</span>}
    </button>
  );
});

/** Wyniki wyszukiwania z chipami filtrów YouTube Music; filtr doczytuje kolejne strony przy przewijaniu. */
export const SearchResults = memo(function SearchResults({
  query,
  lang,
  t,
  sections,
  chips,
  onItemClick,
  onPlayArtist,
  onHover,
}: {
  query: string;
  lang: Language;
  t: Record<string, string>;
  sections: Section[];
  chips: SearchChip[];
  onItemClick: ItemClick;
  onPlayArtist: (item: Track, mode: ArtistPlayMode) => void;
  onHover: (item: Track) => void;
}) {
  const [filter, setFilter] = useState<SearchChip | null>(null);
  const [items, setItems] = useState<Track[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const seqRef = useRef(0);

  const load = useCallback(
    (chip: SearchChip, token: string | null) => {
      const seq = ++seqRef.current;
      setStatus('loading');
      searchFilterPage(query, chip.params, lang, token).then(
        (page) => {
          if (seq !== seqRef.current) return;
          setItems((prev) => {
            if (!token) return page.items;
            const seen = new Set(prev.map((i) => i.id));
            return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
          });
          // ten sam token drugi raz zapętliłby doczytywanie na końcu listy
          setNext(page.next === token ? null : page.next);
          setStatus('idle');
        },
        () => {
          if (seq === seqRef.current) setStatus('error');
        }
      );
    },
    [query, lang]
  );

  const pick = (chip: SearchChip | null) => {
    document
      .querySelector<HTMLElement>('.content-area .content-scrollable')
      ?.scrollTo({ top: 0, behavior: 'instant' });
    ++seqRef.current;
    setFilter(chip);
    setItems([]);
    setNext(null);
    setStatus('idle');
    if (chip) load(chip, null);
  };

  const loadMore = useCallback(() => {
    if (filter && next && status === 'idle') load(filter, next);
  }, [filter, next, status, load]);

  const clickAll = useCallback(
    (item: Track, e: MouseEvent) => {
      const owner = sections.find((s) => s.items.some((i) => i.id === item.id));
      onItemClick(item, owner?.title, owner?.items, hitsPlayIcon(e));
    },
    [sections, onItemClick]
  );
  const clickFiltered = useCallback(
    (item: Track, e: MouseEvent) => onItemClick(item, filter?.title, items, hitsPlayIcon(e)),
    [filter, items, onItemClick]
  );

  const hero = !filter ? sections[0]?.items[0] : undefined;
  const openHero = useCallback(() => {
    if (hero) onItemClick(hero, sections[0]?.title, sections[0]?.items);
  }, [hero, sections, onItemClick]);
  const playHero = useCallback(
    (mode: ArtistPlayMode) => {
      if (!hero) return;
      if (hero.type === 'artist') onPlayArtist(hero, mode);
      else onItemClick(hero, sections[0]?.title, sections[0]?.items, true);
    },
    [hero, sections, onItemClick, onPlayArtist]
  );

  // w liście jednego filtra wszystkie wiersze mają ten sam typ, więc plakietka nic by nie mówiła
  const mixed = !filter || items.some((i) => i.type !== items[0]?.type);

  return (
    <>
      {chips.length > 0 && (
        <div
          className="mood-chips-container search-chips"
          role="group"
          aria-label={t.searchFilters}
        >
          <div className="mood-chips-scroll">
            {[null, ...chips].map((chip) => (
              <button
                key={chip?.params ?? ''}
                type="button"
                aria-pressed={filter?.params === chip?.params}
                className={`mood-chip${filter?.params === chip?.params ? ' active' : ''}`}
                onClick={() => filter?.params !== chip?.params && pick(chip)}
              >
                <span className="mood-chip-label">{chip?.title ?? t.searchAll}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {hero && (
        <HeroSection track={hero} onOpen={openHero} onPlay={playHero} onHover={onHover} t={t} />
      )}
      <div className="search-results-list">
        {!filter
          ? sections
              .flatMap((s) => s.items)
              .filter((i) => i.id !== hero?.id)
              .slice(0, 48)
              .map((item) => (
                <ResultRow
                  key={item.id}
                  item={item}
                  badge={trackTypeLabel(item.type, t)}
                  onClick={clickAll}
                />
              ))
          : items.map((item) => (
              <ResultRow
                key={item.id}
                item={item}
                badge={mixed ? trackTypeLabel(item.type, t) : null}
                onClick={clickFiltered}
              />
            ))}
        {filter && (
          <>
            {status === 'idle' && next && (
              <LoadMoreSentinel onVisible={loadMore} tick={items.length} />
            )}
            <div className="feed-load-more" role="status">
              {status === 'loading' ? (
                <Loader2 size={24} className="spin-icon" aria-label={t.loadingMore} />
              ) : status === 'error' ? (
                <button
                  type="button"
                  className="primary-action-btn"
                  onClick={() => load(filter, items.length ? next : null)}
                >
                  {t.retry}
                </button>
              ) : (
                !items.length && (
                  <div className="empty-state-message">
                    <h2>{t.noResults}</h2>
                    <p>{t.noResultsDesc}</p>
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
});
