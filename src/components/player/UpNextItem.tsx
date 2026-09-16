import { memo } from 'react';
import type { Track } from '../../api/youtube';
import { coverAttrs } from '../../utils/imgError';

export const UpNextItem = memo(function UpNextItem({
  track,
  onClick,
}: {
  track: Track;
  onClick: () => void;
}) {
  return (
    <button type="button" className="up-next-item" onClick={onClick}>
      <img
        loading="lazy"
        decoding="async"
        alt=""
        className="up-next-cover"
        {...coverAttrs(track)}
      />
      <div className="up-next-meta">
        <span className="up-next-title">{track.title}</span>
        <span className="up-next-artist">{track.artist}</span>
      </div>
    </button>
  );
});
