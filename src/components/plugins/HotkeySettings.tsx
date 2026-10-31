import { useState } from 'react';
import type { translations } from '../../i18n';
import {
  acceleratorFromEvent,
  DEFAULT_HOTKEYS,
  getHotkeyBindings,
  HOTKEY_ACTIONS,
  HotkeyAction,
  HotkeyBindings,
  prettyAccelerator,
  saveHotkeyBindings,
} from '../../plugins/globalHotkeys';

type T = (typeof translations)['en'];

export function HotkeySettings({ t }: { t: T }) {
  const [b, setB] = useState<HotkeyBindings>(getHotkeyBindings);
  const [listening, setListening] = useState<HotkeyAction | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  const tx = t as unknown as Record<string, string>;
  const name = (a: string) => tx[`hkAction_${a.replace(/-/g, '_')}`] ?? a;

  const commit = async (next: HotkeyBindings) => {
    setB(next);
    setTaken(await saveHotkeyBindings(next));
  };

  return (
    <div className="plugin-setting-col" data-testid="hotkey-settings">
      <p className="plugin-desc">{t.hkHint}</p>
      {HOTKEY_ACTIONS.map((a) => (
        <div className="plugin-setting-row hotkey-row" key={a}>
          <div className="plugin-setting-label">
            <span>{name(a)}</span>
          </div>
          <div className="hotkey-field">
            <button
              type="button"
              className={`np-cancel-btn hotkey-capture ${listening === a ? 'listening' : ''}`}
              data-testid={`hk-${a}`}
              onClick={() => setListening(a)}
              onBlur={() => setListening((l) => (l === a ? null : l))}
              onKeyDown={(e) => {
                if (listening !== a) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') {
                  setListening(null);
                  return;
                }
                const acc = acceleratorFromEvent(e);
                if (!acc) return;
                setListening(null);
                // one combo, one action
                const next = { ...b };
                for (const k of HOTKEY_ACTIONS) if (next[k] === acc) next[k] = '';
                next[a] = acc;
                void commit(next);
              }}
            >
              {listening === a ? t.hkPress : prettyAccelerator(b[a]) || t.hkNone}
            </button>
            {b[a] && (
              <button
                type="button"
                className="np-cancel-btn"
                aria-label={`${t.hkClear} ${name(a)}`}
                onClick={() => void commit({ ...b, [a]: '' })}
              >
                {t.hkClear}
              </button>
            )}
          </div>
        </div>
      ))}
      {taken.length > 0 && (
        <p className="plugin-desc">{t.hkTaken.replace('{list}', taken.map(name).join(', '))}</p>
      )}
      <div>
        <button
          type="button"
          className="np-cancel-btn"
          onClick={() => void commit({ ...DEFAULT_HOTKEYS })}
        >
          {t.hkReset}
        </button>
      </div>
    </div>
  );
}
