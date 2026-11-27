import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

function enabledItems(list: HTMLElement | null): HTMLElement[] {
  return Array.from(
    list?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []
  );
}

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

// null dla klawiszy, które nie przesuwają fokusu; strzałki zawijają się na końcach listy
export function menuKeyIndex(key: string, current: number, count: number): number | null {
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return null;
  if (key === 'Home' || !count) return 0;
  if (key === 'End' || (current < 0 && key === 'ArrowUp')) return count - 1;
  return (current + (key === 'ArrowDown' ? 1 : -1) + count) % count;
}

// przy dolnej krawędzi menu otwiera się w górę od kursora, jak systemowe, i nie wchodzi na pasek odtwarzacza
export function contextMenuCoords(
  x: number,
  y: number,
  size: { width: number; height: number },
  area: { width: number; bottom: number }
): { left: number; top: number } {
  const left = Math.max(8, Math.min(x, area.width - size.width - 8));
  const top =
    y + size.height + 8 <= area.bottom
      ? y
      : Math.max(8, Math.min(y - size.height, area.bottom - size.height - 8));
  return { left, top };
}

export function PopoverMenu({
  trigger,
  items,
  ariaLabel,
  className = '',
  emptyLabel,
  align = 'right',
  triggerClassName = '',
  header,
  onOpen,
}: {
  trigger: ReactNode;
  items: PopoverItem[];
  ariaLabel: string;
  className?: string;
  emptyLabel?: string;
  align?: 'left' | 'right';
  triggerClassName?: string;
  header?: ReactNode;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const place = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    setCoords(popoverMenuCoords(r, items.length, align));
  }, [items.length, align]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    place();
  }, [open, place]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    // faza przechwytywania: okno pod spodem (np. menedżer playlist) ma zobaczyć defaultPrevented
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place, close]);

  const shown = open && coords !== null;
  useEffect(() => {
    if (shown) enabledItems(listRef.current)[0]?.focus();
  }, [shown]);

  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const els = enabledItems(listRef.current);
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next = menuKeyIndex(e.key, i, els.length);
    if (next !== null) {
      e.preventDefault();
      els[next]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els[i]?.click();
    } else if (e.key === 'Tab') {
      // bez preventDefault: Tab przechodzi dalej od przycisku menu, jak przy zwykłym przycisku
      close();
    }
  };

  const list =
    open && coords ? (
      <ul
        ref={listRef}
        className="zen-select-list zen-popover-menu-list"
        role="menu"
        aria-label={ariaLabel}
        data-zen-popover-menu="true"
        onKeyDown={onListKey}
        style={{
          position: 'fixed',
          // arkusz ustawia top pod przyciskiem, a z nim i bottom lista otwarta w górę ma zero wysokości
          top: coords.dropUp ? 'auto' : coords.top,
          bottom: coords.dropUp ? coords.bottom : undefined,
          left: coords.left,
          right: 'auto',
          minWidth: coords.minWidth,
        }}
      >
        {header && (
          <li className="zen-popover-header" role="presentation">
            {header}
          </li>
        )}
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
              close();
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
        ref={triggerRef}
        type="button"
        className={`zen-popover-trigger ${triggerClassName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) onOpen?.();
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
