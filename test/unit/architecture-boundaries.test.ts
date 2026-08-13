import { globSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const offenders = (pattern: string, forbidden: readonly string[]): readonly string[] =>
  globSync(pattern)
    .toSorted()
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const matches = forbidden.filter((concept) => source.includes(concept));
      return matches.length === 0 ? [] : [`${path}: ${matches.join(', ')}`];
    });

describe('production architecture boundaries', () => {
  it('has one planner path and no fixture workflow composer in production', () => {
    expect(
      offenders('src/**/*.ts', [
        'DeterministicImplementationPlanner',
        'TASKER_WORKFLOW_PROVIDER',
        'fixture-assembly',
        'TaskFixture',
        'proposalVariant',
        "expected: z.literal('accepted')",
      ]),
    ).toEqual([]);
  });

  it('does not preserve obsolete Temporal workflow branches', () => {
    expect(
      offenders('src/temporal/workflows/**/*.ts', ['patched(', "executionStart === 'manual'"]),
    ).toEqual([]);
  });

  it('keeps external systems out of workflow and execution-kernel code', () => {
    expect(
      offenders('src/{workflow,temporal/execution-kernel,temporal/workflows}/**/*.ts', [
        '../integrations/',
        '../../integrations/',
        'Jira',
        'Bitbucket',
        'Jenkins',
      ]),
    ).toEqual([]);
  });

  it('keeps the durable core independent from the control plane and source adapters', () => {
    expect(
      offenders(
        'src/{workflow,temporal/bootstrap-kernel,temporal/execution-kernel,temporal/workflows}/**/*.ts',
        ['../control-plane/', '../../control-plane/', '../integrations/', '../../integrations/'],
      ),
    ).toEqual([]);
  });

  it('keeps adapter and runtime receipts out of durable workflow state', () => {
    expect(
      offenders(
        'src/{temporal/bootstrap-kernel,temporal/execution-kernel,temporal/workflows}/**/*.ts',
        [
          'ImplementationPlannerReceipt',
          'WorkspaceBootstrapReceipt',
          'DockerWorkspaceRuntimeReceipt',
          'WorkspaceLocatorSchema',
          '../../providers/',
          '../../workspaces/',
        ],
      ),
    ).toEqual([]);
  });

  it('keeps task-source policy out of the neutral planning task contract', () => {
    expect(
      offenders('src/planning/task-snapshot.ts', [
        'Jira',
        'family',
        'componentRepository',
        'translation',
        'publication',
        'verificationProfile',
      ]),
    ).toEqual([]);
  });

  it('keeps company workflow vocabulary out of core obligation validation', () => {
    const companyReferences = [
      'bug.validate_fix@1',
      'ci.observe@1',
      'ci.passed@1',
      'code_review@1',
      'pr.prepare@1',
      'review.agent@1',
      'translation_complete@1',
      'final_publish@1',
    ];

    expect(offenders('src/planning/{contracts,obligations}.ts', companyReferences)).toEqual([]);
  });
});
