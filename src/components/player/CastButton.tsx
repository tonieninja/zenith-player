import { Cast, Loader2 } from 'lucide-react';
import { PopoverMenu, type PopoverItem } from '../ui/PopoverMenu';
import type { CastDevice, CastStatus } from '../../hooks/useCast';

export function CastButton({
  status,
  devices,
  scanning,
  onScan,
  onPick,
  onStop,
  t,
}: {
  status: CastStatus | null;
  devices: CastDevice[];
  scanning: boolean;
  onScan: () => void;
  onPick: (device: CastDevice) => void;
  onStop: () => void;
  t: Record<string, string>;
}) {
  const casting = status !== null;
  const label = casting ? t.castingTo.replace('{device}', status.device) : t.castTo;
  const items: PopoverItem[] = devices
    .filter((d) => d.name !== status?.device)
    .map((d) => ({ key: d.id, label: d.name, onSelect: () => onPick(d) }));
  if (casting) items.push({ key: 'stop', label: t.castStop, danger: true, onSelect: onStop });
  const header = scanning ? (
    <>
      <Loader2 size={14} className="spin-icon" aria-hidden />
      <span>{t.castSearching}</span>
    </>
  ) : casting ? (
    <span>{label}</span>
  ) : null;
  return (
    <PopoverMenu
      className="cast-popover"
      triggerClassName={`extra-icon-btn cast-btn${casting ? ' active' : ''}`}
      ariaLabel={label}
      trigger={<Cast size={20} />}
      items={items}
      header={header}
      emptyLabel={scanning ? undefined : t.castNoDevices}
      onOpen={onScan}
    />
  );
}
