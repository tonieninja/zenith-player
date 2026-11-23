import { memo } from 'react';
import { ChevronRight } from 'lucide-react';
import { MOODS_AND_MOMENTS } from '../../api/youtube';
import type { Language } from '../../i18n';
import { moodLabel } from '../../i18n/plugins';

export const MoodChips = memo(function MoodChips({
  activeCategory,
  onCategoryClick,
  onMore,
  lang,
  t,
}: {
  activeCategory: string | null;
  onCategoryClick: (id: string, browseId: string) => void;
  onMore: () => void;
  lang: Language;
  t: Record<string, string>;
}) {
  const items = MOODS_AND_MOMENTS.slice(0, 10);
  return (
    <div className="mood-chips-container">
      <div className="mood-chips-scroll">
        {items.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`mood-chip ${activeCategory === cat.id ? 'active' : ''}`}
            onClick={() => onCategoryClick(cat.id, cat.browseId)}
          >
            <span className="mood-chip-label">{moodLabel(lang, cat.id, cat.title, t)}</span>
          </button>
        ))}
        <button type="button" className="mood-chip mood-chip-more" onClick={onMore}>
          <span className="mood-chip-label">{t.moodsAndGenres}</span>
          <ChevronRight size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
});
