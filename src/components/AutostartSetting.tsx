import { useEffect, useId, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { translations, type Language } from '../i18n';

type State = { enabled: boolean; minimized: boolean };

function Toggle({
  label,
  desc,
  on,
  onChange,
}: {
  label: string;
  desc: string;
  on: boolean;
  onChange: () => void;
}) {
  const id = useId();
  return (
    <div className="settings-row-item settings-toggle-row">
      <div className="settings-account-info">
        <span className="setting-label" id={id}>
          {label}
        </span>
        <span className="plugin-desc">{desc}</span>
      </div>
      <button
        type="button"
        role="switch"
        className={`plugin-toggle${on ? ' on' : ''}`}
        aria-checked={on}
        aria-labelledby={id}
        onClick={onChange}
      >
        <span className="plugin-toggle-knob" />
      </button>
    </div>
  );
}

// stan czytany z systemu (rejestr, ~/.config/autostart, LaunchAgents), bo użytkownik mógł go zmienić poza aplikacją
export function AutostartSetting({ lang }: { lang: Language }) {
  const t = translations[lang];
  const [state, setState] = useState<State | null>(null);
  const [tray, setTray] = useState(false);
  useEffect(() => {
    void invoke<State | null>('autostart_get')
      .then(setState)
      .catch(() => undefined);
    void invoke<boolean>('tray_available')
      .then((v) => setTray(!!v))
      .catch(() => undefined);
  }, []);
  if (!state) return null;
  const set = (enabled: boolean, minimized: boolean) =>
    void invoke<State>('autostart_set', { enabled, minimized })
      .catch(() => invoke<State>('autostart_get'))
      .then(setState, () => undefined);
  return (
    <>
      <Toggle
        label={t.autostartTitle}
        desc={t.autostartDesc}
        on={state.enabled}
        onChange={() => set(!state.enabled, state.minimized)}
      />
      {tray && state.enabled && (
        <Toggle
          label={t.autostartMinimized}
          desc={t.autostartMinimizedDesc}
          on={state.minimized}
          onChange={() => set(true, !state.minimized)}
        />
      )}
    </>
  );
}
