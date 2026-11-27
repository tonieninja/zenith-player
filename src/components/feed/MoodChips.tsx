import { memo, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { MOODS_AND_MOMENTS, type HomeChip } from '../../api/youtube';
import type { Language } from '../../i18n';
import { moodLabel } from '../../i18n/plugins';

export const MoodChips = memo(function MoodChips({
  chips,
  activeCategory,
  onCategoryClick,
  onMore,
  lang,
  t,
}: {
  chips: HomeChip[];
  activeCategory: string | null;
  onCategoryClick: (id: string, browseId: string, title?: string) => void;
  onMore: () => void;
  lang: Language;
  t: Record<string, string>;
}) {
  // sztywna lista tylko wtedy, gdy Główna jeszcze nie przyszła albo YTM nie dał chipów
  const items = useMemo<HomeChip[]>(
    () =>
      chips.length
        ? chips
        : MOODS_AND_MOMENTS.slice(0, 10).map((cat) => ({
            id: cat.browseId,
            title: moodLabel(lang, cat.id, cat.title, t),
            browseId: cat.browseId,
          })),
    [chips, lang, t]
  );
  return (
    <div className="mood-chips-container">
      <div className="mood-chips-scroll">
        {items.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`mood-chip ${activeCategory === chip.id ? 'active' : ''}`}
            onClick={() => onCategoryClick(chip.id, chip.browseId, chip.title)}
          >
            <span className="mood-chip-label">{chip.title}</span>
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
