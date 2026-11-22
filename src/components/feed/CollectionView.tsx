import { memo } from 'react';
import { Play, Shuffle } from 'lucide-react';
import type { Track } from '../../api/youtube';
import type { translations } from '../../i18n';
import { coverAttrs } from '../../utils/covers';
import { formatTime } from '../../utils/playback';
import { ctxTrackAttr } from '../../utils/tracks';
import { WindowedList } from '../ui/WindowedList';
import { HeroBackdrop } from '../FeedUI';
import { fmtTotal, tracksLabel } from '../PlaylistManager';

type T = (typeof translations)['en'];

// liczbę utworów podajemy sami, więc ta z bylinu YouTube Music byłaby w nagłówku drugi raz
const COUNT_PART = /^\d[\d.,\s]*\s*(?:songs?|tracks?|utw\p{L}*|episodes?|odcink\p{L}*)$/iu;

export const CollectionView = memo(function CollectionView({
  collection,
  kind,
  items,
  album,
  currentId,
  onItemClick,
  onPlay,
  t,
}: {
  collection: Track;
  kind: string;
  items: Track[];
  album: boolean;
  currentId?: string;
  onItemClick: (track: Track, sectionTitle?: string, sectionItems?: Track[]) => void;
  onPlay: (mode: 'all' | 'shuffle') => void;
  t: T;
}) {
  const owner = collection.artist
    .split(' • ')
    .map((x) => x.trim())
    .filter((x) => x && !COUNT_PART.test(x))
    .join(' • ');
  const total = items.every((i) => i.durationSec)
    ? items.reduce((s, i) => s + (i.durationSec || 0), 0)
    : 0;
  const meta = [owner, tracksLabel(items.length, t), total ? fmtTotal(total) : ''].filter(Boolean);
  const cover = collection.cover || collection.coverLarge ? collection : items[0];

  return (
    <div className="collection-view">
      <section className="collection-hero" aria-labelledby="collection-title">
        {cover && <HeroBackdrop track={cover} className="collection-backdrop" size="thumb" />}
        {cover && (
          <img
            className="collection-cover"
            alt=""
            width={200}
            height={200}
            decoding="async"
            fetchPriority="high"
            {...coverAttrs(cover, 'large')}
          />
        )}
        <div className="collection-hero-text">
          <span className="collection-kind">{kind}</span>
          <h1 id="collection-title" className="collection-title">
            {collection.title}
          </h1>
          <p className="collection-meta">{meta.join(' • ')}</p>
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
          </div>
        </div>
      </section>

      <WindowedList
        className={'collection-tracks' + (album ? ' is-album' : '')}
        count={items.length}
        renderRow={(i) => {
          const item = items[i];
          return (
            <button
              key={`${item.id}-${i}`}
              type="button"
              className={
                'search-result-row artist-song-row collection-row' +
                (item.id === currentId ? ' is-current' : '')
              }
              aria-current={item.id === currentId ? 'true' : undefined}
              data-ctx-track={ctxTrackAttr(item)}
              onClick={() => onItemClick(item, collection.title, items)}
            >
              <span className="artist-song-index collection-index" aria-hidden>
                <span className="collection-index-num">{i + 1}</span>
                <Play className="collection-index-play" size={14} fill="currentColor" />
              </span>
              {!album && (
                <div className="search-result-cover-wrap artist-song-cover">
                  <img
                    alt=""
                    className="search-result-cover"
                    loading="lazy"
                    decoding="async"
                    {...coverAttrs(item, 'thumb')}
                  />
                </div>
              )}
              <div className="search-result-meta">
                <span className="search-result-title">{item.title}</span>
                <span className="search-result-artist">{item.artist}</span>
              </div>
              {!album && item.album && <span className="collection-row-album">{item.album}</span>}
              {!!item.durationSec && (
                <span className="artist-song-duration">{formatTime(item.durationSec)}</span>
              )}
            </button>
          );
        }}
      />
    </div>
  );
});
