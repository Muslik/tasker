import { type EvidenceBundle, type EvidenceBundleReference } from '../planning/index.js';
import type {
  WorkflowAnalyzerFailure,
  WorkflowAnalyzerRequest,
  WorkflowAnalyzerSuccess,
} from '../providers/index.js';
import type { Outcome } from '../shared/outcome.js';
import type { JsonValue } from '../workflow/index.js';
import type { EvidenceBundleStoreError } from './evidence-bundle.js';

export interface WorkflowAnalyzer {
  analyze(
    request: WorkflowAnalyzerRequest,
  ): Promise<Outcome<WorkflowAnalyzerSuccess, WorkflowAnalyzerFailure>>;
}

export interface WorkflowContextDiscovery {
  discover(input: {
    readonly taskReference: string;
    readonly operationId: string;
    readonly taskSnapshot: JsonValue;
    readonly plannerContext: JsonValue;
    readonly repositoryReference: string;
    readonly repositoryPath: string;
  }): Promise<
    Outcome<
      { readonly bundle: EvidenceBundle; readonly reference: EvidenceBundleReference },
      EvidenceBundleStoreError
    >
  >;
}

export const providerFailureSummary = (failure: WorkflowAnalyzerFailure): string => {
  switch (failure.kind) {
    case 'provider_unavailable':
      return failure.message;
    case 'provider_timed_out':
      return `Agent provider timed out after ${String(Math.round(failure.durationMs))} ms`;
    case 'provider_failed':
      return failure.message;
    case 'invalid_event_stream':
      return failure.message;
    case 'invalid_analyzer_output':
      return failure.issues.join('; ');
    case 'invalid_skill_selection':
      return failure.issues.join('; ');
    case 'invalid_skill_package':
    case 'skill_unavailable':
    case 'skill_materialization_failed':
      return failure.message;
  }
};
