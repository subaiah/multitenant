import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../lib/error-reporting';
import { primaryButtonClass, secondaryButtonClass } from './ui';

/**
 * A page that fails to render shows this instead of a blank screen, and the
 * error is reported (lib/error-reporting.ts).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (info.componentStack) error.stack = `${error.stack ?? ''}\nComponent stack:${info.componentStack}`.slice(0, 8000);
    reportClientError(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-900">
        <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center dark:border-slate-700 dark:bg-slate-800">
          <h1 className="text-lg font-semibold text-slate-800 dark:text-white">Something went wrong on this page</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            The problem has been reported. Reload the page to try again; if it keeps happening, go back to the dashboard.
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={primaryButtonClass}
            >
              Reload
            </button>
            <a href="/" className={secondaryButtonClass}>
              Dashboard
            </a>
          </div>
        </div>
      </div>
    );
  }
}
