import { memo } from 'react';
import { Loader2 } from 'lucide-react';
import type { RadioChip } from '../../api/youtube';

/** busy: indeks przełącznika, dla którego właśnie wczytuje się nowa kolejka. */
export type RadioState = {
  chips: RadioChip[];
  active: number;
  busy: number | null;
  tuned: boolean;
};

export const RadioChips = memo(function RadioChips({
  radio,
  label,
  onTune,
}: {
  radio: RadioState | null;
  label: string;
  onTune: (index: number) => void;
}) {
  if (!radio) return null;
  return (
    <div
      className="mood-chips-scroll radio-chips"
      role="group"
      aria-label={label}
      aria-busy={radio.busy !== null}
    >
      {radio.chips.map((chip, i) => (
        <button
          key={`${chip.playlistId}-${i}`}
          type="button"
          className={`mood-chip${i === radio.active ? ' active' : ''}`}
          aria-pressed={i === radio.active}
          onClick={() => onTune(i)}
        >
          {radio.busy === i && <Loader2 size={13} className="spin-icon" aria-hidden />}
          <span className="mood-chip-label">{chip.label}</span>
        </button>
      ))}
    </div>
  );
});
