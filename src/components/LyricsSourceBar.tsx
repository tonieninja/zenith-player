import { ChevronLeft, ChevronRight, Settings2, Star } from 'lucide-react';
import type { LyricsProvider, LyricsResult } from '../api/youtube';
import { translations, type Language } from '../i18n';
import { localizeLyricsReason } from '../lyrics/reasons';

type Props = {
  providers: LyricsProvider[];
  selected: LyricsProvider;
  lyrics: LyricsResult | null;
  loading: boolean;
  top?: LyricsProvider;
  lang: Language;
  onSelect: (p: LyricsProvider) => void;
  onManage: () => void;
};

export function LyricsSourceBar({
  providers,
  selected,
  lyrics,
  loading,
  top,
  lang,
  onSelect,
  onManage,
}: Props) {
  const t = translations[lang];
  const shown = !loading && lyrics?.provider && lyrics.provider !== 'Auto' ? lyrics.provider : null;
  const title = shown ?? (selected === 'Auto' ? t.lyrics : selected);
  const missed = new Map((lyrics?.failures ?? []).map((f) => [f.provider, f.reason]));
  const cycle = (dir: 1 | -1) => {
    const i = Math.max(0, providers.indexOf(selected));
    onSelect(providers[(i + dir + providers.length) % providers.length]);
  };

  return (
    <>
      <div className="lyrics-provider-header">
        <button
          className="lyrics-provider-nav"
          onClick={() => cycle(-1)}
          aria-label={t.lyricsPrevSource}
          title={t.lyricsPrevSource}
        >
          <ChevronLeft size={16} />
        </button>
        <div className="lyrics-provider-heading" aria-live="polite">
          <div key={title} className="lyrics-provider-title">
            {shown && shown === top && (
              <Star size={12} className="lyrics-provider-star" aria-label={t.lyricsSourceTop} />
            )}
            {title}
          </div>
          {shown && lyrics?.upgradedFrom && (
            <div className="lyrics-provider-caption">
              {t.lyricsSwitchedFrom.replace('{from}', lyrics.upgradedFrom)}
            </div>
          )}
        </div>
        <button
          className="lyrics-provider-nav"
          onClick={() => cycle(1)}
          aria-label={t.lyricsNextSource}
          title={t.lyricsNextSource}
        >
          <ChevronRight size={16} />
        </button>
        {/* poza rzędem chipów, żeby w wąskim oknie nie trzeba było go szukać na końcu przewijania */}
        <button
          type="button"
          className="lyrics-provider-nav lyrics-provider-manage"
          aria-label={t.lyricsSourcesManage}
          title={t.lyricsSourcesManage}
          onClick={onManage}
        >
          <Settings2 size={15} />
        </button>
      </div>
      <div className="lyrics-provider-list">
        {providers.map((p) => {
          const inUse = selected === 'Auto' && p === shown;
          const reason = missed.get(p);
          return (
            <button
              key={p}
              type="button"
              className={`lyrics-provider-pill${selected === p ? ' active' : ''}${inUse ? ' in-use' : ''}${reason ? ' no-result' : ''}`}
              aria-pressed={selected === p}
              title={
                reason ? localizeLyricsReason(reason, lang) : inUse ? t.lyricsInUse : undefined
              }
              onClick={() => onSelect(p)}
            >
              {p === top && <Star size={10} className="lyrics-provider-star" aria-hidden />}
              {p}
            </button>
          );
        })}
      </div>
    </>
  );
}
