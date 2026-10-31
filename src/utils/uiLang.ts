import { translations, type Language } from '../i18n';

/** for small leaf components that do not get `t` passed down (aria labels and such) */
export function currentLang(): Language {
  try {
    return localStorage.getItem('zenith_lang') === 'pl' ? 'pl' : 'en';
  } catch {
    return 'en';
  }
}

export function currentT() {
  return translations[currentLang()];
}
