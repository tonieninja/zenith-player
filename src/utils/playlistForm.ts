const TITLE_MAX = 150;
const DESC_MAX = 5000;

export function committedPlaylistTitle(stateValue: string, inputValue?: string | null): string {
  const fromInput = (inputValue ?? '').trim();
  if (fromInput) return fromInput.slice(0, TITLE_MAX);
  return (stateValue ?? '').trim().slice(0, TITLE_MAX);
}

export function committedPlaylistDescription(
  stateValue: string,
  inputValue?: string | null
): string {
  const raw = (inputValue ?? stateValue ?? '').slice(0, DESC_MAX);
  return raw;
}

export function isCommitKey(e: { key: string; isComposing?: boolean; keyCode?: number }): boolean {
  if (e.key !== 'Enter') return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}
