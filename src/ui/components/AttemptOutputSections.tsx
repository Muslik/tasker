import type { ReactNode } from 'react';

import { cn } from '../lib/utils.js';
import type { RenderedOutputLine } from './attemptDetailsSupport.js';
import { formatOperatorTimestamp } from './operatorUiFormat.js';

export const AttemptDetailBlock = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) => (
  <section className="space-y-2">
    <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {label}
    </h3>
    <pre className="tasker-code-block whitespace-pre-wrap">
      {value.length > 0 ? value : 'Empty'}
    </pre>
  </section>
);

export const AttemptOutputLines = ({
  label,
  lines,
}: {
  readonly label: string;
  readonly lines: readonly RenderedOutputLine[];
}): ReactNode =>
  lines.length === 0 ? null : (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </h3>
      <ul className="space-y-2">
        {lines.map((line) => (
          <li
            key={line.id}
            className={cn(
              'rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs leading-5 text-foreground',
              line.structured && 'border-primary/30 bg-primary/5',
            )}
          >
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-medium uppercase">{line.stream}</span>
              {line.recordedAt === null ? null : (
                <time dateTime={line.recordedAt}>{formatOperatorTimestamp(line.recordedAt)}</time>
              )}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words">{line.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
