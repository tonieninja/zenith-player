import { markOpaqueAuxWindow } from '../utils/auxWindow';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import OverlayApp from './OverlayApp';

markOpaqueAuxWindow();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>
);
