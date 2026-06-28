import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors so a failure (e.g. in TTS) shows a recoverable
 * screen with the message instead of a blank app.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('App error boundary caught:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-lg font-semibold">Something went wrong</p>
          <pre className="max-h-48 max-w-md overflow-auto rounded-md border border-border bg-card p-3 text-left text-xs text-destructive">
            {this.state.error.message}
          </pre>
          <Button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
          >
            Reload
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
