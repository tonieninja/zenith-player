import { memo } from 'react';
import { MOODS_AND_MOMENTS } from '../../api/youtube';
import type { Language } from '../../i18n';
import { moodLabel } from '../../utils/pluginI18n';

export const MoodChips = memo(function MoodChips({
  activeCategory,
  onCategoryClick,
  lang,
  t,
}: {
  activeCategory: string | null;
  onCategoryClick: (id: string, browseId: string) => void;
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
      </div>
    </div>
  );
});
