/** last.fm / backend error -> a sentence in the app language (the raw text is kept in
 * brackets for the codes we don't know) */
export function lastfmErrorText(raw: string, t: Record<string, string>): string {
  const code = /last\.fm (\d+)/.exec(raw)?.[1];
  const byCode: Record<string, string> = {
    '4': t.lfmErrAuth,
    '9': t.lfmErrSession,
    '10': t.lfmErrKey,
    '13': t.lfmErrSecret,
    '14': t.lfmErrNotApproved,
    '15': t.lfmErrExpired,
    '11': t.lfmErrOffline,
    '16': t.lfmErrOffline,
    '29': t.lfmErrRate,
  };
  if (code && byCode[code]) return byCode[code];
  if (/32 hex/.test(raw)) return t.lfmErrFormat;
  if (/set the API key first/.test(raw)) return t.lfmErrNoKey;
  if (/start the connection first/.test(raw)) return t.lfmErrNoPending;
  if (/not connected/.test(raw)) return t.lfmErrNotConnected;
  if (/timed out|error sending request|dns|connect/i.test(raw)) return t.lfmErrNetwork;
  return `${t.lfmErrOther} (${raw})`;
}
