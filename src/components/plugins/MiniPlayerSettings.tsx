import type { translations } from '../../i18n';
import type { StoredFlag } from '../../lyrics/flag';
import { miniHidden, miniLyrics, MINI_PARTS, type MiniPart } from '../../plugins/miniPlayer';

type T = (typeof translations)['en'];

const PART_LABEL: Record<MiniPart, keyof T> = {
  play: 'miniShowPlay',
  seek: 'miniShowSeek',
  like: 'miniShowLike',
  prev: 'miniShowPrev',
  next: 'miniShowNext',
};

export function FlagRow({
  flag,
  inverted = false,
  label,
  desc,
}: {
  flag: StoredFlag;
  inverted?: boolean;
  label: string;
  desc?: string;
}) {
  const value = flag.useValue();
  const on = inverted ? !value : value;
  return (
    <div className="plugin-setting-row">
      <div className="plugin-setting-label">
        <span>{label}</span>
        {desc && <span className="plugin-desc">{desc}</span>}
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`plugin-toggle ${on ? 'on' : ''}`}
        onClick={() => flag.set(inverted ? on : !on)}
      >
        <span className="plugin-toggle-knob" />
      </button>
    </div>
  );
}

export function MiniPlayerSettings({ t }: { t: T }) {
  return (
    <div className="plugin-setting-col" data-testid="mini-player-settings">
      <FlagRow flag={miniLyrics} label={t.miniLyrics} desc={t.miniLyricsDesc} />
      {MINI_PARTS.map((p) => (
        <FlagRow key={p} flag={miniHidden[p]} inverted label={t[PART_LABEL[p]]} />
      ))}
    </div>
  );
}
