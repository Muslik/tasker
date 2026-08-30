import { describe, expect, it } from 'vitest';

import {
  DependencyDeclarationStore,
  dependencyDeclarationIdFor,
} from '../../src/server/dependency-declaration.js';
import { openSqliteLedger } from '../../src/store/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const baseInput = {
  consumerTaskReference: 'jira:AVIA-500',
  producerTaskReference: 'jira:AVIA-400',
  producerRepository: 'front-core-packages',
  packages: ['@ott/core-button', '@ott/core-theme'],
  mode: 'validate_dev_then_final' as const,
  source: {
    kind: 'jira_link' as const,
    linkId: '118870',
    linkTypeId: '10016',
    direction: 'outward' as const,
  },
};

describe('DependencyDeclarationStore', () => {
  it('records the first declaration revision with a stable semantic hash', () => {
    const clock = makeAdjustableClock('2026-08-25T08:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new DependencyDeclarationStore(ledger.repository, clock);

      const recorded = store.declare(baseInput);

      expect(recorded).toMatchObject({
        ok: true,
        value: {
          schemaVersion: 1,
          declarationId: dependencyDeclarationIdFor(
            baseInput.consumerTaskReference,
            baseInput.source,
          ),
          revision: 1,
          packages: ['@ott/core-button', '@ott/core-theme'],
          mode: 'validate_dev_then_final',
        },
      });
      expect(recorded.ok && recorded.value.hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        ledger.repository.readDocument(
          'dependency_declaration',
          dependencyDeclarationIdFor(baseInput.consumerTaskReference, baseInput.source),
          1,
        )?.payload,
      ).toMatchObject({
        revision: 1,
        packages: ['@ott/core-button', '@ott/core-theme'],
      });
    } finally {
      ledger.close();
    }
  });

  it('restores the latest declaration when the same Jira link payload is redelivered', () => {
    const clock = makeAdjustableClock('2026-08-25T08:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new DependencyDeclarationStore(ledger.repository, clock);
      const first = store.declare(baseInput);
      if (!first.ok) throw new Error(JSON.stringify(first.error));

      clock.advance(60_000);
      const repeated = store.declare({
        ...baseInput,
        packages: [...baseInput.packages].reverse(),
      });

      expect(repeated).toEqual(first);
    } finally {
      ledger.close();
    }
  });

  it('creates the next revision when the declaration changes for the same link identity', () => {
    const clock = makeAdjustableClock('2026-08-25T08:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new DependencyDeclarationStore(ledger.repository, clock);
      const first = store.declare(baseInput);
      if (!first.ok) throw new Error(JSON.stringify(first.error));

      clock.advance(60_000);
      const revised = store.declare({
        ...baseInput,
        mode: 'final_only',
      });

      expect(revised).toMatchObject({
        ok: true,
        value: {
          declarationId: first.value.declarationId,
          revision: 2,
          mode: 'final_only',
        },
      });
      expect(revised.ok && revised.value.hash).not.toBe(first.value.hash);
      expect(
        ledger.repository.readDocument('dependency_declaration', first.value.declarationId)
          ?.payload,
      ).toMatchObject({
        revision: 2,
        mode: 'final_only',
      });
    } finally {
      ledger.close();
    }
  });

  it('lists the latest declarations for one consumer task without duplicate revisions', () => {
    const clock = makeAdjustableClock('2026-08-25T08:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const store = new DependencyDeclarationStore(ledger.repository, clock);
      const first = store.declare(baseInput);
      if (!first.ok) throw new Error(JSON.stringify(first.error));

      const revised = store.declare({
        ...baseInput,
        mode: 'final_only',
      });
      if (!revised.ok) throw new Error(JSON.stringify(revised.error));

      const second = store.declare({
        ...baseInput,
        producerTaskReference: 'jira:AVIA-401',
        source: {
          kind: 'runtime_discovery',
          workflowRunId: 'workflow-run-2',
          requestArtifactId: 'artifact:dependency-request:2',
        },
      });
      if (!second.ok) throw new Error(JSON.stringify(second.error));

      const otherConsumer = store.declare({
        ...baseInput,
        consumerTaskReference: 'jira:AVIA-501',
        source: {
          kind: 'runtime_discovery',
          workflowRunId: 'workflow-run-3',
          requestArtifactId: 'artifact:dependency-request:3',
        },
      });
      if (!otherConsumer.ok) throw new Error(JSON.stringify(otherConsumer.error));

      const listed = store.listLatestByConsumerTask(baseInput.consumerTaskReference);

      expect(listed).toEqual({
        ok: true,
        value: [revised.value, second.value],
      });
    } finally {
      ledger.close();
    }
  });
});
