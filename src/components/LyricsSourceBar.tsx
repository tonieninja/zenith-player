import { useEffect, useRef } from 'react';
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
  const listRef = useRef<HTMLDivElement>(null);
  const shown = !loading && lyrics?.provider && lyrics.provider !== 'Auto' ? lyrics.provider : null;
  const title = shown ?? (selected === 'Auto' ? t.lyrics : selected);
  const missed = new Map((lyrics?.failures ?? []).map((f) => [f.provider, f.reason]));
  const cycle = (dir: 1 | -1) => {
    const i = Math.max(0, providers.indexOf(selected));
    onSelect(providers[(i + dir + providers.length) % providers.length]);
  };

  useEffect(() => {
    const list = listRef.current;
    const chip = list?.querySelector<HTMLElement>('.lyrics-provider-pill.active');
    if (!list || !chip) return;
    // tylko w poziomie: scrollIntoView przewijałby też panel z tekstem
    list.scrollLeft = chip.offsetLeft - (list.clientWidth - chip.offsetWidth) / 2;
  }, [selected]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // pasek przewijania jest ukryty, więc kółko myszy przesuwa chipy w bok zamiast panelu
    const onWheel = (e: WheelEvent) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      list.scrollLeft += e.deltaY;
    };
    list.addEventListener('wheel', onWheel, { passive: false });
    return () => list.removeEventListener('wheel', onWheel);
  }, []);

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
      </div>
      <div className="lyrics-provider-list" ref={listRef}>
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
        <button
          type="button"
          className="lyrics-provider-pill lyrics-provider-manage"
          aria-label={t.lyricsSourcesManage}
          title={t.lyricsSourcesManage}
          onClick={onManage}
        >
          <Settings2 size={13} />
        </button>
      </div>
    </>
  );
}
