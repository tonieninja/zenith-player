// w webview window.close() zamyka całe okno aplikacji, więc żaden skrypt nie może go wywołać
try {
  window.close = () => {};
} catch {}

import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initAudioBackend } from './audio/engine';
import { initCoverCache } from './utils/imgError';
import { initFavoritesStore } from './utils/favorites';
import { initPrefsMirror } from './utils/prefsMirror';
import { pluginManager } from './plugins';

void initCoverCache();

void Promise.all([initAudioBackend(), initPrefsMirror(), initFavoritesStore()]).finally(() => {
  pluginManager.reloadFromStorage();
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
});
