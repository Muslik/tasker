import { describe, expect, it } from 'vitest';

import { DependencyDeclarationStore } from '../../../src/control-plane/dependency-declaration.js';
import { VerifiedPackagePublicationStore } from '../../../src/control-plane/verified-package-publication.js';
import { loadHarnessPack } from '../../../src/harness/index.js';
import {
  DependencyAwaitPackagesAdapter,
  type IntegrationStepExecutionRequest,
} from '../../../src/integrations/index.js';
import { openSqliteLedger } from '../../../src/ledger/index.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';
import type { JsonValue } from '../../../src/workflow/schema.js';
import { makePlanningTaskSnapshot } from '../../support/planning.js';

const task = makePlanningTaskSnapshot('avia-14001-translation-component', {
  origin: 'jira',
  reference: 'jira:AVIA-500',
});

const declarationInput = {
  consumerTaskReference: task.reference,
  producerTaskReference: 'jira:AVIA-400',
  producerRepository: 'twiket/ui-kit',
  packages: ['@ott/core-button', '@ott/core-theme'],
  mode: 'validate_dev_then_final' as const,
  source: {
    kind: 'jira_link' as const,
    linkId: '118870',
    linkTypeId: '10016',
    direction: 'outward' as const,
  },
};

const requestFor = (
  stepInput: JsonValue,
  waitResolution: IntegrationStepExecutionRequest['waitResolution'] = null,
  taskReference = task.reference,
): IntegrationStepExecutionRequest => ({
  operationId: 'dependency:test:1',
  nodeId: 'dependency-wait',
  stepReference: 'dependency.await_packages@1',
  taskReference,
  task: { ...task, reference: taskReference },
  taskSnapshot: { ...task, reference: taskReference },
  stepInput,
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference,
    workflowId: 'tasker:test',
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/tmp/source',
      baseBranch: 'master',
      baseCommit: 'b'.repeat(40),
    },
    runnerId: 'test',
    path: '/tmp/worktree',
    branch: task.taskId,
    preparedAt: '2026-08-25T00:00:00.000Z',
  },
  operatorGuidance: null,
  waitResolution,
  evidence: { acceptedPlan: null, completedSteps: [], reviewInputs: [] },
  policies: loadHarnessPack().policies,
  project: null,
  trackerStatusUpdates: 'enabled',
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

describe('dependency await packages adapter', () => {
  it('waits with typed dependency details when no matching publication is verified yet', async () => {
    const clock = makeAdjustableClock('2026-08-25T13:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const declarations = new DependencyDeclarationStore(ledger.repository, clock);
      const declaration = declarations.declare(declarationInput);
      if (!declaration.ok) throw new Error(JSON.stringify(declaration.error));
      const adapter = new DependencyAwaitPackagesAdapter(
        declarations,
        new VerifiedPackagePublicationStore(ledger.repository, clock),
      );

      const result = await adapter.execute(
        requestFor({
          objective: task.title,
          repository: task.repository,
          taskId: task.taskId,
          declarationId: declaration.value.declarationId,
          declarationRevision: declaration.value.revision,
          channel: 'dev',
          packages: declarationInput.packages,
        }),
      );

      expect(result).toMatchObject({
        status: 'waiting',
        waitKind: 'dependency.available@1',
        details: {
          declarationId: declaration.value.declarationId,
          declarationRevision: declaration.value.revision,
          producerTaskReference: declarationInput.producerTaskReference,
          channel: 'dev',
          packages: ['@ott/core-button', '@ott/core-theme'],
        },
        artifactIds: [],
      });
    } finally {
      ledger.close();
    }
  });

  it('completes with the first unseen matching publication after the cursor', async () => {
    const clock = makeAdjustableClock('2026-08-25T13:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const declarations = new DependencyDeclarationStore(ledger.repository, clock);
      const publications = new VerifiedPackagePublicationStore(ledger.repository, clock);
      const declaration = declarations.declare(declarationInput);
      if (!declaration.ok) throw new Error(JSON.stringify(declaration.error));
      const first = publications.record({
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
        producerTaskReference: declarationInput.producerTaskReference,
        channel: 'dev',
        packages: [
          {
            name: '@ott/core-button',
            version: '1.2.3-dev.1',
            registry: 'https://registry.npmjs.org',
            tarballUrl: 'https://registry.npmjs.org/@ott/core-button/-/core-button-1.2.3-dev.1.tgz',
            integrity: 'sha512-button-1',
          },
          {
            name: '@ott/core-theme',
            version: '1.2.3-dev.1',
            registry: 'https://registry.npmjs.org',
            tarballUrl: 'https://registry.npmjs.org/@ott/core-theme/-/core-theme-1.2.3-dev.1.tgz',
            integrity: 'sha512-theme-1',
          },
        ],
        sourceOperationId: 'operator:dependency-publication:attempt-1',
      });
      if (!first.ok) throw new Error(JSON.stringify(first.error));
      clock.advance(60_000);
      const second = publications.record({
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
        producerTaskReference: declarationInput.producerTaskReference,
        channel: 'dev',
        packages: [
          {
            name: '@ott/core-button',
            version: '1.2.3-dev.2',
            registry: 'https://registry.npmjs.org',
            tarballUrl: 'https://registry.npmjs.org/@ott/core-button/-/core-button-1.2.3-dev.2.tgz',
            integrity: 'sha512-button-2',
          },
          {
            name: '@ott/core-theme',
            version: '1.2.3-dev.2',
            registry: 'https://registry.npmjs.org',
            tarballUrl: 'https://registry.npmjs.org/@ott/core-theme/-/core-theme-1.2.3-dev.2.tgz',
            integrity: 'sha512-theme-2',
          },
        ],
        sourceOperationId: 'operator:dependency-publication:attempt-2',
      });
      if (!second.ok) throw new Error(JSON.stringify(second.error));
      const adapter = new DependencyAwaitPackagesAdapter(declarations, publications);

      const result = await adapter.execute(
        requestFor({
          objective: task.title,
          repository: task.repository,
          taskId: task.taskId,
          declarationId: declaration.value.declarationId,
          declarationRevision: declaration.value.revision,
          channel: 'dev',
          packages: declarationInput.packages,
          afterObservationId: first.value.observationId,
        }),
      );

      expect(result).toMatchObject({
        status: 'completed',
        output: {
          outcome: 'verified',
          observationId: second.value.observationId,
          declarationId: declaration.value.declarationId,
          declarationRevision: declaration.value.revision,
          channel: 'dev',
          packages: [
            { name: '@ott/core-button', version: '1.2.3-dev.2' },
            { name: '@ott/core-theme', version: '1.2.3-dev.2' },
          ],
        },
        artifactIds: [second.value.observationId],
      });
    } finally {
      ledger.close();
    }
  });

  it('blocks a consumer task mismatch against the stored declaration', async () => {
    const clock = makeAdjustableClock('2026-08-25T13:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const declarations = new DependencyDeclarationStore(ledger.repository, clock);
      const declaration = declarations.declare(declarationInput);
      if (!declaration.ok) throw new Error(JSON.stringify(declaration.error));
      const adapter = new DependencyAwaitPackagesAdapter(
        declarations,
        new VerifiedPackagePublicationStore(ledger.repository, clock),
      );

      const result = await adapter.execute(
        requestFor(
          {
            objective: task.title,
            repository: task.repository,
            taskId: task.taskId,
            declarationId: declaration.value.declarationId,
            declarationRevision: declaration.value.revision,
            channel: 'dev',
            packages: declarationInput.packages,
          },
          null,
          'jira:AVIA-999',
        ),
      );

      expect(result).toMatchObject({
        status: 'blocked',
        kind: 'invalid_request',
        details: {
          expectedTaskReference: task.reference,
          actualTaskReference: 'jira:AVIA-999',
        },
      });
    } finally {
      ledger.close();
    }
  });

  it('blocks a dev wait against a final-only declaration', async () => {
    const clock = makeAdjustableClock('2026-08-25T13:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const declarations = new DependencyDeclarationStore(ledger.repository, clock);
      const declaration = declarations.declare({
        ...declarationInput,
        mode: 'final_only',
      });
      if (!declaration.ok) throw new Error(JSON.stringify(declaration.error));
      const adapter = new DependencyAwaitPackagesAdapter(
        declarations,
        new VerifiedPackagePublicationStore(ledger.repository, clock),
      );

      const result = await adapter.execute(
        requestFor({
          objective: task.title,
          repository: task.repository,
          taskId: task.taskId,
          declarationId: declaration.value.declarationId,
          declarationRevision: declaration.value.revision,
          channel: 'dev',
          packages: declarationInput.packages,
        }),
      );

      expect(result).toMatchObject({
        status: 'blocked',
        kind: 'invalid_request',
        details: {
          mode: 'final_only',
          channel: 'dev',
        },
      });
    } finally {
      ledger.close();
    }
  });

  it('re-probes the store instead of trusting a resolution for a missing observation', async () => {
    const clock = makeAdjustableClock('2026-08-25T13:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const declarations = new DependencyDeclarationStore(ledger.repository, clock);
      const declaration = declarations.declare(declarationInput);
      if (!declaration.ok) throw new Error(JSON.stringify(declaration.error));
      const adapter = new DependencyAwaitPackagesAdapter(
        declarations,
        new VerifiedPackagePublicationStore(ledger.repository, clock),
      );

      const result = await adapter.execute(
        requestFor(
          {
            objective: task.title,
            repository: task.repository,
            taskId: task.taskId,
            declarationId: declaration.value.declarationId,
            declarationRevision: declaration.value.revision,
            channel: 'dev',
            packages: declarationInput.packages,
          },
          {
            decision: 'recheck',
            declarationId: declaration.value.declarationId,
            declarationRevision: declaration.value.revision,
            observationId: 'verified-package-publication:operation:missing',
          },
        ),
      );

      expect(result).toMatchObject({
        status: 'waiting',
        waitKind: 'dependency.available@1',
      });
    } finally {
      ledger.close();
    }
  });

  it('blocks a resolution that skips the next unseen matching publication', async () => {
    const clock = makeAdjustableClock('2026-08-25T13:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const declarations = new DependencyDeclarationStore(ledger.repository, clock);
      const publications = new VerifiedPackagePublicationStore(ledger.repository, clock);
      const declaration = declarations.declare(declarationInput);
      if (!declaration.ok) throw new Error(JSON.stringify(declaration.error));
      const first = publications.record({
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
        producerTaskReference: declarationInput.producerTaskReference,
        channel: 'dev',
        packages: [
          {
            name: '@ott/core-button',
            version: '1.2.3-dev.1',
            registry: 'https://registry.npmjs.org',
            tarballUrl: 'https://registry.npmjs.org/@ott/core-button/-/core-button-1.2.3-dev.1.tgz',
            integrity: 'sha512-button-1',
          },
          {
            name: '@ott/core-theme',
            version: '1.2.3-dev.1',
            registry: 'https://registry.npmjs.org',
            tarballUrl: 'https://registry.npmjs.org/@ott/core-theme/-/core-theme-1.2.3-dev.1.tgz',
            integrity: 'sha512-theme-1',
          },
        ],
        sourceOperationId: 'operator:dependency-publication:attempt-1',
      });
      if (!first.ok) throw new Error(JSON.stringify(first.error));
      clock.advance(60_000);
      const second = publications.record({
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
        producerTaskReference: declarationInput.producerTaskReference,
        channel: 'dev',
        packages: [
          {
            name: '@ott/core-button',
            version: '1.2.3-dev.2',
            registry: 'https://registry.npmjs.org',
            tarballUrl: 'https://registry.npmjs.org/@ott/core-button/-/core-button-1.2.3-dev.2.tgz',
            integrity: 'sha512-button-2',
          },
          {
            name: '@ott/core-theme',
            version: '1.2.3-dev.2',
            registry: 'https://registry.npmjs.org',
            tarballUrl: 'https://registry.npmjs.org/@ott/core-theme/-/core-theme-1.2.3-dev.2.tgz',
            integrity: 'sha512-theme-2',
          },
        ],
        sourceOperationId: 'operator:dependency-publication:attempt-2',
      });
      if (!second.ok) throw new Error(JSON.stringify(second.error));
      const adapter = new DependencyAwaitPackagesAdapter(declarations, publications);

      const result = await adapter.execute(
        requestFor(
          {
            objective: task.title,
            repository: task.repository,
            taskId: task.taskId,
            declarationId: declaration.value.declarationId,
            declarationRevision: declaration.value.revision,
            channel: 'dev',
            packages: declarationInput.packages,
          },
          {
            decision: 'recheck',
            declarationId: declaration.value.declarationId,
            declarationRevision: declaration.value.revision,
            observationId: second.value.observationId,
          },
        ),
      );

      expect(result).toMatchObject({
        status: 'blocked',
        kind: 'invalid_request',
        details: {
          expectedObservationId: first.value.observationId,
          resolvedObservationId: second.value.observationId,
        },
      });
    } finally {
      ledger.close();
    }
  });
});
