import type { RetrospectiveResponse } from '../../server/report.js';

export const RetrospectiveSurface = ({
  response,
}: {
  readonly response: RetrospectiveResponse | undefined;
}) => {
  if (response === undefined) return null;
  if (response.status === 'pending')
    return (
      <section
        aria-label="Retrospective"
        className="rounded-xl border bg-card p-4 text-sm text-muted-foreground"
      >
        Retrospective is running…
      </section>
    );
  const { report } = response;
  return (
    <section aria-label="Retrospective" className="rounded-xl border bg-card p-4">
      <details open>
        <summary className="cursor-pointer text-sm font-semibold">
          Retrospective · {report.outcome}
        </summary>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs tabular-nums sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Attempts</dt>
            <dd className="mt-1 text-sm">{report.metrics.attempts}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Blocked</dt>
            <dd className="mt-1 text-sm">{report.metrics.blockedAttempts}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Tokens</dt>
            <dd className="mt-1 text-sm">
              {(report.metrics.inputTokens + report.metrics.outputTokens).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Estimated cost</dt>
            <dd className="mt-1 text-sm">${report.metrics.estimatedCostUsd.toFixed(4)}</dd>
          </div>
        </dl>
        {report.findings.length > 0 ? (
          <div className="mt-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Findings
            </h3>
            {report.findings.map((finding) => (
              <article
                className="rounded-md bg-muted/50 p-3 text-sm"
                key={`${finding.kind}-${finding.title}`}
              >
                <strong>{finding.title}</strong>
                <p className="mt-1 text-muted-foreground">{finding.detail}</p>
              </article>
            ))}
          </div>
        ) : null}
        {report.proposals.length > 0 ? (
          <div className="mt-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Proposed improvements
            </h3>
            {report.proposals.map((proposal) => (
              <p className="rounded-md bg-muted/50 p-3 text-sm" key={proposal.id}>
                <strong>{proposal.title}</strong>
                <span className="mt-1 block text-muted-foreground">{proposal.rationale}</span>
              </p>
            ))}
          </div>
        ) : null}
      </details>
    </section>
  );
};
