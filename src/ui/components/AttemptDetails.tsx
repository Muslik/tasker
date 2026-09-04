import type {
  OperatorExecutionAttempt,
  OperatorRunLogEntry,
  OperatorTaskInvocationDetail,
} from '../../server/operator-contracts.js';
import { cn } from '../lib/utils.js';
import { InvocationPrompt } from './InvocationPrompt.js';
import { AttemptDetailBlock, AttemptOutputLines } from './AttemptOutputSections.js';
import { JsonCodeBlock } from './JsonCodeBlock.js';
import {
  attemptDurationLabel,
  attemptOutcomeLabel,
  buildRenderedOutputLines,
  buildTranscriptLines,
  firstMeaningfulAttemptOutput,
} from './attemptDetailsSupport.js';
import { formatOperatorTimestamp } from './operatorUiFormat.js';

export type AttemptDetailsTab = 'log' | 'transcript' | 'output' | 'details' | 'prompt';

export type AttemptDetailsProps = {
  entry: OperatorRunLogEntry | null;
  attempt?: OperatorExecutionAttempt | null;
  invocationId?: string | null;
  invocationDetail?: OperatorTaskInvocationDetail | null;
  invocationDetailPending?: boolean;
  invocationDetailError?: Error | null;
  selectedTab?: AttemptDetailsTab | null;
  onTabChange?: (tab: AttemptDetailsTab) => void;
  className?: string;
};

const tabLabels: Record<AttemptDetailsTab, string> = {
  log: 'Raw log',
  transcript: 'Transcript',
  output: 'Output',
  details: 'Details',
  prompt: 'Prompt',
};
const formatReference = (entry: OperatorRunLogEntry): string =>
  entry.runtime === 'bootstrap' && entry.runner === 'planner' ? 'Planning' : entry.reference;
const outcomeTone = (outcome: string): string => {
  if (outcome === 'completed')
    return 'border-emerald-200/80 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-400/15 dark:text-emerald-200';
  if (outcome === 'failed' || outcome === 'blocked')
    return 'border-red-200/80 bg-red-500/10 text-red-700 dark:border-red-400/40 dark:bg-red-400/15 dark:text-red-200';
  return 'border-amber-200/80 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-200';
};
const OutcomeChip = ({ outcome }: { readonly outcome: string }) => (
  <span
    className={cn(
      'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
      outcomeTone(outcome),
    )}
    data-outcome={outcome}
  >
    {outcome}
  </span>
);

export const availableAttemptDetailsTabs = (
  entry: OperatorRunLogEntry | null,
  attempt: OperatorExecutionAttempt | null | undefined,
): readonly AttemptDetailsTab[] => {
  if (entry === null) return [];
  const tabs: AttemptDetailsTab[] = ['log'];
  if (attempt?.transcript !== null && attempt?.transcript !== undefined) tabs.push('transcript');
  if (attempt?.output !== null && attempt?.output !== undefined) tabs.push('output', 'details');
  tabs.push('prompt');
  return tabs;
};

export const resolveAttemptDetailsTab = (
  entry: OperatorRunLogEntry | null,
  attempt: OperatorExecutionAttempt | null | undefined,
  selectedTab: AttemptDetailsTab | null | undefined,
): AttemptDetailsTab | null => {
  const tabs = availableAttemptDetailsTabs(entry, attempt);
  if (tabs.length === 0) return null;
  return selectedTab !== null && selectedTab !== undefined && tabs.includes(selectedTab)
    ? selectedTab
    : (tabs[0] ?? null);
};

export const triggerAttemptTabChange = (
  tab: AttemptDetailsTab,
  onTabChange?: (tab: AttemptDetailsTab) => void,
): AttemptDetailsTab => {
  onTabChange?.(tab);
  return tab;
};

export function AttemptDetails({
  entry,
  attempt = null,
  invocationId = null,
  invocationDetail = null,
  invocationDetailPending = false,
  invocationDetailError = null,
  selectedTab = null,
  onTabChange,
  className,
}: AttemptDetailsProps) {
  const promptSelectionAvailable =
    invocationId !== null ||
    invocationDetail !== null ||
    invocationDetailPending ||
    invocationDetailError !== null;
  const activeTab =
    entry === null
      ? selectedTab === 'prompt' && promptSelectionAvailable
        ? 'prompt'
        : null
      : resolveAttemptDetailsTab(entry, attempt, selectedTab);

  if (activeTab === null) {
    return (
      <aside
        aria-label="Attempt details"
        className={cn('tasker-panel px-4 py-4 text-sm text-muted-foreground', className)}
      >
        Select an attempt to inspect raw logs, transcript chunks, and execution output.
      </aside>
    );
  }

  if (entry === null) {
    return (
      <aside aria-label="Attempt details" className={cn('tasker-panel px-4 py-4', className)}>
        <InvocationPrompt
          invocationId={invocationId}
          detail={invocationDetail}
          pending={invocationDetailPending}
          error={invocationDetailError}
        />
      </aside>
    );
  }

  const transcript = attempt?.transcript ?? null;
  const output = attempt?.output ?? null;
  const tabs = availableAttemptDetailsTabs(entry, attempt);
  const transcriptLines = buildTranscriptLines(transcript);
  const stdoutLines = buildRenderedOutputLines(
    output?.stdout ?? '',
    'stdout',
    output?.recordedAt ?? null,
    'stdout',
  );
  const stderrLines = buildRenderedOutputLines(
    output?.stderr ?? '',
    'stderr',
    output?.recordedAt ?? null,
    'stderr',
  );

  return (
    <aside aria-label="Attempt details" className={cn('tasker-panel', className)}>
      <div className="tasker-panel-header">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{formatReference(entry)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Attempt #{String(entry.blockRun)} · {formatOperatorTimestamp(entry.startedAt)}
          </p>
        </div>
        <dl className="tasker-summary-grid min-w-full text-xs tabular-nums md:min-w-[32rem]">
          <div>
            <dt>Model</dt>
            <dd>
              {invocationDetail?.model ??
                (invocationDetailPending ? 'Loading invocation…' : 'Not recorded')}
            </dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{attemptDurationLabel(entry, invocationDetail)}</dd>
          </div>
          <div>
            <dt>Outcome</dt>
            <dd>
              <OutcomeChip outcome={attemptOutcomeLabel(entry, invocationDetail)} />
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt>First meaningful output</dt>
            <dd>{firstMeaningfulAttemptOutput(entry, attempt)}</dd>
          </div>
        </dl>
      </div>
      <div className="border-b border-border px-4 py-2">
        <div role="tablist" aria-label="Attempt detail sections" className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const selected = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`attempt-panel-${tab}`}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition',
                  selected
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
                onClick={() => triggerAttemptTabChange(tab, onTabChange)}
              >
                {tabLabels[tab]}
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-4 px-4 py-4" id={`attempt-panel-${activeTab}`} role="tabpanel">
        {activeTab === 'log' ? <AttemptDetailBlock label="Raw log" value={entry.rawLog} /> : null}
        {activeTab === 'transcript' && transcript !== null ? (
          <>
            <AttemptOutputLines label="Transcript events" lines={transcriptLines} />
            <div className="tasker-scroll-shell">
              <table className="tasker-fixed-table min-w-[44rem] text-xs text-foreground">
                <thead>
                  <tr className="border-b border-border text-left uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Seq</th>
                    <th className="pb-2 pr-4 font-medium">Provider attempt</th>
                    <th className="pb-2 pr-4 font-medium">Stream</th>
                    <th className="pb-2 pr-4 font-medium">Bytes</th>
                    <th className="pb-2 font-medium">Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {transcript.chunks.map((chunk) => (
                    <tr key={chunk.sequence} className="border-b border-border/60 last:border-0">
                      <td className="py-2 pr-4 tabular-nums">{chunk.sequence}</td>
                      <td className="py-2 pr-4 tabular-nums">{chunk.providerAttempt}</td>
                      <td className="py-2 pr-4">{chunk.stream}</td>
                      <td className="py-2 pr-4 tabular-nums">{chunk.byteLength}</td>
                      <td className="py-2 tabular-nums">
                        {formatOperatorTimestamp(chunk.recordedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {activeTab === 'output' && output !== null ? (
          <>
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Output summary
              </h3>
              <dl className="tasker-summary-grid text-xs text-foreground">
                <div>
                  <dt>Runner</dt>
                  <dd>{output.runner}</dd>
                </div>
                <div>
                  <dt>Exit code</dt>
                  <dd className="tabular-nums">
                    {output.exitCode === null ? '\u2014' : output.exitCode}
                  </dd>
                </div>
                <div className="md:col-span-2">
                  <dt>Command</dt>
                  <dd className="break-all">{output.command ?? 'Not recorded'}</dd>
                </div>
                <div className="md:col-span-2">
                  <dt>Working directory</dt>
                  <dd className="break-all">{output.cwd}</dd>
                </div>
              </dl>
            </section>
            <AttemptOutputLines label="stdout events" lines={stdoutLines} />
            <AttemptOutputLines label="stderr events" lines={stderrLines} />
          </>
        ) : null}
        {activeTab === 'details' && output !== null ? (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Structured details
            </h3>
            <JsonCodeBlock value={output.details} />
          </section>
        ) : null}
        {activeTab === 'prompt' ? (
          <InvocationPrompt
            invocationId={invocationId}
            detail={invocationDetail}
            pending={invocationDetailPending}
            error={invocationDetailError}
            attemptRuntime={entry.runtime}
            attemptStatus={entry.status}
          />
        ) : null}
      </div>
    </aside>
  );
}
