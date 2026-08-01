import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import pino from 'pino';
import { z } from 'zod';

import {
  commandEnvelopeSchema,
  intakeRequestSchema,
  interventionEventSchema,
  manualTakeoverSchema,
  eventEnvelopeSchema,
  waitSchema,
} from '../domain/index.js';
import { openSqliteLedger, type AppliedMigration, type JsonValue } from '../ledger/index.js';
import {
  buildDebugBundleManifest,
  debugBundleManifestSchema,
  redactSourceValue,
  type SourceRedactionSummary,
} from '../observability/index.js';
import { makeAdjustableClock } from '../shared/index.js';
import {
  bounded_loop,
  branch,
  compileWorkflow,
  createPredicateRegistry,
  createStepTypeRegistry,
  createWaitRegistry,
  defineWorkflow,
  finalize,
  gate,
  JsonValueSchema,
  sequence,
  step,
  wait,
  WorkflowSourceSchema,
  type CompiledWorkflowArtifact,
  type CompiledWorkflowNode,
} from '../workflow/index.js';
import { m0Capabilities } from './m0-capabilities.js';
import { commitSourceEvent } from './safe-event-commit.js';

const DEMO_TIMESTAMP = '2026-08-01T12:00:00.000Z';

export interface M0DemoOptions {
  readonly outputDirectory?: string;
}

export interface M0DemoReport {
  readonly milestone: 'M0';
  readonly outputDirectory: string;
  readonly databasePath: string;
  readonly migrations: readonly AppliedMigration[];
  readonly tables: readonly string[];
  readonly workflow: {
    readonly id: string;
    readonly hash: string;
    readonly nodeCount: number;
    readonly artifactPath: string;
  };
  readonly fixtures: readonly {
    readonly name: string;
    readonly aggregateId: string;
    readonly eventId: string;
    readonly redactionStatus: 'clean' | 'redacted';
  }[];
  readonly debugBundlePath: string;
  readonly schemaCatalogPath: string;
  readonly schemaDiagramPath: string;
  readonly remoteCommandsCreated: 0;
  readonly capabilities: typeof m0Capabilities;
}

interface ContractFixture {
  readonly name: string;
  readonly aggregateId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly source: unknown;
}

const ensureEmptyOutputDirectory = (requestedDirectory: string | undefined): string => {
  if (requestedDirectory === undefined) {
    return mkdtempSync(join(tmpdir(), 'tasker-m0-demo-'));
  }

  if (!existsSync(requestedDirectory)) {
    mkdirSync(requestedDirectory, { recursive: true });
    return requestedDirectory;
  }

  if (readdirSync(requestedDirectory).length > 0) {
    throw new Error(`M0 demo output directory must be empty: ${requestedDirectory}`);
  }

  return requestedDirectory;
};

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const countWorkflowNodes = (node: CompiledWorkflowNode): number => {
  switch (node.kind) {
    case 'sequence':
      return 1 + node.children.reduce((total, child) => total + countWorkflowNodes(child), 0);
    case 'branch':
      return 1 + countWorkflowNodes(node.then) + countWorkflowNodes(node.otherwise);
    case 'bounded_loop':
      return 1 + countWorkflowNodes(node.body);
    case 'step':
    case 'wait':
    case 'gate':
    case 'finalize':
      return 1;
  }
};

const compileDemoWorkflow = (): CompiledWorkflowArtifact => {
  const predicates = createPredicateRegistry([
    {
      id: 'plan.review_required',
      version: '1',
      inputSchema: z.object({}),
    },
    {
      id: 'operator.plan_approved',
      version: '1',
      inputSchema: z.object({ actor: z.literal('operator') }).strict(),
    },
    {
      id: 'attempt.succeeded',
      version: '1',
      inputSchema: z.object({}),
    },
  ]);
  const stepTypes = createStepTypeRegistry([
    {
      id: 'analyzer.classify',
      version: '1',
      inputSchema: z.object({ issue: z.string().min(1) }).strict(),
      outputSchema: z.object({ taskType: z.string().min(1) }).strict(),
      allowedEffects: [],
      requiredCapabilities: [],
      resumeBoundary: 'step',
      idempotency: 'none',
      waitKinds: [],
      artifactContracts: ['workflow-proposal'],
    },
    {
      id: 'agent.implement',
      version: '1',
      inputSchema: z.object({ scope: z.string().min(1) }).strict(),
      outputSchema: z.object({ result: z.string().min(1) }).strict(),
      allowedEffects: [],
      requiredCapabilities: [],
      resumeBoundary: 'step',
      idempotency: 'none',
      waitKinds: ['quota_reset@1'],
      artifactContracts: ['patch'],
    },
  ]);
  const waits = createWaitRegistry([
    {
      id: 'quota_reset',
      version: '1',
      resolutionSchema: z.object({ resetAt: z.iso.datetime({ offset: true }) }).strict(),
      slotPolicy: 'release',
    },
    {
      id: 'code_review',
      version: '1',
      resolutionSchema: z.object({ reviewCycleId: z.string().min(1) }).strict(),
      slotPolicy: 'release',
    },
  ]);

  const source = defineWorkflow({
    id: 'bugfix-to-code-review',
    version: 1,
    root: sequence('delivery', [
      step('classify', {
        uses: 'analyzer.classify@1',
        with: { issue: 'AVIA-13236' },
      }),
      branch('optional-plan-review', {
        when: 'plan.review_required@1',
        then: sequence('plan-review-path', [
          gate('approve-plan', {
            reason: 'Operator requested plan review for this run.',
            resumeWhen: 'operator.plan_approved@1',
            with: { actor: 'operator' },
          }),
        ]),
        otherwise: sequence('autonomous-path', [
          step('prepare-implementation', {
            uses: 'agent.implement@1',
            with: { scope: 'prepare' },
          }),
        ]),
      }),
      bounded_loop('implementation-attempts', {
        maxAttempts: 3,
        until: 'attempt.succeeded@1',
        body: sequence('implementation-cycle', [
          step('implement', {
            uses: 'agent.implement@1',
            with: { scope: 'task' },
          }),
        ]),
      }),
      wait('await-code-review', {
        for: 'code_review@1',
      }),
      finalize('code-review-ready', {
        outcome: 'waiting_for_review',
      }),
    ]),
  });

  const result = compileWorkflow({
    contracts: { predicates, stepTypes, waits },
    source,
  });

  if (!result.ok) {
    throw new Error(`Built-in M0 workflow is invalid: ${JSON.stringify(result.error)}`);
  }

  return result.value;
};

const makeContractFixtures = (): readonly ContractFixture[] => {
  const intakeFailure = intakeRequestSchema.parse({
    id: 'intake-000001',
    source: 'jira',
    externalRef: 'AVIA-13236',
    createdAt: DEMO_TIMESTAMP,
    state: {
      status: 'waiting_for_intake_repair',
      repairAction: 'fix_jira_request',
      failure: {
        kind: 'invalid_input',
        code: 'jira_400',
        safeMessage: 'Jira rejected the request payload',
        source: 'integration',
        occurredAt: DEMO_TIMESTAMP,
        retryEvidence: { kind: 'none' },
        correlationId: 'correlation-000001',
        repairAction: 'fix_jira_request',
      },
    },
  });
  const quotaWait = waitSchema.parse({
    id: 'wait-000001',
    runId: 'run-000001',
    scope: 'provider:codex',
    kind: 'quota_reset',
    resumeCursor: 'implementation-attempts/implement',
    resolutionSchema: 'provider.quota_reset@1',
    slotPolicy: 'release',
    openedByEventId: 'event-000001',
    correlationId: 'correlation-000002',
    deadlineAt: '2026-08-01T13:00:00.000Z',
    status: 'open',
  });
  const intervention = interventionEventSchema.parse({
    id: 'intervention-000001',
    runId: 'run-000001',
    stepId: 'step-000001',
    priorAttemptId: 'attempt-000001',
    kind: 'operator_guidance',
    guidanceArtifactId: 'artifact-000001',
    author: { kind: 'operator', id: 'dzhabrail' },
    createdAt: DEMO_TIMESTAMP,
  });
  const takeover = manualTakeoverSchema.parse({
    id: 'takeover-000001',
    runId: 'run-000001',
    requestedBy: { kind: 'operator', id: 'dzhabrail' },
    requestedAt: DEMO_TIMESTAMP,
    cursor: 'implementation-attempts/implement',
    status: 'requested',
  });

  return [
    {
      name: 'jira_400_intake_failure',
      aggregateId: 'intake-000001',
      eventId: 'event-intake-000001',
      eventType: 'intake.repair_requested@1',
      source: {
        contract: intakeFailure,
        diagnostics: { authorization: 'Bearer demo-secret-must-not-persist' },
      },
    },
    {
      name: 'quota_wait_releases_slot',
      aggregateId: 'wait-000001',
      eventId: 'event-wait-000001',
      eventType: 'wait.opened@1',
      source: { contract: quotaWait },
    },
    {
      name: 'operator_intervention_is_append_only',
      aggregateId: 'intervention-000001',
      eventId: 'event-intervention-000001',
      eventType: 'intervention.recorded@1',
      source: { contract: intervention },
    },
    {
      name: 'manual_takeover_requests_ownership_transfer',
      aggregateId: 'takeover-000001',
      eventId: 'event-takeover-000001',
      eventType: 'takeover.requested@1',
      source: { contract: takeover },
    },
  ];
};

const toJsonSchema = (schema: z.ZodType): unknown =>
  z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  });

const asLedgerJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);

export const runM0Demo = (options: M0DemoOptions = {}): M0DemoReport => {
  const outputDirectory = ensureEmptyOutputDirectory(options.outputDirectory);
  const databasePath = join(outputDirectory, 'm0-ledger.sqlite');
  const workflowPath = join(outputDirectory, 'workflow.json');
  const schemaCatalogPath = join(outputDirectory, 'schemas.json');
  const fixtureCatalogPath = join(outputDirectory, 'fixtures.json');
  const debugBundlePath = join(outputDirectory, 'debug-bundle.json');
  const schemaReportPath = join(outputDirectory, 'schema-report.json');
  const schemaDiagramPath = join(outputDirectory, 'schema.mmd');
  const clock = makeAdjustableClock(DEMO_TIMESTAMP);
  const ledger = openSqliteLedger({ filename: databasePath, clock });

  try {
    const compiledWorkflow = compileDemoWorkflow();
    writeJson(workflowPath, compiledWorkflow);

    const schemaCatalog = {
      commandEnvelope: toJsonSchema(commandEnvelopeSchema),
      eventEnvelope: toJsonSchema(eventEnvelopeSchema),
      workflowSource: toJsonSchema(WorkflowSourceSchema),
      debugBundleManifest: toJsonSchema(debugBundleManifestSchema),
      intakeRequest: toJsonSchema(intakeRequestSchema),
      wait: toJsonSchema(waitSchema),
      interventionEvent: toJsonSchema(interventionEventSchema),
      manualTakeover: toJsonSchema(manualTakeoverSchema),
    };
    writeJson(schemaCatalogPath, schemaCatalog);

    const fixtureResults: M0DemoReport['fixtures'][number][] = [];
    const committedSummaries: SourceRedactionSummary[] = [];
    const fixtures = makeContractFixtures();

    for (const fixture of fixtures) {
      const result = commitSourceEvent(ledger.repository, {
        aggregateId: fixture.aggregateId,
        expectedVersion: 0,
        eventId: fixture.eventId,
        eventType: fixture.eventType,
        eventSchemaVersion: 1,
        source: fixture.source,
        redaction: {
          exactKeys: ['authorization', 'token', 'apiKey'],
          keyPatterns: [/secret$/iu],
        },
        occurredAt: DEMO_TIMESTAMP,
        correlationId: `correlation:${fixture.name}`,
        actor: 'm0-demo',
      });

      if (result.status !== 'committed') {
        throw new Error(`M0 fixture ${fixture.name} was not committed: ${JSON.stringify(result)}`);
      }

      committedSummaries.push(result.redaction);
      fixtureResults.push({
        name: fixture.name,
        aggregateId: fixture.aggregateId,
        eventId: fixture.eventId,
        redactionStatus: result.redaction.status,
      });
    }

    writeJson(fixtureCatalogPath, fixtureResults);

    const workflowRedaction = redactSourceValue(compiledWorkflow.graph);
    if (workflowRedaction.status === 'blocked') {
      throw new Error('The built-in workflow artifact failed source redaction');
    }

    const artifactCommit = ledger.repository.transact({
      artifacts: [
        {
          artifactId: 'artifact-workflow-000001',
          artifactKind: 'compiled_workflow',
          storageUri: pathToFileURL(workflowPath).href,
          payload: asLedgerJson(workflowRedaction.value),
          metadata: {
            redactionStatus: workflowRedaction.status,
            workflowHash: compiledWorkflow.hash,
          },
        },
        {
          artifactId: 'artifact-schemas-000001',
          artifactKind: 'json_schema_catalog',
          storageUri: pathToFileURL(schemaCatalogPath).href,
          payload: asLedgerJson(schemaCatalog),
          metadata: { redactionStatus: 'clean' },
        },
      ],
    });
    if (!artifactCommit.ok) {
      throw new Error(
        `M0 artifact transaction conflicted: ${JSON.stringify(artifactCommit.error)}`,
      );
    }

    const events = ledger.repository.listEvents();
    const redactedSummary = committedSummaries.find((summary) => summary.status === 'redacted');
    const debugBundle = buildDebugBundleManifest(
      {
        manifestId: 'debug-bundle-m0-000001',
        run: {
          runId: 'm0-contract-run-000001',
          workflowId: compiledWorkflow.graph.metadata.workflowId,
          versions: {
            run: 'm0-contract-run@1',
            workflow: `${compiledWorkflow.graph.metadata.irVersion}:${compiledWorkflow.hash}`,
            schema: ledger.appliedMigrations.map((migration) => migration.version).join(','),
          },
        },
        events: events.map((event) => ({
          eventId: event.eventId,
          kind: event.eventType,
          recordedAt: event.occurredAt,
        })),
        artifacts: [
          {
            artifactId: 'artifact-workflow-000001',
            kind: 'compiled_workflow',
            createdAt: DEMO_TIMESTAMP,
            redactionStatus: workflowRedaction.status,
          },
          {
            artifactId: 'artifact-schemas-000001',
            kind: 'json_schema_catalog',
            createdAt: DEMO_TIMESTAMP,
            redactionStatus: 'clean',
          },
        ],
        redaction:
          redactedSummary ??
          ({
            status: 'clean',
            redactedCount: 0,
            blockedCount: 0,
            redactions: [],
            blocked: [],
          } satisfies SourceRedactionSummary),
      },
      { clock },
    );
    writeJson(debugBundlePath, debugBundle);

    const debugArtifactCommit = ledger.repository.transact({
      artifacts: [
        {
          artifactId: 'artifact-debug-bundle-000001',
          artifactKind: 'debug_bundle',
          storageUri: pathToFileURL(debugBundlePath).href,
          payload: asLedgerJson(debugBundle),
          metadata: { redactionStatus: debugBundle.redaction.status },
        },
      ],
    });
    if (!debugArtifactCommit.ok) {
      throw new Error(
        `Debug bundle transaction conflicted: ${JSON.stringify(debugArtifactCommit.error)}`,
      );
    }

    const tables = ledger.database
      .prepare<[], { name: string }>(
        `
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name ASC
        `,
      )
      .all()
      .map((row) => row.name);
    writeJson(schemaReportPath, {
      migrations: ledger.appliedMigrations,
      tables,
    });
    writeFileSync(
      schemaDiagramPath,
      `erDiagram
  aggregate_heads ||--o{ events : versions
  aggregate_heads ||--o{ snapshots : snapshots
  leases ||--o{ outbox : fences
  events ||--o{ projections : projects
  artifacts ||--o{ artifacts : derives
`,
      'utf8',
    );

    const outboxCount = ledger.repository.listOutbox().length;
    if (outboxCount !== 0) {
      throw new Error(`M0 safety invariant violated: ${String(outboxCount)} remote commands exist`);
    }

    return {
      milestone: 'M0',
      outputDirectory,
      databasePath,
      migrations: ledger.appliedMigrations,
      tables,
      workflow: {
        id: compiledWorkflow.graph.metadata.workflowId,
        hash: compiledWorkflow.hash,
        nodeCount: countWorkflowNodes(compiledWorkflow.graph.root),
        artifactPath: workflowPath,
      },
      fixtures: fixtureResults,
      debugBundlePath,
      schemaCatalogPath,
      schemaDiagramPath,
      remoteCommandsCreated: 0,
      capabilities: m0Capabilities,
    };
  } finally {
    ledger.close();
  }
};

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const logger = pino({
    base: null,
    level: 'info',
    timestamp: false,
  });
  logger.info(runM0Demo(), 'M0 contract demo completed');
}
