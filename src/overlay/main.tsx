import { markOpaqueAuxWindow } from '../utils/auxWindow';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../components/ErrorBoundary';
import OverlayApp from './OverlayApp';

markOpaqueAuxWindow();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <OverlayApp />
    </ErrorBoundary>
  </StrictMode>
);
