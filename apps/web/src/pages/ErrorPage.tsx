import { Anchor, RefreshCw } from 'lucide-react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { Button } from '../components/ui';

/** Shown instead of a blank screen when a page throws or a route doesn't exist. */
export function ErrorPage() {
  const error = useRouteError();
  // Rendered directly by the catch-all route there is no error object: that's a 404.
  const notFound = error == null || (isRouteErrorResponse(error) && error.status === 404);
  const message = isRouteErrorResponse(error) ? error.statusText : error instanceof Error ? error.message : String(error);

  return (
    <div className="flex h-full items-center justify-center bg-bg px-6 text-fg">
      <div className="max-w-md text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-accent text-accent-fg">
          <Anchor className="size-5" />
        </div>
        <h1 className="mt-4 text-lg font-semibold tracking-tight">{notFound ? 'Page not found' : 'Something went wrong'}</h1>
        <p className="mt-1 text-sm text-muted">
          {notFound ? "This page doesn't exist, or the project was removed." : 'This page hit an unexpected error. Your data is safe.'}
        </p>
        {!notFound && message && <pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-line bg-panel p-3 text-left font-mono text-xs text-rose-400">{message}</pre>}
        <div className="mt-6 flex justify-center gap-2">
          <Link to="/">
            <Button variant="primary">Go to dashboard</Button>
          </Link>
          {!notFound && (
            <Button icon={<RefreshCw className="size-3.5" />} onClick={() => window.location.reload()}>
              Reload
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
