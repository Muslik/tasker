import type { z } from 'zod';

import {
  ExecutionRunViewSchema,
  RestartRunCommandSchema,
  ResumeRunCommandSchema,
  type ExecutionRunView,
} from '../../server/operator-contracts.js';
import {
  ApprovePlanReviewCommandSchema,
  RequestPlanChangesCommandSchema,
} from '../../server/plan-review.js';
import { postJson } from './http.js';

export type ResumeTaskWorkflowInput = z.input<typeof ResumeRunCommandSchema>;
export type ApproveTaskPlanInput = z.input<typeof ApprovePlanReviewCommandSchema>;
export type RequestTaskPlanChangesInput = z.input<typeof RequestPlanChangesCommandSchema>;
export type RestartTaskWorkflowInput = z.input<typeof RestartRunCommandSchema>;

export const resumeTaskWorkflow = async (
  taskReference: string,
  input: ResumeTaskWorkflowInput,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/resume`,
    ResumeRunCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const approveTaskPlan = async (
  taskReference: string,
  input: ApproveTaskPlanInput,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/plan-review`,
    ApprovePlanReviewCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const requestTaskPlanChanges = async (
  taskReference: string,
  input: RequestTaskPlanChangesInput,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/plan-review`,
    RequestPlanChangesCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const restartTaskWorkflow = async (
  taskReference: string,
  input: RestartTaskWorkflowInput,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/restart`,
    RestartRunCommandSchema,
    ExecutionRunViewSchema,
    input,
  );
