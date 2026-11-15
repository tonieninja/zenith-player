import { useEffect, useId, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const stack: HTMLElement[] = [];

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[aria-hidden="true"]')
  );
}

export function ModalOverlay({
  children,
  onClick,
  className = '',
  testId = 'global-modal-overlay',
}: {
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    stack.push(el);
    const heading = el.querySelector('h1, h2, h3');
    if (heading) {
      if (!heading.id) heading.id = titleId;
      el.setAttribute('aria-labelledby', heading.id);
    }
    let before = document.activeElement as HTMLElement | null;
    // okno otwarte w pointerdown: mousedown oddaje potem fokus przyciskowi pod spodem, więc czekamy
    const timer = window.setTimeout(() => {
      if (el.contains(document.activeElement)) return;
      before = document.activeElement as HTMLElement | null;
      (focusables(el)[0] ?? el).focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || stack[stack.length - 1] !== el) return;
      const list = focusables(el);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (!el.contains(active) || (e.shiftKey ? active === first : active === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(el), 1);
      // nie zabieramy fokusu, jeśli w tym samym renderze dostał go już inny element (np. autoFocus)
      const lost = document.activeElement === document.body || el.contains(document.activeElement);
      if (lost && before?.isConnected && before !== document.body) before.focus();
    };
  }, [titleId]);

  return createPortal(
    <div
      ref={ref}
      className={`global-modal-overlay${className ? ` ${className}` : ''}`}
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      onClick={onClick}
    >
      {children}
    </div>,
    document.body
  );
}
