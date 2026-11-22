import { memo } from 'react';
import type { Track } from '../../api/youtube';
import { coverAttrs } from '../../utils/covers';

export const UpNextItem = memo(function UpNextItem({
  track,
  index,
  onPlay,
}: {
  track: Track;
  index: number;
  onPlay: (index: number) => void;
}) {
  return (
    <button type="button" className="up-next-item" onClick={() => onPlay(index)}>
      <img
        loading="lazy"
        decoding="async"
        alt=""
        className="up-next-cover"
        {...coverAttrs(track, 'thumb')}
      />
      <div className="up-next-meta">
        <span className="up-next-title" title={track.title}>
          {track.title}
        </span>
        <span className="up-next-artist" title={track.artist}>
          {track.artist}
        </span>
      </div>
    </button>
  );
});
