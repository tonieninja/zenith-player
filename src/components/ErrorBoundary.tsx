import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[zenith] uncaught render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
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
        <h1 style={{ fontSize: 22, margin: 0 }}>Zenith hit a UI error</h1>
        <p style={{ maxWidth: 420, opacity: 0.72, lineHeight: 1.45, margin: 0 }}>
          Playback may still be running. Reload the window to recover.
        </p>
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
          Reload
        </button>
      </div>
    );
  }
}
