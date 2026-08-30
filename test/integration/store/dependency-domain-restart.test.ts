import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DependencyDeclarationStore } from '../../../src/server/dependency-declaration.js';
import { VerifiedPackagePublicationStore } from '../../../src/server/verified-package-publication.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/store/index.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('dependency domain persistence', () => {
  it('keeps declaration revisions and publication identity lookups across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-dependency-domain-'));
    const database = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-25T12:00:00.000Z');
    const firstLedger = openSqliteLedger({ filename: database, clock });
    resources.push({ directory, ledger: firstLedger });
    const declarations = new DependencyDeclarationStore(firstLedger.repository, clock);
    const publications = new VerifiedPackagePublicationStore(firstLedger.repository, clock);
    const firstDeclaration = declarations.declare({
      consumerTaskReference: 'jira:AVIA-500',
      producerTaskReference: 'jira:AVIA-400',
      producerRepository: 'front-core-packages',
      packages: ['@ott/core-button'],
      mode: 'final_only',
      source: {
        kind: 'runtime_discovery',
        workflowRunId: 'workflow-run-1',
        requestArtifactId: 'artifact:dependency-request:1',
      },
    });
    if (!firstDeclaration.ok) throw new Error(JSON.stringify(firstDeclaration.error));
    const revisedDeclaration = declarations.declare({
      consumerTaskReference: 'jira:AVIA-500',
      producerTaskReference: 'jira:AVIA-400',
      producerRepository: 'front-core-packages',
      packages: ['@ott/core-button', '@ott/core-theme'],
      mode: 'final_only',
      source: {
        kind: 'runtime_discovery',
        workflowRunId: 'workflow-run-1',
        requestArtifactId: 'artifact:dependency-request:1',
      },
    });
    if (!revisedDeclaration.ok) throw new Error(JSON.stringify(revisedDeclaration.error));
    const publication = publications.record({
      declarationId: revisedDeclaration.value.declarationId,
      declarationRevision: revisedDeclaration.value.revision,
      producerTaskReference: 'jira:AVIA-400',
      channel: 'final',
      packages: [
        {
          name: '@ott/core-button',
          version: '1.2.3',
          registry: 'https://registry.npmjs.org',
          tarballUrl: 'https://registry.npmjs.org/@ott/core-button/-/core-button-1.2.3.tgz',
          integrity: 'sha512-button',
        },
        {
          name: '@ott/core-theme',
          version: '1.2.3',
          registry: 'https://registry.npmjs.org',
          tarballUrl: 'https://registry.npmjs.org/@ott/core-theme/-/core-theme-1.2.3.tgz',
          integrity: 'sha512-theme',
        },
      ],
      sourceOperationId: 'operator:dependency-publication:attempt-2',
    });
    if (!publication.ok) throw new Error(JSON.stringify(publication.error));
    firstLedger.close();
    resources.pop();

    clock.advance(60_000);
    const restartedLedger = openSqliteLedger({ filename: database, clock });
    resources.push({ directory, ledger: restartedLedger });
    const restartedDeclarations = new DependencyDeclarationStore(restartedLedger.repository, clock);
    const restartedPublications = new VerifiedPackagePublicationStore(
      restartedLedger.repository,
      clock,
    );

    const latestDeclaration = restartedDeclarations.readLatest(
      revisedDeclaration.value.declarationId,
    );
    const firstRevision = restartedDeclarations.readRevision(
      revisedDeclaration.value.declarationId,
      1,
    );
    const restoredPublication = restartedPublications.readByExternalIdentity({
      sourceOperationId: 'operator:dependency-publication:attempt-2',
    });
    const declarationHistory = restartedPublications.listByDeclaration(
      revisedDeclaration.value.declarationId,
      revisedDeclaration.value.revision,
    );

    expect(latestDeclaration).toMatchObject({
      ok: true,
      value: {
        revision: 2,
        packages: ['@ott/core-button', '@ott/core-theme'],
      },
    });
    expect(firstRevision).toMatchObject({
      ok: true,
      value: {
        revision: 1,
        packages: ['@ott/core-button'],
      },
    });
    expect(restoredPublication).toMatchObject({
      ok: true,
      value: {
        observationId:
          'verified-package-publication:operation:operator:dependency-publication:attempt-2',
        channel: 'final',
      },
    });
    expect(declarationHistory).toMatchObject({
      ok: true,
      value: [{ declarationId: revisedDeclaration.value.declarationId, channel: 'final' }],
    });
  });
});
