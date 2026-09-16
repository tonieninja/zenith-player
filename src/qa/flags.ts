/** qa flags, prod builds leave this off */

export function isQaEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_ZENITH_QA === '1';
}

/** auto suite after splash: '' | smoke | full | social | release */
export function qaAutoMode(): '' | 'smoke' | 'full' | 'social' | 'release' {
  if (!isQaEnabled()) return '';
  const raw = String(import.meta.env.VITE_ZENITH_QA_AUTO || '').toLowerCase();
  if (raw === 'smoke' || raw === 'full' || raw === 'social' || raw === 'release') return raw;
  // dev default: dont auto-run, poke window.__zenithQA yourself
  return '';
}
