import { memo, useEffect, useMemo, useState } from 'react';
import {
  GENRES,
  getMoodGroups,
  MOODS_AND_MOMENTS,
  peekMoodGroups,
  type MoodGroup,
} from '../../api/youtube';
import type { Language } from '../../i18n';
import { moodLabel } from '../../i18n/plugins';
import { clickOnKey } from '../ui/keyboard';

export const MoodsGenresView = memo(function MoodsGenresView({
  onCategoryClick,
  t,
  lang,
}: {
  onCategoryClick: (id: string, browseId: string, title?: string) => void;
  t: Record<string, string>;
  lang: Language;
}) {
  const [live, setLive] = useState<{ lang: Language; groups: MoodGroup[] | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void getMoodGroups(lang).then((groups) => {
      if (alive) setLive({ lang, groups });
    });
    return () => {
      alive = false;
    };
  }, [lang]);

  const fallback = useMemo<MoodGroup[]>(
    () =>
      [
        { title: t.moodsMoments, cats: MOODS_AND_MOMENTS },
        { title: t.genres, cats: GENRES },
      ].map(({ title, cats }) => ({
        title,
        items: cats.map((c) => ({
          id: c.browseId,
          title: moodLabel(lang, c.id, c.title, t),
          browseId: c.browseId,
          color: c.color,
        })),
      })),
    [lang, t]
  );
  // sztywna lista tylko po błędzie; wcześniej podmiana nazw i grupy „Dla Ciebie” przesuwałaby kafelki
  const answered = live?.lang === lang ? live : null;
  const groups = answered ? (answered.groups ?? fallback) : peekMoodGroups(lang);

  return (
    <div className="explore-view-wrapper moods-genres-page">
      <h2 className="moods-genres-heading">{t.moodsAndGenres}</h2>
      {groups?.map((group, gi) => (
        <div key={`${group.title}-${gi}`}>
          <h3
            className={
              'moods-genres-subheading' + (gi > 0 ? ' moods-genres-subheading--spaced' : '')
            }
          >
            {group.title}
          </h3>
          <div className="mood-genre-grid">
            {group.items.map((cat) => (
              <div
                key={cat.id}
                className="mood-genre-card"
                style={{ '--card-color': cat.color } as React.CSSProperties}
                role="button"
                tabIndex={0}
                onClick={() => onCategoryClick(cat.id, cat.browseId, cat.title)}
                onKeyDown={clickOnKey}
              >
                {cat.title}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});
