import { translations, type Language } from '../i18n';

export function currentLang(): Language {
  return localStorage.getItem('zenith_lang') === 'pl' ? 'pl' : 'en';
}

export function currentT() {
  return translations[currentLang()];
}
