import { createWorkflowAnalyzerContext, findTaskFixture } from '../planning/index.js';
import type { CodexCliWorkflowAnalyzer, CodexWorkflowAnalyzerFailure } from '../providers/index.js';
import { err, type Outcome } from '../shared/outcome.js';
import type { WorkflowResponse } from './m1-contracts.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';

export type WorkflowGenerationResult = Outcome<WorkflowResponse, M1ServiceError>;

export interface WorkflowGenerator {
  generate(fixtureId: string): Promise<WorkflowGenerationResult>;
}

export class CodexWorkflowGenerator implements WorkflowGenerator {
  private readonly inFlight = new Map<string, Promise<WorkflowGenerationResult>>();

  public constructor(
    private readonly service: M1WorkflowService,
    private readonly analyzer: CodexCliWorkflowAnalyzer,
    private readonly repositoryPath: string,
  ) {}

  public generate(fixtureId: string): Promise<WorkflowGenerationResult> {
    const current = this.inFlight.get(fixtureId);
    if (current !== undefined) return current;

    const generation = this.generateOnce(fixtureId).finally(() => {
      this.inFlight.delete(fixtureId);
    });
    this.inFlight.set(fixtureId, generation);
    return generation;
  }

  private async generateOnce(fixtureId: string): Promise<WorkflowGenerationResult> {
    const existing = this.service.read(fixtureId);
    if (!existing.ok) return existing;
    if (existing.value !== null) return { ok: true, value: existing.value };

    const fixture = findTaskFixture(fixtureId);
    if (fixture === undefined) {
      return err({ kind: 'fixture_not_found', fixtureId });
    }

    const analyzed = await this.analyzer.analyze({
      ...createWorkflowAnalyzerContext(fixture),
      repositoryPath: this.repositoryPath,
    });
    if (!analyzed.ok) {
      return err({
        kind: 'provider_failure',
        provider: 'codex_cli',
        failure: analyzed.error,
      });
    }

    return this.service.generateFromAnalyzerOutput(
      fixtureId,
      analyzed.value.output,
      analyzed.value.receipt,
    );
  }
}

export const providerFailureSummary = (failure: CodexWorkflowAnalyzerFailure): string => {
  switch (failure.kind) {
    case 'provider_unavailable':
      return failure.message;
    case 'provider_timed_out':
      return `Codex timed out after ${String(Math.round(failure.durationMs))} ms`;
    case 'provider_failed':
      return failure.message;
    case 'invalid_event_stream':
      return failure.message;
    case 'invalid_analyzer_output':
      return failure.issues.join('; ');
  }
};
