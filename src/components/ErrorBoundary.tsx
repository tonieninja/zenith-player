import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };

// plain strings on purpose: this screen has to render even when the app state is broken
const TEXT = {
  en: {
    title: 'Zenith hit a UI error',
    body: 'Playback may still be running. Reload the window to recover.',
    reload: 'Reload',
    copy: 'Copy error details',
    copied: 'Copied',
  },
  pl: {
    title: 'W interfejsie Zenith wystąpił błąd',
    body: 'Muzyka może nadal grać. Przeładuj okno, aby to naprawić.',
    reload: 'Przeładuj',
    copy: 'Kopiuj szczegóły błędu',
    copied: 'Skopiowano',
  },
};

function uiText() {
  try {
    return localStorage.getItem('zenith_lang') === 'pl' ? TEXT.pl : TEXT.en;
  } catch {
    return TEXT.en;
  }
}
type State = { error: Error | null; copied?: boolean };

const CRASH_KEY = 'zenith_crash_log';

/** local-only crash log (last 20 entries), never sent anywhere */
export function recordCrash(error: Error, stack?: string | null) {
  try {
    const prev = JSON.parse(localStorage.getItem(CRASH_KEY) || '[]') as unknown[];
    const entry = {
      at: new Date().toISOString(),
      message: String(error?.message || error),
      stack: String(error?.stack || '').slice(0, 4000),
      component: String(stack || '').slice(0, 2000),
    };
    localStorage.setItem(CRASH_KEY, JSON.stringify([...prev, entry].slice(-20)));
  } catch {
    /* storage full or blocked, nothing to do */
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[zenith] uncaught render error', error, info.componentStack);
    recordCrash(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const txt = uiText();
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 32,
          background: '#171a22',
          color: '#f6f7ff',
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>{txt.title}</h1>
        <p style={{ maxWidth: 420, opacity: 0.72, lineHeight: 1.45, margin: 0 }}>{txt.body}</p>
        <pre
          style={{
            maxWidth: 560,
            overflow: 'auto',
            padding: 12,
            borderRadius: 10,
            background: 'rgba(255,255,255,0.06)',
            fontSize: 12,
            textAlign: 'left',
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 8,
            border: 0,
            borderRadius: 999,
            padding: '10px 18px',
            background: '#fff',
            color: '#111',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {txt.reload}
        </button>
        <button
          type="button"
          onClick={() => {
            const e = this.state.error;
            const details = `${e?.message}\n${e?.stack || ''}\n${navigator.userAgent}`;
            navigator.clipboard
              ?.writeText(details)
              .then(() => this.setState({ copied: true }))
              .catch(() => {});
          }}
          style={{
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 999,
            padding: '8px 16px',
            background: 'transparent',
            color: '#f6f7ff',
            cursor: 'pointer',
          }}
        >
          {this.state.copied ? txt.copied : txt.copy}
        </button>
      </div>
    );
  }
}
