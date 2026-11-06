import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { TrackLikeStatus } from '../../api/youtube';

export function YtmRatingButtons({
  rating,
  onLike,
  onDislike,
  likeLabel,
  dislikeLabel,
  className = '',
}: {
  rating: TrackLikeStatus;
  onLike: () => void;
  onDislike: () => void;
  likeLabel: string;
  dislikeLabel: string;
  className?: string;
}) {
  return (
    <div className={`ytm-rating-btns${className ? ` ${className}` : ''}`} data-testid="ytm-rating">
      <button
        type="button"
        className={`ytm-rating-btn${rating === 'LIKE' ? ' active' : ''}`}
        aria-pressed={rating === 'LIKE'}
        aria-label={likeLabel}
        title={likeLabel}
        data-testid="ytm-like"
        onClick={(e) => {
          e.stopPropagation();
          onLike();
        }}
      >
        <ThumbsUp size={18} fill={rating === 'LIKE' ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        className={`ytm-rating-btn${rating === 'DISLIKE' ? ' active' : ''}`}
        aria-pressed={rating === 'DISLIKE'}
        aria-label={dislikeLabel}
        title={dislikeLabel}
        data-testid="ytm-dislike"
        onClick={(e) => {
          e.stopPropagation();
          onDislike();
        }}
      >
        <ThumbsDown size={18} fill={rating === 'DISLIKE' ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}
