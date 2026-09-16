import { memo } from 'react';
import { GENRES, MOODS_AND_MOMENTS } from '../../api/youtube';
import type { Language } from '../../i18n';
import { moodLabel } from '../../utils/pluginI18n';

export const MoodsGenresView = memo(function MoodsGenresView({
  onCategoryClick,
  t,
  lang,
}: {
  onCategoryClick: (id: string, browseId: string) => void;
  t: Record<string, string>;
  lang: Language;
}) {
  return (
    <div className="explore-view-wrapper moods-genres-page">
      <h2 className="moods-genres-heading">{t.moodsAndGenres}</h2>

      <h3 className="moods-genres-subheading">{t.moodsMoments}</h3>
      <div className="mood-genre-grid">
        {MOODS_AND_MOMENTS.map((cat) => (
          <div
            key={cat.id}
            className="mood-genre-card"
            style={{ '--card-color': cat.color } as React.CSSProperties}
            onClick={() => onCategoryClick(cat.id, cat.browseId)}
          >
            {moodLabel(lang, cat.id, cat.title, t)}
          </div>
        ))}
      </div>

      <h3 className="moods-genres-subheading moods-genres-subheading--spaced">{t.genres}</h3>
      <div className="mood-genre-grid">
        {GENRES.map((cat) => (
          <div
            key={cat.id}
            className="mood-genre-card"
            style={{ '--card-color': cat.color } as React.CSSProperties}
            onClick={() => onCategoryClick(cat.id, cat.browseId)}
          >
            {cat.title}
          </div>
        ))}
      </div>
    </div>
  );
});
