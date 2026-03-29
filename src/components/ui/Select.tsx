import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export type SelectOption<T extends string | number> = { value: T; label: string };

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [maxH, setMaxH] = useState(240);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value)
    )
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value)
      )
    );
    const root = rootRef.current;
    if (root) {
      let box: { top: number; bottom: number } = { top: 0, bottom: window.innerHeight };
      for (let el = root.parentElement; el; el = el.parentElement) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'hidden') {
          box = el.getBoundingClientRect();
          break;
        }
      }
      const r = root.getBoundingClientRect();
      const below = box.bottom - r.bottom - 8;
      const above = r.top - box.top - 8;
      const wanted = Math.min(240, options.length * 34 + 12);
      const up = below < wanted && above > below;
      setDropUp(up);
      setMaxH(Math.max(120, Math.min(240, up ? above : below)));
    }
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [open, options, value]);

  const pick = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt) return;
      onChange(opt.value);
      setOpen(false);
    },
    [onChange, options]
  );

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + dir + options.length) % options.length);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open) pick(active);
      else setOpen(true);
    }
  };

  return (
    <div
      ref={rootRef}
      className={`zen-select ${open ? 'open' : ''} ${dropUp ? 'drop-up' : ''} ${className}`}
      onKeyDown={onKey}
    >
      <button
        type="button"
        className="zen-select-trigger settings-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="zen-select-value">{current?.label}</span>
        <ChevronDown size={14} className="zen-select-chevron" />
      </button>
      {open && (
        <ul
          className="zen-select-list"
          role="listbox"
          id={listId}
          aria-label={ariaLabel}
          style={{ maxHeight: maxH }}
        >
          {options.map((opt, idx) => (
            <li
              key={String(opt.value)}
              role="option"
              aria-selected={opt.value === value}
              className={`zen-select-option${idx === active ? ' active' : ''}${
                opt.value === value ? ' selected' : ''
              }`}
              onMouseEnter={() => setActive(idx)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(idx)}
            >
              <span>{opt.label}</span>
              {opt.value === value && <Check size={14} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
