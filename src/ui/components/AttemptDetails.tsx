import type {
  OperatorExecutionAttempt,
  OperatorRunLogEntry,
} from '../../control-plane/operator-contracts.js';
import { cn } from '../../cockpit/lib/utils.js';
import { formatDuration } from '../lib/format.js';

export type AttemptDetailsTab = 'log' | 'transcript' | 'output' | 'details' | 'prompt';

export type AttemptDetailsProps = {
  entry: OperatorRunLogEntry | null;
  attempt?: OperatorExecutionAttempt | null;
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

const formatJson = (value: unknown): string => JSON.stringify(value, null, 2);

const formatTimestamp = (value: string | null): string =>
  value === null ? '\u2014' : value.replace('T', ' ').replace('.000Z', 'Z');

const formatReference = (entry: OperatorRunLogEntry): string =>
  entry.runtime === 'bootstrap' && entry.runner === 'planner' ? 'Planning' : entry.reference;

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

const DetailBlock = ({ label, value }: { label: string; value: string }) => (
  <section className="space-y-2">
    <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {label}
    </h3>
    <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-3 text-xs leading-5 text-foreground whitespace-pre-wrap">
      {value.length > 0 ? value : 'Empty'}
    </pre>
  </section>
);

export function AttemptDetails({
  entry,
  attempt = null,
  selectedTab = null,
  onTabChange,
  className,
}: AttemptDetailsProps) {
  const activeTab = resolveAttemptDetailsTab(entry, attempt, selectedTab);

  if (entry === null || activeTab === null) {
    return (
      <aside
        aria-label="Attempt details"
        className={cn(
          'rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground',
          className,
        )}
      >
        Select an attempt to inspect raw logs, transcript chunks, and execution output.
      </aside>
    );
  }

  const transcript = attempt?.transcript ?? null;
  const output = attempt?.output ?? null;
  const tabs = availableAttemptDetailsTabs(entry, attempt);

  return (
    <aside
      aria-label="Attempt details"
      className={cn('rounded-2xl border border-border bg-card text-card-foreground', className)}
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{formatReference(entry)}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Attempt #{String(entry.blockRun)} · {entry.status.replaceAll('_', ' ')}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
            <div>
              <dt className="inline text-muted-foreground">Started</dt>
              <dd className="ml-1 inline">{formatTimestamp(entry.startedAt)}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Duration</dt>
              <dd className="ml-1 inline">{formatDuration(entry.startedAt, entry.completedAt)}</dd>
            </div>
          </dl>
        </div>
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
        {activeTab === 'log' ? <DetailBlock label="Raw log" value={entry.rawLog} /> : null}
        {activeTab === 'transcript' && transcript !== null ? (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-foreground">
                <thead>
                  <tr className="border-b border-border text-left uppercase tracking-[0.08em] text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Seq</th>
                    <th className="pb-2 pr-4 font-medium">Stream</th>
                    <th className="pb-2 pr-4 font-medium">Bytes</th>
                    <th className="pb-2 font-medium">Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {transcript.chunks.map((chunk) => (
                    <tr key={chunk.sequence} className="border-b border-border/60 last:border-0">
                      <td className="py-2 pr-4 tabular-nums">{chunk.sequence}</td>
                      <td className="py-2 pr-4">{chunk.stream}</td>
                      <td className="py-2 pr-4 tabular-nums">{chunk.byteLength}</td>
                      <td className="py-2 tabular-nums">{formatTimestamp(chunk.recordedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DetailBlock
              label="Combined transcript"
              value={transcript.chunks.map((chunk) => chunk.content).join('')}
            />
          </>
        ) : null}
        {activeTab === 'output' && output !== null ? (
          <>
            <div className="grid gap-2 rounded-xl border border-border bg-muted/40 p-3 text-xs text-foreground sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">Runner</span>
                <div>{output.runner}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Exit code</span>
                <div className="tabular-nums">
                  {output.exitCode === null ? '\u2014' : output.exitCode}
                </div>
              </div>
              <div className="sm:col-span-2">
                <span className="text-muted-foreground">Command</span>
                <div className="break-all">{output.command ?? 'Not recorded'}</div>
              </div>
              <div className="sm:col-span-2">
                <span className="text-muted-foreground">Working directory</span>
                <div className="break-all">{output.cwd}</div>
              </div>
            </div>
            <DetailBlock label="stdout" value={output.stdout} />
            <DetailBlock label="stderr" value={output.stderr} />
          </>
        ) : null}
        {activeTab === 'details' && output !== null ? (
          <DetailBlock label="Structured details" value={formatJson(output.details)} />
        ) : null}
        {activeTab === 'prompt' ? (
          <section className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            Prompt
            <p className="mt-2 text-xs text-muted-foreground">
              Prompt artifacts are not wired into this surface yet.
            </p>
          </section>
        ) : null}
      </div>
    </aside>
  );
}
