import { z } from 'zod';

import type { M1WorkflowService } from '../control-plane/m1-service.js';
import {
  OperatorActivityEntrySchema,
  OperatorStreamEventSchema,
  type OperatorActivityResponse,
  type OperatorStreamEvent,
  type WorkflowResponse,
  type WorkflowTreeNode,
} from '../control-plane/m1-contracts.js';
import type { LedgerRepository } from '../ledger/repository.js';
import type { ArtifactWrite, EventRecord, JsonValue, LedgerConflict } from '../ledger/types.js';
import type { ImplementationPlanLink } from '../planning/implementation-plan.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { CompiledWorkflowSchema, type CompiledWorkflowNode } from '../workflow/schema.js';
import {
  DEFAULT_RUN_SETTINGS,
  PlanReviewCommandSchema,
  RunProjectionSchema,
  RunSettingsSchema,
  type ExecutingRunProjection,
  type PlanReviewCommand,
  type RunNodeStatus,
  type RunOperation,
  type RunProjection,
  type RunSettings,
} from './contracts.js';

const RUN_BY_TASK_PROJECTION = 'm2_run_by_task';
const RUN_PROJECTION = 'm1_run';

const RunEventPayloadSchema = z
  .object({
    taskReference: z.string().min(1),
    nodeId: z.string().min(1).optional(),
    uses: z.string().min(1).optional(),
    waitKind: z.string().min(1).optional(),
    slotPolicy: z.enum(['release', 'retain']).optional(),
    outcome: z.string().min(1).optional(),
    attempt: z.number().int().positive().optional(),
    guidanceArtifactId: z.string().min(1).optional(),
    nextAttempt: z.number().int().positive().optional(),
    targetNodeId: z.string().min(1).optional(),
    planApproval: z.enum(['required', 'automatic']).optional(),
    planningStrategy: z.enum(['auto', 'fast', 'ralplan']).optional(),
    artifactId: z.string().min(1).optional(),
  })
  .loose();

const GuidanceArtifactPayloadSchema = z.object({ guidance: z.string().min(1) }).strict();

export type StubRunError =
  | { readonly kind: 'workflow_not_found'; readonly taskReference: string }
  | { readonly kind: 'workflow_not_executable'; readonly taskReference: string }
  | { readonly kind: 'run_not_found'; readonly taskReference: string }
  | { readonly kind: 'run_not_waiting'; readonly taskReference: string }
  | { readonly kind: 'run_settings_conflict'; readonly taskReference: string }
  | { readonly kind: 'run_not_at_plan_review'; readonly taskReference: string }
  | { readonly kind: 'plan_revision_target_not_found'; readonly taskReference: string }
  | { readonly kind: 'projection_corrupt'; readonly projectionId: string }
  | { readonly kind: 'ledger_conflict'; readonly conflict: LedgerConflict };

export interface DriveOptions {
  /** Test seam for simulating a process death after committed node transitions. */
  readonly maxNodeTransitions?: number;
}

type LeaseBoundary =
  | { readonly kind: 'guard'; readonly lease: ExecutingRunProjection['lease'] }
  | { readonly kind: 'release'; readonly lease: ExecutingRunProjection['lease'] };

interface PersistOptions {
  readonly actor?: string;
  readonly artifacts?: readonly ArtifactWrite[];
  readonly signal?: {
    readonly signalId: string;
    readonly signalKind: string;
    readonly correlationKey: string;
    readonly payload: JsonValue;
    readonly status: string;
    readonly resolvedWaitKey: string;
  };
}

const asJson = (value: unknown): JsonValue => value as JsonValue;
const runIdFor = (taskReference: string): string => `run:${taskReference}`;
const waitIdFor = (runId: string, nodeId: string, cycle: number): string =>
  `wait:${runId}:${nodeId}:cycle-${String(cycle)}`;
const leaseKeyFor = (runId: string): string => `runner/${runId}`;

const executionPlan = (root: CompiledWorkflowNode): readonly RunOperation[] => {
  const operations: RunOperation[] = [];

  const visit = (node: CompiledWorkflowNode): void => {
    switch (node.kind) {
      case 'sequence':
        for (const child of node.children) visit(child);
        return;
      case 'bounded_loop':
        // Stub execution settles the first attempt successfully. Real executors will
        // append another attempt only when the persisted predicate says to continue.
        visit(node.body);
        return;
      case 'branch':
        // Predicates are not executed in the M2 stub lane. Choosing `then` is explicit
        // and deterministic so restart tests exercise cursor durability, not policy code.
        visit(node.then);
        return;
      case 'step':
        operations.push({ kind: 'step', nodeId: node.id, uses: node.uses });
        return;
      case 'wait':
        operations.push({
          kind: 'wait',
          nodeId: node.id,
          waitKind: node.for,
          slotPolicy: node.slotPolicy,
        });
        return;
      case 'gate':
        operations.push({
          kind: 'gate',
          nodeId: node.id,
          waitKind: node.resumeWhen,
          slotPolicy: 'release',
        });
        return;
      case 'finalize':
        operations.push({ kind: 'finalize', nodeId: node.id, outcome: node.outcome });
    }
  };

  visit(root);
  return operations;
};

const initialNodeStates = (plan: readonly RunOperation[]): Record<string, RunNodeStatus> =>
  Object.fromEntries(plan.map((operation) => [operation.nodeId, 'planned' as const]));

const decorateTree = (
  node: WorkflowTreeNode,
  nodeStates: Readonly<Record<string, RunNodeStatus>>,
): WorkflowTreeNode => {
  const children = node.children.map((child) => decorateTree(child, nodeStates));
  const directStatus = nodeStates[node.id];
  const childStatuses = children.map((child) => child.status);
  const derivedStatus: WorkflowTreeNode['status'] =
    directStatus ??
    (childStatuses.includes('failed')
      ? 'failed'
      : childStatuses.includes('waiting')
        ? 'waiting'
        : childStatuses.includes('running')
          ? 'running'
          : childStatuses.length > 0 &&
              childStatuses.every((status) => status === 'succeeded' || status === 'skipped')
            ? 'succeeded'
            : childStatuses.some((status) => status === 'succeeded' || status === 'skipped')
              ? 'running'
              : 'planned');

  return { ...node, status: derivedStatus, children };
};

export class DeterministicStubRunService {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly workflows: M1WorkflowService,
    private readonly clock: Clock,
  ) {}

  public read(taskReference: string): Outcome<RunProjection | null, StubRunError> {
    const projection = this.ledger.readProjection(RUN_BY_TASK_PROJECTION, taskReference);
    if (projection === null) return ok(null);
    const parsed = RunProjectionSchema.safeParse(projection.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({ kind: 'projection_corrupt', projectionId: taskReference });
  }

  public start(
    taskReference: string,
    settingsInput: RunSettings = DEFAULT_RUN_SETTINGS,
    options: DriveOptions = {},
    implementationPlan: ImplementationPlanLink | null = null,
  ): Outcome<RunProjection, StubRunError> {
    const settings = RunSettingsSchema.parse(settingsInput);
    const existing = this.read(taskReference);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      if (
        existing.value.settings.planApproval !== settings.planApproval ||
        existing.value.settings.planningStrategy !== settings.planningStrategy
      ) {
        return err({ kind: 'run_settings_conflict', taskReference });
      }
      if (existing.value.status === 'executing') return this.drive(existing.value, options);
      if (existing.value.status === 'queued') {
        return this.claim(taskReference, 'direct-stub-runner', options);
      }
      return ok(existing.value);
    }

    const queued = this.enqueue(taskReference, settings, implementationPlan);
    return queued.ok ? this.claim(taskReference, 'direct-stub-runner', options) : queued;
  }

  public enqueue(
    taskReference: string,
    settingsInput: RunSettings = DEFAULT_RUN_SETTINGS,
    implementationPlan: ImplementationPlanLink | null = null,
  ): Outcome<RunProjection, StubRunError> {
    const settings = RunSettingsSchema.parse(settingsInput);
    const existing = this.read(taskReference);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return existing.value.settings.planApproval === settings.planApproval &&
        existing.value.settings.planningStrategy === settings.planningStrategy
        ? ok(existing.value)
        : err({ kind: 'run_settings_conflict', taskReference });
    }

    const workflow = this.workflows.read(taskReference);
    if (!workflow.ok || workflow.value === null) {
      return err({ kind: 'workflow_not_found', taskReference });
    }
    if (workflow.value.status !== 'ready' || workflow.value.view.workflow.graph === null) {
      return err({ kind: 'workflow_not_executable', taskReference });
    }

    const graph = CompiledWorkflowSchema.safeParse(workflow.value.view.workflow.graph);
    if (!graph.success || workflow.value.view.workflow.graphHash === null) {
      return err({ kind: 'workflow_not_executable', taskReference });
    }

    const now = this.clock.now();
    const runId = runIdFor(taskReference);
    const plan = executionPlan(graph.data.root);
    const run = RunProjectionSchema.parse({
      schemaVersion: 1,
      runId,
      taskReference,
      taskId: workflow.value.view.task.id,
      workflowId: graph.data.metadata.workflowId,
      workflowHash: workflow.value.view.workflow.graphHash,
      status: 'queued',
      queuedAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      lease: null,
      cursor: 0,
      plan,
      nodeStates: initialNodeStates(plan),
      effects: [],
      planRevisionRequests: [],
      settings,
      implementationPlan,
      wait: null,
    });
    return this.persist(run, 'RunQueued', {
      taskReference,
      planApproval: settings.planApproval,
      planningStrategy: settings.planningStrategy,
      ...(implementationPlan === null ? {} : { artifactId: implementationPlan.artifactId }),
    });
  }

  public claim(
    taskReference: string,
    ownerId: string,
    options: DriveOptions = {},
  ): Outcome<RunProjection, StubRunError> {
    const current = this.read(taskReference);
    if (!current.ok) return current;
    if (current.value === null) return err({ kind: 'run_not_found', taskReference });
    if (current.value.status === 'executing') {
      return current.value.lease.ownerId === ownerId
        ? this.advanceClaimed(current.value, options)
        : ok(current.value);
    }
    if (current.value.status !== 'queued') return ok(current.value);

    const leaseKey = leaseKeyFor(current.value.runId);
    const acquired = this.ledger.transact({
      lease: { kind: 'acquire', leaseKey, ownerId },
      timestamp: this.clock.now(),
    });
    if (!acquired.ok) return err({ kind: 'ledger_conflict', conflict: acquired.error });
    if (acquired.value.lease === null) {
      throw new Error('Lease acquisition completed without a lease result');
    }

    const now = this.clock.now();
    const lease = {
      leaseKey,
      ownerId,
      fenceToken: acquired.value.lease.fenceToken,
    } as const;
    const executing = RunProjectionSchema.parse({
      ...current.value,
      status: 'executing',
      startedAt: current.value.startedAt ?? now,
      updatedAt: now,
      lease,
    });
    const persisted = this.persist(
      executing,
      'RunStarted',
      { taskReference, ownerId, fenceToken: lease.fenceToken },
      { kind: 'guard', lease },
    );
    if (!persisted.ok) return persisted;
    if (persisted.value.status !== 'executing') {
      throw new Error('Claim transition did not persist an executing run');
    }
    return this.advanceClaimed(persisted.value, options);
  }

  public replaceExpiredLease(
    taskReference: string,
    ownerId: string,
    options: DriveOptions = {},
  ): Outcome<RunProjection, StubRunError> {
    const current = this.read(taskReference);
    if (!current.ok) return current;
    if (current.value === null) return err({ kind: 'run_not_found', taskReference });
    if (current.value.status !== 'executing') return ok(current.value);

    const acquired = this.ledger.transact({
      lease: { kind: 'acquire', leaseKey: current.value.lease.leaseKey, ownerId },
      timestamp: this.clock.now(),
    });
    if (!acquired.ok) return err({ kind: 'ledger_conflict', conflict: acquired.error });
    if (acquired.value.lease === null) {
      throw new Error('Lease replacement completed without a lease result');
    }

    const lease = {
      leaseKey: current.value.lease.leaseKey,
      ownerId,
      fenceToken: acquired.value.lease.fenceToken,
    } as const;
    const replaced = RunProjectionSchema.parse({
      ...current.value,
      updatedAt: this.clock.now(),
      lease,
    });
    const persisted = this.persist(
      replaced,
      'RunLeaseReplaced',
      { taskReference, ownerId, fenceToken: lease.fenceToken },
      { kind: 'guard', lease },
    );
    if (!persisted.ok) return persisted;
    if (persisted.value.status !== 'executing') {
      throw new Error('Lease replacement did not persist an executing run');
    }
    return this.advanceClaimed(persisted.value, options);
  }

  public advanceClaimed(
    run: ExecutingRunProjection,
    options: DriveOptions = {},
  ): Outcome<RunProjection, StubRunError> {
    return this.drive(run, options);
  }

  public resume(
    taskReference: string,
    signalKind = 'operator_continue',
    options: DriveOptions = {},
  ): Outcome<RunProjection, StubRunError> {
    const resolved = this.resolveWait(taskReference, signalKind);
    return resolved.ok ? this.claim(taskReference, 'direct-stub-runner', options) : resolved;
  }

  public resolveWait(
    taskReference: string,
    signalKind = 'operator_continue',
  ): Outcome<RunProjection, StubRunError> {
    const current = this.read(taskReference);
    if (!current.ok) return current;
    if (current.value === null) return err({ kind: 'run_not_found', taskReference });
    if (current.value.status !== 'waiting') {
      return err({ kind: 'run_not_waiting', taskReference });
    }

    const now = this.clock.now();
    const wait = current.value.wait;
    const resumed = RunProjectionSchema.parse({
      ...current.value,
      status: 'queued',
      updatedAt: now,
      cursor: current.value.cursor + 1,
      nodeStates: { ...current.value.nodeStates, [wait.nodeId]: 'succeeded' },
      lease: null,
      wait: null,
    });
    const persisted = this.persist(
      resumed,
      'WaitResolved',
      { taskReference, nodeId: wait.nodeId, waitKind: wait.waitKind },
      undefined,
      {
        actor: 'operator',
        signal: {
          signalId: `signal:${wait.waitId}:resolved`,
          signalKind,
          correlationKey: wait.waitId,
          payload: { taskReference, nodeId: wait.nodeId },
          status: 'resolved',
          resolvedWaitKey: wait.waitId,
        },
      },
    );
    return persisted;
  }

  public reviewPlan(
    taskReference: string,
    commandInput: PlanReviewCommand,
  ): Outcome<RunProjection, StubRunError> {
    const command = PlanReviewCommandSchema.parse(commandInput);
    const current = this.read(taskReference);
    if (!current.ok) return current;
    if (current.value === null) return err({ kind: 'run_not_found', taskReference });
    const run = current.value;
    if (run.status !== 'waiting' || run.wait.waitKind !== 'plan.approved@1') {
      return err({ kind: 'run_not_at_plan_review', taskReference });
    }
    if (command.decision === 'approve') {
      return this.resolveWait(taskReference, 'plan_approved');
    }

    const review = run.wait;
    const targetIndex = run.plan.findLastIndex(
      (operation, index) =>
        index < run.cursor && operation.kind === 'step' && operation.uses === 'task.analyze@1',
    );
    const target = run.plan[targetIndex];
    if (targetIndex < 0 || target?.kind !== 'step') {
      return err({ kind: 'plan_revision_target_not_found', taskReference });
    }

    const priorAttempt = run.effects.filter((effect) => effect.nodeId === target.nodeId).length;
    if (priorAttempt < 1) {
      return err({ kind: 'plan_revision_target_not_found', taskReference });
    }
    const nextAttempt = priorAttempt + 1;
    const now = this.clock.now();
    const interventionId = `intervention:${run.runId}:${target.nodeId}:attempt-${String(nextAttempt)}`;
    const guidanceArtifactId = `guidance:${run.runId}:${target.nodeId}:attempt-${String(nextAttempt)}`;
    const revised = RunProjectionSchema.parse({
      ...run,
      status: 'queued',
      updatedAt: now,
      cursor: targetIndex,
      nodeStates: {
        ...run.nodeStates,
        [target.nodeId]: 'planned',
        [review.nodeId]: 'planned',
      },
      lease: null,
      wait: null,
      planRevisionRequests: [
        ...run.planRevisionRequests,
        {
          interventionId,
          reviewNodeId: review.nodeId,
          targetNodeId: target.nodeId,
          priorAttempt,
          nextAttempt,
          guidanceArtifactId,
          createdAt: now,
        },
      ],
    });
    return this.persist(
      revised,
      'PlanChangesRequested',
      {
        taskReference,
        nodeId: review.nodeId,
        targetNodeId: target.nodeId,
        guidanceArtifactId,
        attempt: priorAttempt,
        nextAttempt,
      },
      undefined,
      {
        actor: 'operator',
        artifacts: [
          {
            artifactId: guidanceArtifactId,
            artifactKind: 'operator_guidance',
            storageUri: `ledger://artifacts/${guidanceArtifactId}`,
            payload: { guidance: command.guidance },
            metadata: {
              taskReference,
              reviewNodeId: review.nodeId,
              targetNodeId: target.nodeId,
              priorAttempt,
              nextAttempt,
            },
            createdAt: now,
          },
        ],
        signal: {
          signalId: `signal:${review.waitId}:changes-requested`,
          signalKind: 'plan_changes_requested',
          correlationKey: review.waitId,
          payload: { taskReference, nodeId: review.nodeId, guidanceArtifactId },
          status: 'resolved',
          resolvedWaitKey: review.waitId,
        },
      },
    );
  }

  public recordPlanChanges(
    taskReference: string,
    guidanceInput: string,
  ): Outcome<RunProjection, StubRunError> {
    const command = PlanReviewCommandSchema.parse({
      decision: 'request_changes',
      guidance: guidanceInput,
    });
    if (command.decision !== 'request_changes') {
      throw new Error('Expected a request_changes command');
    }
    const current = this.read(taskReference);
    if (!current.ok) return current;
    if (current.value === null) return err({ kind: 'run_not_found', taskReference });
    const run = current.value;
    if (run.status !== 'waiting' || run.wait.waitKind !== 'plan.approved@1') {
      return err({ kind: 'run_not_at_plan_review', taskReference });
    }
    const review = run.wait;
    const targetIndex = run.plan.findLastIndex(
      (operation, index) =>
        index < run.cursor && operation.kind === 'step' && operation.uses === 'task.analyze@1',
    );
    const target = run.plan[targetIndex];
    if (targetIndex < 0 || target?.kind !== 'step') {
      return err({ kind: 'plan_revision_target_not_found', taskReference });
    }
    const priorAttempt =
      run.planRevisionRequests.at(-1)?.nextAttempt ??
      run.effects.filter((effect) => effect.nodeId === target.nodeId).length;
    if (priorAttempt < 1) {
      return err({ kind: 'plan_revision_target_not_found', taskReference });
    }
    const nextAttempt = priorAttempt + 1;
    const now = this.clock.now();
    const interventionId = `intervention:${run.runId}:${target.nodeId}:attempt-${String(nextAttempt)}`;
    const guidanceArtifactId = `guidance:${run.runId}:${target.nodeId}:attempt-${String(nextAttempt)}`;
    const recorded = RunProjectionSchema.parse({
      ...run,
      updatedAt: now,
      planRevisionRequests: [
        ...run.planRevisionRequests,
        {
          interventionId,
          reviewNodeId: review.nodeId,
          targetNodeId: target.nodeId,
          priorAttempt,
          nextAttempt,
          guidanceArtifactId,
          createdAt: now,
        },
      ],
    });
    return this.persist(
      recorded,
      'PlanChangesRequested',
      {
        taskReference,
        nodeId: review.nodeId,
        targetNodeId: target.nodeId,
        guidanceArtifactId,
        attempt: priorAttempt,
        nextAttempt,
      },
      undefined,
      {
        actor: 'operator',
        artifacts: [
          {
            artifactId: guidanceArtifactId,
            artifactKind: 'operator_guidance',
            storageUri: `ledger://artifacts/${guidanceArtifactId}`,
            payload: { guidance: command.guidance },
            metadata: {
              taskReference,
              reviewNodeId: review.nodeId,
              targetNodeId: target.nodeId,
              priorAttempt,
              nextAttempt,
            },
            createdAt: now,
          },
        ],
      },
    );
  }

  public applyPlanRevision(
    taskReference: string,
    implementationPlan: ImplementationPlanLink,
  ): Outcome<RunProjection, StubRunError> {
    const current = this.read(taskReference);
    if (!current.ok) return current;
    if (current.value === null) return err({ kind: 'run_not_found', taskReference });
    const run = current.value;
    if (run.status !== 'waiting' || run.wait.waitKind !== 'plan.approved@1') {
      return err({ kind: 'run_not_at_plan_review', taskReference });
    }
    const revision = run.planRevisionRequests.at(-1);
    if (revision === undefined) {
      return err({ kind: 'plan_revision_target_not_found', taskReference });
    }
    const targetIndex = run.plan.findIndex(
      (operation) => operation.kind === 'step' && operation.nodeId === revision.targetNodeId,
    );
    if (targetIndex < 0) {
      return err({ kind: 'plan_revision_target_not_found', taskReference });
    }
    const now = this.clock.now();
    const revised = RunProjectionSchema.parse({
      ...run,
      status: 'queued',
      updatedAt: now,
      cursor: targetIndex,
      nodeStates: {
        ...run.nodeStates,
        [revision.targetNodeId]: 'planned',
        [revision.reviewNodeId]: 'planned',
      },
      implementationPlan,
      lease: null,
      wait: null,
    });
    return this.persist(
      revised,
      'ImplementationPlanRevisionReady',
      {
        taskReference,
        nodeId: revision.reviewNodeId,
        targetNodeId: revision.targetNodeId,
        attempt: revision.nextAttempt,
        artifactId: implementationPlan.artifactId,
      },
      undefined,
      {
        actor: 'planner',
        signal: {
          signalId: `signal:${run.wait.waitId}:revision-ready-${String(revision.nextAttempt)}`,
          signalKind: 'plan_revision_ready',
          correlationKey: run.wait.waitId,
          payload: {
            taskReference,
            nodeId: revision.reviewNodeId,
            artifactId: implementationPlan.artifactId,
          },
          status: 'resolved',
          resolvedWaitKey: run.wait.waitId,
        },
      },
    );
  }

  public list(): Outcome<readonly RunProjection[], StubRunError> {
    const runs: RunProjection[] = [];
    for (const projection of this.ledger.listProjections(RUN_BY_TASK_PROJECTION)) {
      const parsed = RunProjectionSchema.safeParse(projection.payload);
      if (!parsed.success) {
        return err({ kind: 'projection_corrupt', projectionId: projection.projectionId });
      }
      runs.push(parsed.data);
    }
    return ok(runs);
  }

  public decorateWorkflow(response: WorkflowResponse): WorkflowResponse {
    const run = this.read(response.view.fixture.id);
    if (!run.ok || response.view.workflow.tree === null || response.status !== 'ready') {
      return response;
    }
    return {
      ...response,
      view: {
        ...response.view,
        workflow: {
          ...response.view.workflow,
          executable: true,
          tree:
            run.value === null
              ? response.view.workflow.tree
              : decorateTree(response.view.workflow.tree, run.value.nodeStates),
        },
      },
    };
  }

  public listEvents(taskReference?: string): readonly EventRecord[] {
    return taskReference === undefined
      ? this.ledger.listEvents().filter((event) => event.aggregateId.startsWith('run:'))
      : this.ledger.listEvents(runIdFor(taskReference));
  }

  public readActivity(taskReference: string): OperatorActivityResponse['entries'] {
    return this.listEvents(taskReference).map((event) => {
      const payload = RunEventPayloadSchema.parse(event.payload);
      const common = {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        level: 'info' as const,
      };
      switch (event.eventType) {
        case 'RunQueued':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'kernel',
            title: 'Run queued',
            detail:
              payload.planApproval === 'automatic'
                ? 'The validated plan will continue automatically unless execution needs operator input.'
                : 'The run will pause for operator review after producing its validated plan.',
          });
        case 'RunStarted':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'kernel',
            title: 'Run started',
            detail: 'The persisted workflow cursor entered deterministic stub execution.',
          });
        case 'StepStubbed':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'agent',
            title: payload.nodeId ?? 'Workflow step completed',
            detail: `${payload.uses ?? 'step'} attempt ${String(payload.attempt ?? 1)} produced a durable stub receipt.`,
          });
        case 'ImplementationPlanAttached':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'agent',
            title: 'Implementation plan attached',
            detail: `Planning attempt ${String(payload.attempt ?? 1)} is now the immutable input for execution.`,
          });
        case 'WaitOpened':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'kernel',
            title: `Waiting for ${(payload.waitKind ?? 'external signal').replace('@1', '').replaceAll('_', ' ')}`,
            detail: `The run cursor is durable and the runner slot is ${payload.slotPolicy === 'retain' ? 'retained' : 'released'}.`,
          });
        case 'WaitResolved':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'operator',
            title: payload.waitKind === 'plan.approved@1' ? 'Plan approved' : 'Wait resolved',
            detail: `Execution will continue after ${payload.nodeId ?? 'the persisted wait'}.`,
          });
        case 'PlanChangesRequested': {
          const artifact =
            payload.guidanceArtifactId === undefined
              ? null
              : this.ledger.readArtifact(payload.guidanceArtifactId);
          const guidance = GuidanceArtifactPayloadSchema.safeParse(artifact?.payload);
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'operator',
            title: `Plan changes requested · attempt ${String(payload.nextAttempt ?? '?')}`,
            detail: guidance.success
              ? guidance.data.guidance
              : 'Operator guidance was persisted as a separate artifact.',
          });
        }
        case 'PlanReviewAutoContinued':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'kernel',
            title: 'Plan review not required',
            detail: 'Immutable run settings allow execution to continue after plan validation.',
          });
        case 'ImplementationPlanRevisionReady':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'planner',
            title: `Implementation plan revised · attempt ${String(payload.attempt ?? '?')}`,
            detail: 'The new typed plan is persisted; execution will reattach it before review.',
          });
        case 'RunCompleted':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'kernel',
            title: 'Run completed',
            detail: `The workflow reached ${payload.outcome ?? 'its terminal outcome'}.`,
          });
        default:
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'kernel',
            title: event.eventType,
            detail: 'A durable run transition was committed.',
          });
      }
    });
  }

  public listStreamEventsAfter(sequence: number): readonly OperatorStreamEvent[] {
    return this.listEvents()
      .filter((event) => event.sequence > sequence)
      .flatMap((event) => {
        const taskReference = this.taskReferenceFor(event);
        return taskReference === null
          ? []
          : [
              OperatorStreamEventSchema.parse({
                sequence: event.sequence,
                fixtureId: taskReference,
                eventType: event.eventType,
              }),
            ];
      });
  }

  public taskReferenceFor(event: EventRecord): string | null {
    const parsed = RunEventPayloadSchema.safeParse(event.payload);
    return parsed.success ? parsed.data.taskReference : null;
  }

  private drive(
    initial: RunProjection,
    options: DriveOptions,
  ): Outcome<RunProjection, StubRunError> {
    let run = initial;
    let transitions = 0;
    const transitionLimit = options.maxNodeTransitions ?? Number.POSITIVE_INFINITY;

    while (run.status === 'executing' && transitions < transitionLimit) {
      const operation = run.plan[run.cursor];
      if (operation === undefined) {
        const completed = this.complete(run, 'completed');
        if (!completed.ok) return completed;
        run = completed.value;
        break;
      }

      const result = this.executeOperation(run, operation);
      if (!result.ok) return result;
      run = result.value;
      transitions += 1;
    }

    return ok(run);
  }

  private executeOperation(
    run: ExecutingRunProjection,
    operation: RunOperation,
  ): Outcome<RunProjection, StubRunError> {
    const now = this.clock.now();
    switch (operation.kind) {
      case 'step': {
        const attempt =
          run.effects.filter((effect) => effect.nodeId === operation.nodeId).length + 1;
        const effectKey = `${run.runId}:${operation.nodeId}:attempt-${String(attempt)}`;
        const planArtifactId =
          operation.uses === 'task.analyze@1' ? run.implementationPlan?.artifactId : undefined;
        const next = RunProjectionSchema.parse({
          ...run,
          updatedAt: now,
          cursor: run.cursor + 1,
          nodeStates: { ...run.nodeStates, [operation.nodeId]: 'succeeded' },
          effects: [
            ...run.effects,
            {
              effectKey,
              nodeId: operation.nodeId,
              uses: operation.uses,
              receiptId: `receipt:${effectKey}`,
              completedAt: now,
              ...(planArtifactId === undefined ? {} : { artifactId: planArtifactId }),
            },
          ],
        });
        return this.persist(
          next,
          planArtifactId === undefined ? 'StepStubbed' : 'ImplementationPlanAttached',
          {
            taskReference: run.taskReference,
            nodeId: operation.nodeId,
            uses: operation.uses,
            attempt,
            ...(planArtifactId === undefined ? {} : { artifactId: planArtifactId }),
          },
          { kind: 'guard', lease: run.lease },
        );
      }
      case 'gate':
      case 'wait': {
        if (
          operation.kind === 'gate' &&
          operation.waitKind === 'plan.approved@1' &&
          run.settings.planApproval === 'automatic'
        ) {
          const next = RunProjectionSchema.parse({
            ...run,
            updatedAt: now,
            cursor: run.cursor + 1,
            nodeStates: { ...run.nodeStates, [operation.nodeId]: 'skipped' },
          });
          return this.persist(
            next,
            'PlanReviewAutoContinued',
            {
              taskReference: run.taskReference,
              nodeId: operation.nodeId,
              waitKind: operation.waitKind,
              planApproval: run.settings.planApproval,
            },
            { kind: 'guard', lease: run.lease },
          );
        }
        const cycle =
          this.listEvents(run.taskReference).filter(
            (event) =>
              event.eventType === 'WaitOpened' &&
              RunEventPayloadSchema.safeParse(event.payload).data?.nodeId === operation.nodeId,
          ).length + 1;
        const waitId = waitIdFor(run.runId, operation.nodeId, cycle);
        const next = RunProjectionSchema.parse({
          ...run,
          status: 'waiting',
          updatedAt: now,
          nodeStates: { ...run.nodeStates, [operation.nodeId]: 'waiting' },
          lease: null,
          wait: {
            waitId,
            nodeId: operation.nodeId,
            waitKind: operation.waitKind,
            slotPolicy: operation.slotPolicy,
            openedAt: now,
          },
        });
        return this.persist(
          next,
          'WaitOpened',
          {
            taskReference: run.taskReference,
            nodeId: operation.nodeId,
            waitKind: operation.waitKind,
            slotPolicy: operation.slotPolicy,
          },
          { kind: 'release', lease: run.lease },
        );
      }
      case 'finalize':
        return this.complete(
          {
            ...run,
            cursor: run.cursor + 1,
            nodeStates: { ...run.nodeStates, [operation.nodeId]: 'succeeded' },
          },
          operation.outcome,
        );
    }
  }

  private complete(
    run: ExecutingRunProjection,
    outcome: string,
  ): Outcome<RunProjection, StubRunError> {
    const now = this.clock.now();
    return this.persist(
      RunProjectionSchema.parse({
        ...run,
        status: 'completed',
        updatedAt: now,
        completedAt: now,
        lease: null,
        wait: null,
      }),
      'RunCompleted',
      { taskReference: run.taskReference, outcome },
      { kind: 'release', lease: run.lease },
    );
  }

  private persist(
    run: RunProjection,
    eventType: string,
    payload: JsonValue,
    leaseBoundary?: LeaseBoundary,
    options: PersistOptions = {},
  ): Outcome<RunProjection, StubRunError> {
    const head = this.ledger.readAggregateHead(run.runId);
    const expectedVersion = head?.version ?? 0;
    const result = this.ledger.transact({
      ...(leaseBoundary === undefined
        ? {}
        : {
            fenceGuard: {
              leaseKey: leaseBoundary.lease.leaseKey,
              ownerId: leaseBoundary.lease.ownerId,
              expectedFenceToken: leaseBoundary.lease.fenceToken,
            },
          }),
      aggregate: {
        aggregateId: run.runId,
        expectedVersion,
        events: [
          {
            eventId: `event:${run.runId}:${String(expectedVersion + 1)}`,
            eventType,
            eventSchemaVersion: 1,
            payload,
            actor: options.actor ?? 'm2_deterministic_stub_runner',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: RUN_BY_TASK_PROJECTION,
          projectionId: run.taskReference,
          payload: asJson(run),
        },
        {
          kind: 'upsert',
          projectionType: RUN_PROJECTION,
          projectionId: run.runId,
          payload: asJson(run),
        },
      ],
      ...(leaseBoundary?.kind === 'release'
        ? {
            lease: {
              kind: 'release' as const,
              leaseKey: leaseBoundary.lease.leaseKey,
              ownerId: leaseBoundary.lease.ownerId,
              expectedFenceToken: leaseBoundary.lease.fenceToken,
            },
          }
        : {}),
      ...(options.signal === undefined ? {} : { signals: [options.signal] }),
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
      timestamp: run.updatedAt,
    });
    return result.ok ? ok(run) : err({ kind: 'ledger_conflict', conflict: result.error });
  }
}
