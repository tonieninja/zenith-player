// WebKitGTK maps window.close() to destroying the webview; with panic=abort that
// looks like the whole app vanishing (seen after some Ctrl+V / clipboard paths).
try {
  window.close = () => {};
} catch {}

import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initAudioBackend } from './audio/engine';
import { initCoverCache } from './utils/imgError';
import { initPrefsMirror } from './utils/prefsMirror';
import { tmark } from './utils/timeline';
import { pluginManager } from './plugins';

tmark('ui script start');

void initCoverCache();

// strictmode in dev runs effects twice and you get duplicate timers / home fetches, skip it
// (the audio backend is picked first: one ipc round trip, before the first render)
void Promise.all([initAudioBackend(), initPrefsMirror()]).finally(() => {
  pluginManager.reloadFromStorage();
  tmark('ui render');
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
});
