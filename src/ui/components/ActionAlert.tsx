import { AlertCircle } from 'lucide-react';

import { cn } from '@/ui/lib/utils';

import {
  DEFAULT_ACTION_ERROR_MAP,
  useActionError,
  type ActionErrorCopy,
  type ActionErrorMap,
} from './actionError.js';

export const ActionAlert = ({
  error,
  known,
  fallback,
  className,
}: {
  readonly error: unknown;
  readonly known?: ActionErrorMap;
  readonly fallback?: ActionErrorCopy;
  readonly className?: string;
}) => {
  const resolved = useActionError(error, {
    known: known ?? DEFAULT_ACTION_ERROR_MAP,
    ...(fallback === undefined ? {} : { fallback }),
  });
  if (resolved === null) return null;

  return (
    <section
      role="alert"
      aria-live="polite"
      data-error-code={resolved.code ?? undefined}
      data-error-status={resolved.status === null ? undefined : String(resolved.status)}
      className={cn(
        'rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">{resolved.title}</p>
          <p>{resolved.message}</p>
          {resolved.code === null ? null : <p className="text-xs">Код: {resolved.code}</p>}
          {resolved.serverMessage === null || resolved.serverMessage === resolved.message ? null : (
            <p className="text-xs">Ответ сервера: {resolved.serverMessage}</p>
          )}
        </div>
      </div>
    </section>
  );
};
