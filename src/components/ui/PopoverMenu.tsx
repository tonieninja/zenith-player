import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type PopoverItem = {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export type PopoverCoords = {
  left: number;
  top?: number;
  bottom?: number;
  minWidth: number;
  dropUp: boolean;
};

export function popoverMenuCoords(
  anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width'>,
  itemCount: number,
  align: 'left' | 'right',
  viewport: Pick<Window, 'innerWidth' | 'innerHeight'> = window
): PopoverCoords {
  const minWidth = Math.max(anchor.width, 200);
  const estHeight = Math.min(260, Math.max(1, itemCount) * 36 + 16);
  const dropUp = viewport.innerHeight - anchor.bottom < estHeight + 8;
  let left = align === 'left' ? anchor.left : anchor.right - minWidth;
  left = Math.max(8, Math.min(left, viewport.innerWidth - minWidth - 8));
  if (dropUp) {
    return { left, bottom: viewport.innerHeight - anchor.top + 6, minWidth, dropUp };
  }
  return { left, top: anchor.bottom + 6, minWidth, dropUp };
}

export function PopoverMenu({
  trigger,
  items,
  ariaLabel,
  className = '',
  emptyLabel,
  align = 'right',
  triggerClassName = '',
}: {
  trigger: ReactNode;
  items: PopoverItem[];
  ariaLabel: string;
  className?: string;
  emptyLabel?: string;
  align?: 'left' | 'right';
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const place = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    setCoords(popoverMenuCoords(r, items.length, align));
  };

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    place();
  }, [open, items.length, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, items.length, align]);

  const list =
    open && coords ? (
      <ul
        ref={listRef}
        className="zen-select-list zen-popover-menu-list"
        role="menu"
        aria-label={ariaLabel}
        data-zen-popover-menu="true"
        style={{
          position: 'fixed',
          top: coords.dropUp ? undefined : coords.top,
          bottom: coords.dropUp ? coords.bottom : undefined,
          left: coords.left,
          right: 'auto',
          minWidth: coords.minWidth,
        }}
      >
        {items.length === 0 && emptyLabel && (
          <li className="zen-select-option is-empty" role="presentation">
            {emptyLabel}
          </li>
        )}
        {items.map((item) => (
          <li
            key={item.key}
            role="menuitem"
            aria-disabled={item.disabled}
            tabIndex={-1}
            className={`zen-select-option${item.danger ? ' danger' : ''}${
              item.disabled ? ' disabled' : ''
            }`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              if (item.disabled) return;
              setOpen(false);
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    ) : null;

  return (
    <div
      ref={rootRef}
      className={`zen-select zen-popover ${open ? 'open' : ''} ${coords?.dropUp ? 'drop-up' : ''} ${
        align === 'left' ? 'align-left' : ''
      } ${className}`}
    >
      <button
        type="button"
        className={`zen-popover-trigger ${triggerClassName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          if (!open && rootRef.current) {
            setCoords(
              popoverMenuCoords(rootRef.current.getBoundingClientRect(), items.length, align)
            );
          }
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </button>
      {list && createPortal(list, document.body)}
    </div>
  );
}
