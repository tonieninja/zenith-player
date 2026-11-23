import type { KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, Star } from 'lucide-react';
import { translations, type Language } from '../i18n';
import {
  lyricsUpgrade,
  moveSource,
  setLyricsPrefs,
  toggleSource,
  useLyricsPrefs,
  type LyricsSource,
} from '../lyrics/prefs';

export function LyricsSourcesSettings({ lang, inModal }: { lang: Language; inModal?: boolean }) {
  const t = translations[lang];
  const prefs = useLyricsPrefs();
  const upgrade = lyricsUpgrade.useValue();
  const last = prefs.order.length - 1;
  const move = (id: LyricsSource, to: number) => setLyricsPrefs(moveSource(prefs, id, to));
  // Alt+strzałki jak w kolejce: przesuwanie bez myszy
  const onKey = (e: KeyboardEvent, id: LyricsSource, i: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(id, e.key === 'ArrowUp' ? Math.max(0, i - 1) : Math.min(last, i + 1));
  };

  return (
    <div id="lyrics-sources" className={`lyrics-sources${inModal ? ' in-modal' : ''}`}>
      <div className="settings-row-item settings-toggle-row">
        <div className="settings-account-info">
          {!inModal && <span className="setting-label">{t.lyricsSources}</span>}
          <span className="plugin-desc">{t.lyricsSourcesDesc}</span>
        </div>
        <button
          type="button"
          className="lang-option-btn settings-action-btn"
          onClick={() => {
            setLyricsPrefs(null);
            lyricsUpgrade.set(true);
          }}
        >
          {t.lyricsSourcesReset}
        </button>
      </div>
      <ol className="lyrics-sources-list">
        {prefs.order.map((id, i) => {
          const on = !prefs.off.includes(id);
          return (
            <li
              key={id}
              className={`lyrics-source-row${on ? '' : ' off'}${i === 0 ? ' top' : ''}`}
              onKeyDown={(e) => onKey(e, id, i)}
            >
              <button
                type="button"
                className="lyrics-source-star"
                aria-pressed={i === 0}
                aria-label={t.lyricsSourceMakeTop.replace('{name}', id)}
                title={i === 0 ? t.lyricsSourceTop : t.lyricsSourceMakeTop.replace('{name}', id)}
                onClick={() => move(id, 0)}
              >
                <Star size={14} />
              </button>
              <span className="lyrics-source-rank">{i + 1}</span>
              <span className="lyrics-source-name">{id}</span>
              <button
                type="button"
                className="lyrics-source-move"
                disabled={i === 0}
                aria-label={`${t.lyricsSourceUp}: ${id}`}
                onClick={() => move(id, i - 1)}
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                className="lyrics-source-move"
                disabled={i === last}
                aria-label={`${t.lyricsSourceDown}: ${id}`}
                onClick={() => move(id, i + 1)}
              >
                <ChevronDown size={14} />
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={id}
                className={`plugin-toggle ${on ? 'on' : ''}`}
                onClick={() => setLyricsPrefs(toggleSource(prefs, id, !on))}
              >
                <span className="plugin-toggle-knob" />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="settings-row-item settings-toggle-row">
        <div className="settings-account-info">
          <span className="setting-label" id="set-lyrics-upgrade-label">
            {t.lyricsUpgrade}
          </span>
          <span className="plugin-desc">{t.lyricsUpgradeDesc}</span>
        </div>
        <button
          type="button"
          className={`lang-option-btn remember-login-toggle${upgrade ? ' active' : ''}`}
          aria-pressed={upgrade}
          aria-labelledby="set-lyrics-upgrade-label"
          onClick={() => lyricsUpgrade.set(!upgrade)}
        >
          {upgrade ? t.toggleOn : t.toggleOff}
        </button>
      </div>
    </div>
  );
}
