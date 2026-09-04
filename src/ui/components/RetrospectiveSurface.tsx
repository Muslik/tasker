import type { RetrospectivePatterns, RetrospectiveResponse } from '../../server/report.js';
import { ActionAlert } from './ActionAlert.js';
import { Button } from './ui/button.js';

export const RetrospectiveSurface = ({
  response,
  patterns,
  onProposalStatus,
  proposalPending = false,
  proposalError = null,
  proposalErrorProposalId = null,
}: {
  readonly response: RetrospectiveResponse | undefined;
  readonly patterns?: RetrospectivePatterns;
  readonly onProposalStatus?: (proposalId: string, status: 'approved' | 'dismissed') => void;
  readonly proposalPending?: boolean;
  readonly proposalError?: unknown;
  readonly proposalErrorProposalId?: string | null;
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
              <div className="rounded-md bg-muted/50 p-3 text-sm" key={proposal.id}>
                <strong>{proposal.title}</strong>
                <span className="mt-1 block text-muted-foreground">{proposal.rationale}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Generality: {proposal.generalityRationale}
                </span>
                {proposal.harnessFile === undefined ? null : (
                  <code className="mt-1 block text-xs">{proposal.harnessFile}</code>
                )}
                {proposal.status === 'proposed' && onProposalStatus === undefined ? null : (
                  <span className="mt-2 block text-xs">Status: {proposal.status}</span>
                )}
                {proposal.status === 'proposed' && onProposalStatus !== undefined ? (
                  <>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        type="button"
                        disabled={proposalPending}
                        onClick={() => {
                          onProposalStatus(proposal.id, 'approved');
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        disabled={proposalPending}
                        onClick={() => {
                          onProposalStatus(proposal.id, 'dismissed');
                        }}
                      >
                        Dismiss
                      </Button>
                    </div>
                    <ActionAlert
                      error={proposalErrorProposalId === proposal.id ? proposalError : null}
                    />
                  </>
                ) : null}
                {proposal.status === 'approved' ? (
                  <span className="mt-2 block text-xs text-muted-foreground">
                    Apply manually in an interactive session
                    {proposal.harnessFile === undefined ? '' : `: ${proposal.harnessFile}`}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {patterns === undefined ? null : (
          <div className="mt-4 text-xs text-muted-foreground">
            <h3 className="font-semibold uppercase tracking-wider">Error diary</h3>
            {patterns.findings.length === 0 && patterns.proposals.length === 0 ? (
              <p className="mt-1">No repeated patterns yet.</p>
            ) : (
              <div className="mt-1 space-y-1">
                {patterns.findings.map((pattern) => (
                  <p key={`finding-${pattern.stepReference}`}>
                    {pattern.stepReference}: {pattern.count} finding{pattern.count === 1 ? '' : 's'}
                  </p>
                ))}
                {patterns.proposals.map((pattern) => (
                  <p key={`proposal-${pattern.target}`}>
                    {pattern.target}: {pattern.count} proposal{pattern.count === 1 ? '' : 's'}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </details>
    </section>
  );
};
