import { memo } from 'react';
import { Play } from 'lucide-react';
import type { Track } from '../../api/youtube';
import { coverAttrs } from '../../utils/imgError';

export const HeroSection = memo(function HeroSection({
  track,
  onPlay,
  t,
}: {
  track: Track;
  onPlay: () => void;
  t: Record<string, string>;
}) {
  return (
    <section className="hero-section">
      <div className="hero-content-wrapper">
        <img
          loading="eager"
          decoding="async"
          fetchPriority="high"
          width={200}
          height={200}
          alt=""
          className="hero-cover-art"
          {...coverAttrs(track, 'large')}
        />
        <div className="hero-text-block">
          <span className="hero-badge-premium">{t.bestResult}</span>
          <h1 className="hero-title-massive">{track.title}</h1>
          <h2 className="hero-artist-name">{track.artist}</h2>
          <div className="hero-action-buttons">
            <button type="button" className="play-button-premium" onClick={onPlay}>
              <Play size={26} fill="currentColor" /> {t.play}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
});
