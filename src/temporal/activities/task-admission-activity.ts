import { Context } from '@temporalio/activity';

import type { ImplementationPlanningStore } from '../../control-plane/implementation-planning.js';
import type { JiraStartWorkAdapter } from '../../integrations/jira/lifecycle.js';
import type { WorkspaceStore } from '../../workspaces/store.js';
import {
  AdmitTaskExecutionInputSchema,
  AdmitTaskExecutionResultSchema,
  type BootstrapWorkflowActivities,
} from '../bootstrap-kernel/contracts.js';

export const createTaskAdmissionActivity = (
  snapshots: Pick<ImplementationPlanningStore, 'readRunSnapshot'>,
  workspaces: Pick<WorkspaceStore, 'read'>,
  jira: JiraStartWorkAdapter | null,
): Pick<BootstrapWorkflowActivities, 'admitTaskExecution'> => ({
  admitTaskExecution: async (inputValue) => {
    const input = AdmitTaskExecutionInputSchema.parse(inputValue);
    const snapshot = snapshots.readRunSnapshot(input.planningSnapshot);
    if (!snapshot.ok || snapshot.value.kind !== 'execution') {
      return AdmitTaskExecutionResultSchema.parse({
        status: 'needs_input',
        waitKind: 'admission.snapshot-required@1',
        summary: 'Task admission cannot read the frozen execution snapshot',
      });
    }
    if (snapshot.value.task.origin !== 'jira') {
      return AdmitTaskExecutionResultSchema.parse({
        status: 'completed',
        summary: 'Task origin does not require Jira admission',
      });
    }
    const workspace = workspaces.read(input.workspace.workspaceId);
    if (!workspace.ok || workspace.value === null) {
      return AdmitTaskExecutionResultSchema.parse({
        status: 'needs_input',
        waitKind: 'admission.workspace-required@1',
        summary: 'Task admission cannot restore the prepared workspace',
      });
    }
    if (jira === null) {
      return AdmitTaskExecutionResultSchema.parse({
        status: 'needs_input',
        waitKind: 'jira.start-work@1.configuration@1',
        summary: 'Jira start-work operation is not configured',
      });
    }

    const context = Context.current();
    context.heartbeat({ phase: 'jira_admission', taskReference: input.taskReference });
    const result = await jira.execute({
      operationId: `task-admission:${input.workflowId}:${input.workflowRunId}`,
      stepReference: jira.id,
      taskReference: input.taskReference,
      task: snapshot.value.task,
      taskSnapshot: snapshot.value.taskSnapshot,
      stepInput: {
        objective: snapshot.value.task.title,
        repository: snapshot.value.task.repository,
        taskId: snapshot.value.task.taskId,
      },
      workspace: workspace.value,
      operatorGuidance: input.operatorGuidance,
      waitResolution: input.waitResolution,
      evidence: {
        acceptedPlan: snapshot.value.acceptedPlan,
        completedSteps: [],
        reviewInputs: [],
      },
      policies: snapshot.value.harness.policies,
      project: snapshot.value.harness.project,
      runtime: {
        attempt: context.info.attempt,
        cancellationSignal: context.cancellationSignal,
        heartbeat: (details) => {
          context.heartbeat(details);
        },
      },
    });
    context.cancellationSignal.throwIfAborted();
    return result.status === 'completed'
      ? AdmitTaskExecutionResultSchema.parse({ status: 'completed', summary: result.summary })
      : AdmitTaskExecutionResultSchema.parse({
          status: 'needs_input',
          waitKind: result.status === 'waiting' ? result.waitKind : `${jira.id}.${result.kind}@1`,
          summary: result.summary,
        });
  },
});
