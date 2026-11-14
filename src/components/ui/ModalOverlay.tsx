import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
