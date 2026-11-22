import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { translations, type Language } from '../i18n';
import { OUTPUT_DEVICE_KEY } from '../audio/engine';
import { Select } from './ui/Select';

const SYSTEM = '';

export function AudioOutputSettings({ lang }: { lang: Language }) {
  const t = translations[lang];
  const [devices, setDevices] = useState<string[] | null>(null);
  const [value, setValue] = useState(() => localStorage.getItem(OUTPUT_DEVICE_KEY) ?? SYSTEM);

  useEffect(() => {
    let alive = true;
    invoke<string[]>('zaudio_output_devices')
      .catch(() => [])
      .then((d) => alive && setDevices(d));
    return () => {
      alive = false;
    };
  }, []);

  const choose = (name: string) => {
    setValue(name);
    if (name) localStorage.setItem(OUTPUT_DEVICE_KEY, name);
    else localStorage.removeItem(OUTPUT_DEVICE_KEY);
    void invoke('zaudio_set_output_device', { name: name || null });
  };

  const names = devices ?? [];
  // odłączone urządzenie zostaje na liście z dopiskiem, żeby zapisany wybór nie znikał po cichu
  const missing = devices !== null && value !== SYSTEM && !names.includes(value);
  const options = [
    { value: SYSTEM, label: t.audioOutputSystem },
    ...names.map((n) => ({ value: n, label: n })),
    ...(missing ? [{ value, label: `${value} (${t.audioOutputMissing})` }] : []),
  ];

  return (
    <div className="settings-row-item settings-toggle-row">
      <div className="settings-account-info">
        <span className="setting-label">{t.audioOutput}</span>
        <span className="plugin-desc">{t.audioOutputDesc}</span>
      </div>
      <Select value={value} options={options} onChange={choose} ariaLabel={t.audioOutput} />
    </div>
  );
}
