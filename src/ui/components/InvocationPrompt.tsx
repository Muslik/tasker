import type {
  OperatorRunLogEntry,
  OperatorTaskInvocationDetail,
} from '../../server/operator-contracts.js';
import { cn } from '../../cockpit/lib/utils.js';
import { formatDuration } from '../lib/format.js';

export type InvocationPromptProps = {
  invocationId: string | null;
  detail?: OperatorTaskInvocationDetail | null;
  pending?: boolean;
  error?: Error | null;
  attemptRuntime?: OperatorRunLogEntry['runtime'] | null;
  attemptStatus?: OperatorRunLogEntry['status'] | null;
  onCopyPrompt?: ((prompt: string) => void | Promise<void>) | undefined;
  className?: string;
};

export type InvocationPromptCopyOptions = {
  writeText?: ((prompt: string) => void | Promise<void>) | undefined;
  onCopy?: ((prompt: string) => void | Promise<void>) | undefined;
};

const formatTimestamp = (value: string): string => value.replace('T', ' ').replace('.000Z', 'Z');

const formatCount = (value: number | null): string =>
  value === null ? '\u2014' : value.toLocaleString();

const formatCost = (detail: OperatorTaskInvocationDetail): string => {
  if (detail.cost.source === 'unrated') return 'Unrated';
  return `$${detail.cost.amountUsd.toFixed(4)}`;
};

const formatExitStatus = (detail: OperatorTaskInvocationDetail): string => {
  if (detail.exitStatus.kind === 'exited') return `Exited ${String(detail.exitStatus.exitCode)}`;
  if (detail.exitStatus.kind === 'timed_out') return 'Timed out';
  return detail.exitStatus.message;
};

const promptStateMessage = (
  invocationId: string | null,
  attemptRuntime: OperatorRunLogEntry['runtime'] | null | undefined,
  attemptStatus: OperatorRunLogEntry['status'] | null | undefined,
): string => {
  if (invocationId !== null) return `Invocation detail for ${invocationId} was not found.`;
  if (attemptRuntime === 'bootstrap') {
    return 'Planning attempts are not linked to execution invocation prompts.';
  }
  if (attemptStatus === 'running') {
    return 'This attempt is still running. A prompt will appear after a finished invocation is recorded.';
  }
  return 'No finished invocation is linked to this attempt.';
};

export const triggerInvocationPromptCopy = async (
  prompt: string,
  options: InvocationPromptCopyOptions = {},
): Promise<string> => {
  const writer =
    options.writeText ??
    globalThis.navigator.clipboard.writeText.bind(globalThis.navigator.clipboard);
  await writer(prompt);
  await options.onCopy?.(prompt);
  return prompt;
};

const MetadataBlock = ({ label, value }: { label: string; value: string }) => (
  <div className="space-y-1">
    <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {label}
    </dt>
    <dd className="text-sm text-foreground">{value}</dd>
  </div>
);

export function InvocationPrompt({
  invocationId,
  detail = null,
  pending = false,
  error = null,
  attemptRuntime = null,
  attemptStatus = null,
  onCopyPrompt,
  className,
}: InvocationPromptProps) {
  if (pending) {
    return (
      <section
        className={cn(
          'rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground',
          className,
        )}
      >
        Loading invocation prompt…
      </section>
    );
  }

  if (error !== null) {
    return (
      <section
        className={cn(
          'rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-sm text-destructive',
          className,
        )}
      >
        <p>Prompt artifact failed to load.</p>
        <p className="mt-2 text-xs">{error.message}</p>
      </section>
    );
  }

  if (detail === null) {
    return (
      <section
        className={cn(
          'rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground',
          className,
        )}
      >
        {promptStateMessage(invocationId, attemptRuntime, attemptStatus)}
      </section>
    );
  }

  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3">
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <MetadataBlock label="Invocation" value={detail.invocationId} />
          <MetadataBlock label="argv" value={detail.argv.join(' ')} />
          <MetadataBlock
            label="Model"
            value={[detail.model, detail.profile, detail.effort, detail.serviceTier]
              .filter((value) => value !== null)
              .join(' · ')}
          />
          <MetadataBlock
            label="Skills"
            value={detail.skills.length === 0 ? 'None' : detail.skills.join(', ')}
          />
          <MetadataBlock
            label="Usage"
            value={[
              `${formatCount(detail.usage.inputTokens)} in`,
              `${formatCount(detail.usage.cachedInputTokens)} cached`,
              `${formatCount(detail.usage.outputTokens)} out`,
              `${formatCount(detail.usage.reasoningOutputTokens)} reasoning`,
            ].join(' · ')}
          />
          <MetadataBlock label="Cost" value={`${formatCost(detail)} · ${detail.status}`} />
        </dl>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-background"
          onClick={() => void triggerInvocationPromptCopy(detail.prompt, { onCopy: onCopyPrompt })}
        >
          Copy prompt
        </button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{formatTimestamp(detail.startedAt)}</span>
        <span>{formatDuration(detail.startedAt, detail.finishedAt)}</span>
        <span>{formatExitStatus(detail)}</span>
      </div>
      <div className="rounded-xl border border-border bg-card">
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-foreground">
          {detail.prompt.length > 0 ? detail.prompt : 'Empty prompt'}
        </pre>
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {detail.promptBytes.toLocaleString()} bytes
        </div>
      </div>
    </section>
  );
}
