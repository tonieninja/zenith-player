import { memo } from 'react';
import { Play, Radio, Shuffle, UserRound } from 'lucide-react';
import type { Track } from '../../api/youtube';
import { coverAttrs } from '../../utils/covers';
import { clickOnKey } from '../ui/keyboard';
import type { ArtistPlayMode } from './ArtistView';

export const HeroSection = memo(function HeroSection({
  track,
  onOpen,
  onPlay,
  onHover,
  t,
}: {
  track: Track;
  onOpen: () => void;
  onPlay: (mode: ArtistPlayMode) => void;
  onHover?: (track: Track) => void;
  t: Record<string, string>;
}) {
  const artist = track.type === 'artist';
  const profile = track.type === 'profile';
  return (
    <section className="hero-section" onPointerEnter={onHover && (() => onHover(track))}>
      <div className="hero-content-wrapper">
        <img
          loading="eager"
          decoding="async"
          fetchPriority="high"
          width={200}
          height={200}
          alt=""
          className={`hero-cover-art hero-open${artist || profile ? ' is-artist' : ''}`}
          onClick={onOpen}
          {...coverAttrs(track, 'large')}
        />
        <div className="hero-text-block">
          <span className="hero-badge">{t.bestResult}</span>
          <h1 className="hero-title-massive">
            <span
              className="hero-open hero-title-link"
              role="button"
              tabIndex={0}
              onClick={onOpen}
              onKeyDown={clickOnKey}
            >
              {track.title}
            </span>
          </h1>
          <h2 className="hero-artist-name">{track.artist}</h2>
          <div className="hero-action-buttons">
            {/* wykonawcy nie gra się wprost: YouTube Music daje przy nim losowanie i radio */}
            {artist ? (
              <>
                <button type="button" className="feed-hero-play" onClick={() => onPlay('shuffle')}>
                  <Shuffle size={20} /> {t.shuffle}
                </button>
                <button
                  type="button"
                  className="primary-action-btn artist-action-btn"
                  onClick={() => onPlay('radio')}
                >
                  <Radio size={18} /> {t.artistRadio}
                </button>
              </>
            ) : profile ? (
              // profilu nie da się odtworzyć, „Odtwórz” tylko udawałoby, że coś zagra
              <button type="button" className="feed-hero-play" onClick={onOpen}>
                <UserRound size={20} /> {t.openProfile}
              </button>
            ) : (
              <button type="button" className="feed-hero-play" onClick={() => onPlay('all')}>
                <Play size={20} fill="currentColor" /> {t.play}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
});
