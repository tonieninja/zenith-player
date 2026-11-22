import { useState } from 'react';
import type { Track } from '../../api/youtube';
import type { translations } from '../../i18n';
import { pluginManager } from '../../plugins';
import { isBlocked, readBlocked, saveBlocked, skipCurrent } from '../../plugins/blockArtists';

type T = (typeof translations)['en'];

export function BlockArtistsSettings({ t, currentTrack }: { t: T; currentTrack?: Track | null }) {
  const [list, setList] = useState(readBlocked);
  const [draft, setDraft] = useState('');

  const update = (next: string[]) => {
    setList(next);
    saveBlocked(next);
  };
  const add = (name: string) => {
    const n = name.trim();
    if (n && !list.some((x) => x.toLowerCase() === n.toLowerCase())) update([...list, n]);
  };

  // pierwszy wykonawca bez dopisków w rodzaju „• 3M plays”
  const current = currentTrack?.artist.split(' • ')[0].split(/,| & /)[0].trim() || '';
  const blockCurrent = () => {
    add(current);
    if (pluginManager.isEnabled('block-artists')) skipCurrent();
  };

  return (
    <div className="plugin-setting-col" data-testid="block-artists-settings">
      <p className="plugin-desc">{t.baHint}</p>
      {current && !isBlocked(current, list) && (
        <div>
          <button type="button" className="np-cancel-btn" onClick={blockCurrent}>
            {t.baBlockCurrent.replace('{artist}', () => current)}
          </button>
        </div>
      )}
      <form
        className="plugin-setting-row"
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
          setDraft('');
        }}
      >
        <input
          className="settings-text-input"
          type="text"
          placeholder={t.baPlaceholder}
          aria-label={t.baPlaceholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="np-cancel-btn" disabled={!draft.trim()}>
          {t.baAdd}
        </button>
      </form>
      {list.length === 0 ? (
        <p className="plugin-desc">{t.baEmpty}</p>
      ) : (
        <ol className="plugin-mini-list">
          {list.map((name) => (
            <li key={name} className="dl-row">
              <span className="plugin-mini-list-title">{name}</span>
              <button
                type="button"
                className="np-cancel-btn"
                aria-label={`${t.baRemove} ${name}`}
                onClick={() => update(list.filter((x) => x !== name))}
              >
                {t.baRemove}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
