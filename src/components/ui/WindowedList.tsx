import type { ReactNode } from 'react';
import { useWindowedList } from '../../hooks/useWindowedList';

/** a plain <div className> list that only mounts the visible rows once it gets long */
export function WindowedList({
  count,
  className,
  renderRow,
}: {
  count: number;
  className: string;
  renderRow: (index: number) => ReactNode;
}) {
  const w = useWindowedList(count);
  const rows: ReactNode[] = [];
  for (let i = w.start; i < w.end; i += 1) rows.push(renderRow(i));
  return (
    <div className={className} ref={w.listRef}>
      {w.padTop > 0 && (
        <div data-vspacer="" aria-hidden="true" style={{ height: w.padTop, flexShrink: 0 }} />
      )}
      {rows}
      {w.padBottom > 0 && (
        <div data-vspacer="" aria-hidden="true" style={{ height: w.padBottom, flexShrink: 0 }} />
      )}
    </div>
  );
}
