import { useState } from 'react';
import { translations, type Language } from '../i18n';
import { Select } from './ui/Select';

const KEY = 'zenith_panel_gap';
const SIZES = [0, 8, 16, 32, 48];

function read(): number {
  const v = Number(localStorage.getItem(KEY));
  return SIZES.includes(v) ? v : 0;
}

export function applyPanelGap(px = read()) {
  document.documentElement.style.setProperty('--panel-gap', `${px}px`);
}

// ukryty panel KDE albo pasek zadań wysuwa się po dotknięciu krawędzi i zasłania przyciski odtwarzacza
export function PanelGapSetting({ lang }: { lang: Language }) {
  const t = translations[lang];
  const [value, setValue] = useState(read);
  const choose = (px: number) => {
    setValue(px);
    localStorage.setItem(KEY, String(px));
    applyPanelGap(px);
  };
  return (
    <div className="settings-row-item settings-toggle-row">
      <div className="settings-account-info">
        <span className="setting-label">{t.panelGap}</span>
        <span className="plugin-desc">{t.panelGapDesc}</span>
      </div>
      <Select
        value={value}
        options={SIZES.map((px) => ({ value: px, label: px ? `${px} px` : t.panelGapNone }))}
        onChange={choose}
        ariaLabel={t.panelGap}
      />
    </div>
  );
}
