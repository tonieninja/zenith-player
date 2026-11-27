import { useState } from 'react';
import { translations, type Language } from '../i18n';
import { applyTheme, currentTheme, THEMES } from '../utils/themes';
import { applyAppearance, currentAppearance, type Appearance } from '../utils/appearance';
import { Select } from './ui/Select';

function AppearanceSetting({ lang }: { lang: Language }) {
  const t = translations[lang];
  const [mode, setMode] = useState(currentAppearance);
  return (
    <div className="settings-row-item settings-toggle-row">
      <div className="settings-account-info">
        <span className="setting-label">{t.appearanceTitle}</span>
        <span className="plugin-desc">{t.appearanceDesc}</span>
      </div>
      <Select<Appearance>
        value={mode}
        options={[
          { value: 'dark', label: t.appearanceDark },
          { value: 'light', label: t.appearanceLight },
          { value: 'system', label: t.appearanceSystem },
        ]}
        onChange={(m) => {
          setMode(m);
          applyAppearance(m);
        }}
        ariaLabel={t.appearanceTitle}
      />
    </div>
  );
}

export function ThemeSetting({ lang }: { lang: Language }) {
  const t = translations[lang];
  const [id, setId] = useState(() => currentTheme().id);
  return (
    <>
      <AppearanceSetting lang={lang} />
      <div className="settings-row-item settings-toggle-row">
        <div className="settings-account-info">
          <span className="setting-label">{t.themeTitle}</span>
          <span className="plugin-desc">{t.themeDesc}</span>
        </div>
        <div className="theme-swatches" role="radiogroup" aria-label={t.themeTitle}>
          {THEMES.map((th) => (
            <button
              key={th.id}
              type="button"
              role="radio"
              aria-checked={th.id === id}
              aria-label={th[lang]}
              title={th[lang]}
              className={`theme-swatch${th.id === id ? ' active' : ''}`}
              style={{ background: `linear-gradient(135deg, ${th.accent}, ${th.accent3})` }}
              onClick={() => {
                setId(th.id);
                applyTheme(th.id);
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
