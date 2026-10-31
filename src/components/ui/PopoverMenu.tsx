import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type PopoverItem = {
  key: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * small themed action menu (same look as the Select list). closes on outside click,
 * Escape (without closing the surrounding modal) and after picking an item
 */
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
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (r) setDropUp(window.innerHeight - r.bottom < Math.min(260, items.length * 36 + 16));
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, items.length]);

  return (
    <div
      ref={rootRef}
      className={`zen-select zen-popover ${open ? 'open' : ''} ${dropUp ? 'drop-up' : ''} ${
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
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </button>
      {open && (
        <ul className="zen-select-list" role="menu" aria-label={ariaLabel}>
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
      )}
    </div>
  );
}
