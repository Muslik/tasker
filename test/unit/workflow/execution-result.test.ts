import { describe, expect, it } from 'vitest';

import { parseDeclaredWorkflowChangeRequest } from '../../../src/workflow/index.js';

const crossRepositoryDiscovery = () => ({
  schemaVersion: 1 as const,
  discoveredAtNodeId: 'reproduce-bug',
  summary: 'The failure originates in a shared fare-card package.',
  evidenceArtifactIds: ['artifact:reproduction-log'],
  changes: [
    {
      kind: 'cross_repository_dependency' as const,
      repository: 'twiket/ui-kit',
      componentPath: 'packages/@ott/fare-card',
      requestedOutcome: 'Fix the shared fare-card rendering contract.',
    },
  ],
});

describe('runtime workflow change boundary', () => {
  it('accepts an evidenced repository discovery declared by the step contract', () => {
    const result = parseDeclaredWorkflowChangeRequest(crossRepositoryDiscovery(), [
      'cross_repository_dependency',
    ]);

    expect(result).toEqual({ ok: true, value: crossRepositoryDiscovery() });
  });

  it('rejects a discovery without persisted evidence', () => {
    const input = { ...crossRepositoryDiscovery(), evidenceArtifactIds: [] };

    const result = parseDeclaredWorkflowChangeRequest(input, ['cross_repository_dependency']);

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });

  it('rejects a scope change the producing step did not declare', () => {
    const result = parseDeclaredWorkflowChangeRequest(crossRepositoryDiscovery(), [
      'verification_scope_changed',
    ]);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'change_not_declared',
        changeKind: 'cross_repository_dependency',
      },
    });
  });
});
