import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = {
  readonly children: ReactNode;
};

type ErrorBoundaryState =
  { readonly status: 'ready' } | { readonly status: 'failed'; readonly error: Error };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { status: 'ready' };

  public static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error('The operator UI failed unexpectedly'),
    };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Operator UI render failed', error, info.componentStack);
  }

  public override render(): ReactNode {
    if (this.state.status === 'ready') {
      return this.props.children;
    }

    return (
      <main className="grid min-h-full place-items-center bg-background p-8 text-foreground">
        <section className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
          <p className="text-xs font-semibold tracking-wide text-destructive uppercase">
            Operator UI unavailable
          </p>
          <h1 className="mt-2 text-xl font-semibold">The interface could not be rendered</h1>
          <p className="mt-3 text-sm text-muted-foreground">{this.state.error.message}</p>
          <button
            className="mt-5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            type="button"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload operator UI
          </button>
        </section>
      </main>
    );
  }
}
