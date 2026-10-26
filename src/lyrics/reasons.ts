import type { Language } from '../i18n';

type Rule = {
  re: RegExp;
  en: (m: RegExpMatchArray) => string;
  pl: (m: RegExpMatchArray) => string;
};

const httpEn = (code: string) =>
  code === '404'
    ? 'Not found (HTTP 404)'
    : code === '429'
      ? 'Too many requests, try again later (HTTP 429)'
      : Number(code) >= 500
        ? `Server unavailable (HTTP ${code})`
        : `Request failed (HTTP ${code})`;

const httpPl = (code: string) =>
  code === '404'
    ? 'Nie znaleziono (HTTP 404)'
    : code === '429'
      ? 'Zbyt wiele zapytań, spróbuj później (HTTP 429)'
      : Number(code) >= 500
        ? `Serwer niedostępny (HTTP ${code})`
        : `Zapytanie nie powiodło się (HTTP ${code})`;

const RULES: Rule[] = [
  {
    re: /Musixmatch request timed out/i,
    en: () => 'Musixmatch did not answer in time',
    pl: () => 'Musixmatch nie odpowiedział na czas',
  },
  {
    re: /timed out after (\d+)\s*s/i,
    en: (m) => `Timed out after ${m[1]} s`,
    pl: (m) => `Przekroczono limit czasu (${m[1]} s)`,
  },
  {
    re: /^No lyrics found for this track$/i,
    en: () => 'No lyrics found for this track',
    pl: () => 'Nie znaleziono tekstu dla tego utworu',
  },
  {
    re: /no Lyrics tab on YouTube Music/i,
    en: () => 'This video has no lyrics on YouTube Music',
    pl: () => 'Ten utwór nie ma tekstu w YouTube Music',
  },
  {
    re: /Lyrics tab exists but returned no text/i,
    en: () => 'YouTube Music returned an empty lyrics page (possibly region-restricted)',
    pl: () => 'YouTube Music zwróciło pustą stronę tekstu (możliwa blokada regionalna)',
  },
  {
    re: /Not in the Lyrics\.ovh database/i,
    en: () => 'Not in the Lyrics.ovh database',
    pl: () => 'Brak w bazie Lyrics.ovh',
  },
  {
    re: /Empty response from/i,
    en: () => 'Empty response from the server',
    pl: () => 'Pusta odpowiedź serwera',
  },
  {
    re: /No matching track in the Musixmatch catalog/i,
    en: () => 'No matching track in the Musixmatch catalog',
    pl: () => 'Brak pasującego utworu w katalogu Musixmatch',
  },
  {
    re: /Musixmatch returned no lyrics body/i,
    en: () => 'Musixmatch found the track but returned no lyrics (restricted?)',
    pl: () => 'Musixmatch znalazł utwór, ale nie zwrócił tekstu (ograniczenia?)',
  },
  {
    re: /\(captcha\)|cooling down after a captcha|token request is cooling down/i,
    en: () => 'Musixmatch is limiting requests right now, it will retry in a few minutes',
    pl: () => 'Musixmatch chwilowo ogranicza zapytania, ponowna próba za kilka minut',
  },
  {
    re: /decoy track|restricted token/i,
    en: () => 'Musixmatch did not accept the access token',
    pl: () => 'Musixmatch nie przyjął tokenu dostępu',
  },
  {
    re: /Failed to get Musixmatch token|token\.get failed/i,
    en: () => 'Could not get a Musixmatch access token',
    pl: () => 'Nie udało się uzyskać tokenu dostępu Musixmatch',
  },
  {
    re: /Musixmatch marks this track as instrumental/i,
    en: () => 'Instrumental track (according to Musixmatch)',
    pl: () => 'Utwór instrumentalny (według Musixmatch)',
  },
  {
    re: /signature is unavailable|signature secret not found/i,
    en: () => 'Musixmatch signing secret was not found; try another lyrics provider',
    pl: () => 'Nie znaleziono sekretu podpisu Musixmatch; spróbuj innego źródła tekstów',
  },
  {
    re: /Community API unavailable/i,
    en: () => 'Community API unavailable',
    pl: () => 'API społeczności niedostępne',
  },
  {
    re: /API status (\d+)/i,
    en: (m) => (m[1] === '404' ? 'Not found (API 404)' : `API error (status ${m[1]})`),
    pl: (m) => (m[1] === '404' ? 'Nie znaleziono (API 404)' : `Błąd API (status ${m[1]})`),
  },
  {
    re: /Genius (search was )?blocked|denied automated access/i,
    en: () => 'Genius blocked this request (HTTP 403). Try another lyrics provider.',
    pl: () => 'Genius zablokował to żądanie (HTTP 403). Spróbuj innego źródła tekstów.',
  },
  {
    re: /No search result on Genius/i,
    en: () => 'No search result on Genius',
    pl: () => 'Brak wyników wyszukiwania w Genius',
  },
  {
    re: /No usable Genius result|did not return a close enough/i,
    en: () => 'No close enough match on Genius',
    pl: () => 'Brak wystarczająco podobnego wyniku w Genius',
  },
  {
    re: /Genius marks this track as instrumental/i,
    en: () => 'Instrumental track (according to Genius)',
    pl: () => 'Utwór instrumentalny (według Genius)',
  },
  {
    re: /Genius marks this track as unreleased/i,
    en: () => 'Unreleased track (according to Genius)',
    pl: () => 'Utwór niewydany (według Genius)',
  },
  {
    re: /lyrics could not be extracted/i,
    en: () => 'Lyrics page found, but the text could not be read',
    pl: () => 'Znaleziono stronę z tekstem, ale nie udało się go odczytać',
  },
  {
    re: /not signed in/i,
    en: () => 'Requires signing in',
    pl: () => 'Wymaga zalogowania',
  },
  {
    re: /Failed to fetch|NetworkError|Load failed|network|error sending request|dns|connection/i,
    en: () => 'Network error, check your connection',
    pl: () => 'Błąd sieci, sprawdź połączenie',
  },
  {
    re: /HTTP\s*(\d{3})/i,
    en: (m) => httpEn(m[1]),
    pl: (m) => httpPl(m[1]),
  },
];

function translateOne(raw: string, lang: Language): string {
  const text = raw.trim();
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) return lang === 'pl' ? rule.pl(m) : rule.en(m);
  }
  return text;
}

export function localizeLyricsReason(reason: string, lang: Language): string {
  if (!reason) return '';
  const parts = reason.match(/^(?:app|desktop) API:\s*(.*?);\s*(?:web|community) API:\s*(.*)$/i);
  if (parts) {
    const a = translateOne(parts[1], lang);
    const b = translateOne(parts[2], lang);
    if (a === b) return a;
    return lang === 'pl' ? `API aplikacji: ${a}; API strony: ${b}` : `App API: ${a}; web API: ${b}`;
  }
  return translateOne(reason, lang);
}
