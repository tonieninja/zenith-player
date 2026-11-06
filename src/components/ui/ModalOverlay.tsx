import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * full-screen modal layer portaled to document.body so
 * `.zenith-app { overflow: clip }` + backdrop-filter cannot swallow it
 * (WebKitGTK paints those overlays as invisible otherwise).
 */
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
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={`global-modal-overlay${className ? ` ${className}` : ''}`}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </div>,
    document.body
  );
}
