import { translations, type Language } from '../i18n';

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
