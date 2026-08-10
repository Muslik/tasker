import {
  CompletionVerdictSchema,
  type AgentClaim,
  type CompletionEvidence,
  type CompletionEvaluator,
  type CompletionVerdict,
} from './contracts.js';

const references = (evidence: readonly CompletionEvidence[]): string[] => [
  ...new Set(evidence.map((item) => item.reference)),
];

const reject = (...reasons: string[]): CompletionVerdict =>
  CompletionVerdictSchema.parse({ status: 'rejected', reasons });

const evaluateRule = (
  evaluator: CompletionEvaluator,
  evidence: readonly CompletionEvidence[],
): CompletionVerdict => {
  switch (evaluator.kind) {
    case 'structured_evidence': {
      const kinds = new Set(
        evidence.flatMap((item) => (item.kind === 'artifact' ? [item.artifactKind] : [])),
      );
      const missing = evaluator.requiredArtifactKinds.filter((kind) => !kinds.has(kind));
      return missing.length === 0
        ? CompletionVerdictSchema.parse({
            status: 'accepted',
            evidenceReferences: references(evidence),
          })
        : reject(`Missing artifact evidence: ${missing.join(', ')}`);
    }
    case 'process_receipt': {
      const receipt = evidence.find(
        (item) =>
          item.kind === 'process' && (evaluator.acceptance === 'any_exit' || item.exitCode === 0),
      );
      return receipt === undefined
        ? reject(
            evaluator.acceptance === 'zero'
              ? 'Missing successful process receipt with exit code 0'
              : 'Missing completed process receipt',
          )
        : CompletionVerdictSchema.parse({
            status: 'accepted',
            evidenceReferences: [receipt.reference],
          });
    }
    case 'workspace_mutation': {
      const mutation = evidence.find((item) => item.kind === 'workspace_mutation' && item.changed);
      return mutation === undefined
        ? reject('No workspace mutation was proven')
        : CompletionVerdictSchema.parse({
            status: 'accepted',
            evidenceReferences: [mutation.reference],
          });
    }
    case 'reconciled_effect': {
      const effect = evidence.find((item) => item.kind === 'effect' && item.reconciled);
      return effect === undefined
        ? reject('No reconciled external-effect receipt was proven')
        : CompletionVerdictSchema.parse({
            status: 'accepted',
            evidenceReferences: [effect.reference],
          });
    }
    case 'all': {
      const verdicts = evaluator.evaluators.map((child) => evaluateRule(child, evidence));
      const reasons = verdicts.flatMap((verdict) =>
        verdict.status === 'rejected' ? verdict.reasons : [],
      );
      return reasons.length > 0
        ? reject(...reasons)
        : CompletionVerdictSchema.parse({
            status: 'accepted',
            evidenceReferences: references(evidence),
          });
    }
  }
};

export const evaluateBlockCompletion = (
  evaluator: CompletionEvaluator,
  claim: AgentClaim,
  evidence: readonly CompletionEvidence[],
): CompletionVerdict =>
  claim.status === 'candidate_complete'
    ? evaluateRule(evaluator, evidence)
    : reject(`Agent claim ${claim.status} is not a completion claim`);

export const acceptsAnyProcessExit = (evaluator: CompletionEvaluator): boolean =>
  evaluator.kind === 'process_receipt'
    ? evaluator.acceptance === 'any_exit'
    : evaluator.kind === 'all' && evaluator.evaluators.some(acceptsAnyProcessExit);
