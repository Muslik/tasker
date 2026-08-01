import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  findTaskFixture,
  listTaskFixtures,
  planTaskWorkflow,
  type PlanningFailure,
  type PresentationNode,
  type TaskFixture,
  type WorkflowPresentationTree,
  type WorkflowProposalArtifact,
} from '../planning/index.js';
import { JsonValueSchema, type JsonValue, type ValidationReport } from '../workflow/index.js';
import {
  FixtureListResponseSchema,
  FixtureSummarySchema,
  WorkflowResponseSchema,
  WorkflowTreeNodeSchema,
  WorkflowViewSchema,
  type FixtureSummary,
  type WorkflowResponse,
  type WorkflowTreeNode,
  type WorkflowView,
} from './m1-contracts.js';
import { M1WorkflowStore, type M1StoreError, type M1WorkflowArtifacts } from './m1-store.js';

export type M1ServiceError =
  | {
      readonly kind: 'fixture_not_found';
      readonly fixtureId: string;
    }
  | {
      readonly kind: 'planner_contract_failure';
      readonly stage: PlanningFailure['stage'];
    }
  | {
      readonly kind: 'non_json_artifact';
      readonly artifact: 'compiled_graph' | 'diff' | 'proposal' | 'validator_report';
    }
  | {
      readonly kind: 'store_failure';
      readonly error: M1StoreError;
    };

interface BuiltView {
  readonly artifacts: M1WorkflowArtifacts;
  readonly view: WorkflowView;
}

const fixturePurpose = (fixture: TaskFixture): string => {
  if (fixture.expected === 'rejected') {
    return `Validator example: ${fixture.proposalVariant.replaceAll('_', ' ')}`;
  }

  switch (fixture.family) {
    case 'short_bugfix':
      return 'Short bugfix with reproduction, bounded repair, verification, and review wait';
    case 'feature_with_review':
      return 'Feature with optional plan gate, full verification, and review wait';
    case 'translation_cross_repo':
      return 'Cross-repository component work with translation and publish waits';
  }
};

const toFixtureSummary = (fixture: TaskFixture): FixtureSummary =>
  FixtureSummarySchema.parse({
    id: fixture.fixtureId,
    title: `${fixture.taskId} · ${fixture.title}`,
    family: fixture.expected === 'rejected' ? 'invalid_workflow' : fixture.family,
    purpose: fixturePurpose(fixture),
  });

const toJson = (
  value: unknown,
  artifact: 'compiled_graph' | 'diff' | 'proposal' | 'validator_report',
): Outcome<JsonValue, M1ServiceError> => {
  const result = JsonValueSchema.safeParse(value);
  return result.success ? ok(result.data) : err({ kind: 'non_json_artifact', artifact });
};

const childrenFor = (node: PresentationNode): readonly string[] => {
  switch (node.kind) {
    case 'sequence':
      return node.childIds;
    case 'branch':
      return [node.thenId, node.otherwiseId];
    case 'bounded_loop':
      return [node.bodyId];
    case 'finalize':
    case 'gate':
    case 'step':
    case 'wait':
      return [];
  }
};

const nodeLabel = (node: PresentationNode): string => {
  switch (node.kind) {
    case 'step':
      return `${node.id} · ${node.uses}`;
    case 'bounded_loop':
      return `${node.id} · max ${String(node.maxAttempts)}`;
    case 'wait':
      return `${node.id} · ${node.waitKind}`;
    case 'gate':
      return `${node.id} · ${node.reason}`;
    case 'finalize':
      return `${node.id} · ${node.outcome}`;
    case 'branch':
      return `${node.id} · ${node.when}`;
    case 'sequence':
      return node.id;
  }
};

const toTree = (presentation: WorkflowPresentationTree): WorkflowTreeNode => {
  const visit = (nodeId: string, ancestors: ReadonlySet<string>): WorkflowTreeNode => {
    if (ancestors.has(nodeId)) {
      throw new Error(`Presentation tree contains a cycle at ${nodeId}`);
    }

    const node = presentation.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`Presentation tree references missing node ${nodeId}`);
    }

    const nextAncestors = new Set(ancestors).add(nodeId);
    const retryBudget =
      node.kind === 'step'
        ? node.retryBudget
        : node.kind === 'bounded_loop'
          ? node.maxAttempts
          : null;

    return WorkflowTreeNodeSchema.parse({
      id: node.id,
      kind: node.kind,
      label: nodeLabel(node),
      status: node.status,
      retryBudget,
      ...(node.kind === 'wait' ? { waitKind: node.waitKind, slotPolicy: node.slotPolicy } : {}),
      children: childrenFor(node).map((childId) => visit(childId, nextAncestors)),
    });
  };

  return visit(presentation.rootId, new Set());
};

const verificationProfile = (
  proposal: WorkflowProposalArtifact,
): WorkflowView['workflow']['verificationPlan']['profile'] => {
  switch (proposal.verificationPlan.profile) {
    case 'targeted':
    case 'translation_and_targeted':
      return 'targeted_tests';
    case 'full':
      return 'full_suite';
    case 'full_with_visual':
      return 'visual_compare';
  }
};

const retryBudgetRecord = (proposal: WorkflowProposalArtifact): Record<string, number> =>
  Object.fromEntries(proposal.retryBudgets.map((budget) => [budget.nodeId, budget.maxAttempts]));

const baseWorkflowView = (
  fixture: TaskFixture,
  proposal: WorkflowProposalArtifact,
  persistedAt: string,
) => ({
  schemaVersion: 1 as const,
  fixture: toFixtureSummary(fixture),
  intake: {
    id: `intake:${fixture.fixtureId}`,
    status: 'accepted' as const,
    eligibility: {
      eligible: true,
      reason: 'Local M1 fixtures are eligible for deterministic planning only.',
    },
  },
  task: {
    id: fixture.taskId,
  },
  workflow: {
    proposalId: `proposal:${fixture.fixtureId}`,
    templateId: `${proposal.templateId}@1`,
    capabilities: proposal.capabilities,
    retryBudgets: retryBudgetRecord(proposal),
    waits: proposal.waits.map((wait) => ({
      nodeId: wait.nodeId,
      waitKind: wait.waitKind,
      slotPolicy: wait.slotPolicy,
    })),
    expectedArtifacts: [
      ...new Set(proposal.expectedArtifacts.map((artifact) => artifact.kind)),
    ].sort((left, right) => left.localeCompare(right)),
    verificationPlan: {
      profile: verificationProfile(proposal),
      rationale: proposal.verificationPlan.rationale,
    },
    executable: false as const,
  },
  persistedAt,
});

const rejectedValidatorReport = (failure: PlanningFailure): ValidationReport => {
  switch (failure.stage) {
    case 'workflow_validation':
      return failure.validatorReport;
    case 'capability_validation':
      return {
        workflowId: `${failure.proposal.fixture.fixtureId}-workflow`,
        issues: [
          {
            code: 'unknown_reference',
            message: `Missing required capabilities: ${failure.missingCapabilities.join(', ')}`,
            path: ['capabilities'],
            details: {
              missingCapabilities: failure.missingCapabilities,
              recovery: 'reject',
            },
          },
        ],
      };
    case 'diff':
      return {
        workflowId: `${failure.proposal.fixture.fixtureId}-workflow`,
        issues: [
          {
            code: 'invalid_source',
            message: `Could not compare ${failure.side} graph with the selected template`,
            path: ['diff'],
          },
        ],
      };
    case 'fixture':
    case 'proposal':
      throw new Error(`Planning failed before a proposal existed at ${failure.stage}`);
  }
};

const rejectedProposal = (failure: PlanningFailure): WorkflowProposalArtifact | null => {
  switch (failure.stage) {
    case 'workflow_validation':
    case 'capability_validation':
    case 'diff':
      return failure.proposal;
    case 'fixture':
    case 'proposal':
      return null;
  }
};

const buildAcceptedView = (
  fixture: TaskFixture,
  planned: Extract<ReturnType<typeof planTaskWorkflow>, { readonly ok: true }>['value'],
  persistedAt: string,
): Outcome<BuiltView, M1ServiceError> => {
  const graph = toJson(planned.compiled.graph, 'compiled_graph');
  const proposal = toJson(planned.proposal, 'proposal');
  const diff = toJson(planned.diff, 'diff');
  const validatorReport = toJson(planned.compiled.validatorReport, 'validator_report');

  if (!graph.ok) return graph;
  if (!proposal.ok) return proposal;
  if (!diff.ok) return diff;
  if (!validatorReport.ok) return validatorReport;

  const common = baseWorkflowView(fixture, planned.proposal, persistedAt);
  const view = WorkflowViewSchema.parse({
    ...common,
    task: { ...common.task, status: 'planned' },
    workflow: {
      ...common.workflow,
      status: 'valid',
      graphHash: planned.compiled.hash,
      graph: graph.value,
      tree: toTree(planned.presentation),
      validatorReport: planned.compiled.validatorReport,
      diff: planned.diff.entries.map((entry) => ({
        ...entry,
        path: `/${entry.path.map(String).join('/')}`,
      })),
    },
  });

  return ok({
    view,
    artifacts: {
      compiledGraph: graph.value,
      proposal: proposal.value,
      diff: diff.value,
      validatorReport: validatorReport.value,
    },
  });
};

const buildRejectedView = (
  fixture: TaskFixture,
  failure: PlanningFailure,
  persistedAt: string,
): Outcome<BuiltView, M1ServiceError> => {
  const proposalValue = rejectedProposal(failure);
  if (proposalValue === null) {
    return err({ kind: 'planner_contract_failure', stage: failure.stage });
  }

  const proposal = toJson(proposalValue, 'proposal');
  const validatorReportValue = rejectedValidatorReport(failure);
  const validatorReport = toJson(validatorReportValue, 'validator_report');
  const emptyDiff = { entries: [], templateId: proposalValue.templateId };
  const diff = toJson(emptyDiff, 'diff');

  if (!proposal.ok) return proposal;
  if (!validatorReport.ok) return validatorReport;
  if (!diff.ok) return diff;

  const common = baseWorkflowView(fixture, proposalValue, persistedAt);
  const view = WorkflowViewSchema.parse({
    ...common,
    task: { ...common.task, status: 'workflow_rejected' },
    workflow: {
      ...common.workflow,
      status: 'rejected',
      graphHash: null,
      graph: null,
      tree: null,
      validatorReport: validatorReportValue,
      diff: [],
    },
  });

  return ok({
    view,
    artifacts: {
      proposal: proposal.value,
      diff: diff.value,
      validatorReport: validatorReport.value,
    },
  });
};

export class M1WorkflowService {
  public constructor(
    private readonly store: M1WorkflowStore,
    private readonly clock: Clock,
  ) {}

  public listFixtures(): ReturnType<typeof FixtureListResponseSchema.parse> {
    return FixtureListResponseSchema.parse({ fixtures: listTaskFixtures().map(toFixtureSummary) });
  }

  public read(fixtureId: string): Outcome<WorkflowResponse | null, M1ServiceError> {
    const stored = this.store.read(fixtureId);
    if (!stored.ok) {
      return err({ kind: 'store_failure', error: stored.error });
    }

    if (stored.value === null) {
      return ok(null);
    }

    return ok(
      WorkflowResponseSchema.parse({
        status: stored.value.workflow.status === 'valid' ? 'ready' : 'rejected',
        view: stored.value,
      }),
    );
  }

  public readProjection(
    projectionType: 'm1_intake' | 'm1_run' | 'm1_task',
    projectionId: string,
  ): JsonValue | null {
    return this.store.readProjection(projectionType, projectionId);
  }

  public generate(fixtureId: string): Outcome<WorkflowResponse, M1ServiceError> {
    const fixture = findTaskFixture(fixtureId);
    if (fixture === undefined) {
      return err({ kind: 'fixture_not_found', fixtureId });
    }

    const existing = this.read(fixtureId);
    if (!existing.ok) return existing;
    if (existing.value !== null) return ok(existing.value);

    const planning = planTaskWorkflow(fixture);
    const built = planning.ok
      ? buildAcceptedView(fixture, planning.value, this.clock.now())
      : buildRejectedView(fixture, planning.error, this.clock.now());

    if (!built.ok) return built;

    const saved = this.store.save(built.value.view, built.value.artifacts);
    if (!saved.ok) {
      return err({ kind: 'store_failure', error: saved.error });
    }

    return ok(
      WorkflowResponseSchema.parse({
        status: saved.value.view.workflow.status === 'valid' ? 'ready' : 'rejected',
        view: saved.value.view,
      }),
    );
  }
}

export const createM1WorkflowService = (
  ledger: ConstructorParameters<typeof M1WorkflowStore>[0],
  clock: Clock,
): M1WorkflowService => new M1WorkflowService(new M1WorkflowStore(ledger, clock), clock);
