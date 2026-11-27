// w webview window.close() zamyka całe okno aplikacji, więc żaden skrypt nie może go wywołać
window.close = () => {};

import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initAudioBackend } from './audio/engine';
import { initCoverCache } from './utils/covers';
import { initFavoritesStore } from './utils/favorites';
import { initPrefsMirror } from './utils/prefsMirror';
import { initSpotifyToken } from './api/spotify';
import { pluginManager } from './plugins';
import { rescanLocalFolders } from './components/LocalFilesSetting';
import { applyTheme } from './utils/themes';
import { applyPanelGap } from './components/PanelGapSetting';

applyPanelGap();
applyTheme();
rescanLocalFolders();

void initCoverCache();

void Promise.all([
  initAudioBackend(),
  initPrefsMirror(),
  initFavoritesStore(),
  initSpotifyToken(),
]).finally(() => {
  // pełny localStorage przy zapisie stanu wtyczek nie może zostawić pustego okna
  try {
    pluginManager.reloadFromStorage();
  } catch {
    /* wtyczki zostają przy domyślnych ustawieniach */
  }
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
});
