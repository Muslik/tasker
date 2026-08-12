import type {
  AcceptanceVerification,
  ImplementationPlan,
} from '../planning/implementation-plan.js';

type ImplementationPlanRisk = ImplementationPlan['risks'][number];

const linesFromVerification = (verification: AcceptanceVerification): readonly string[] => {
  switch (verification.kind) {
    case 'automated_test':
      return [
        `- [${verification.kind}] ${verification.level}/${verification.source}: ${verification.scenario}`,
      ];
    case 'process':
      return [`- [${verification.kind}] ${verification.profile}: ${verification.scenario}`];
    case 'runtime_evidence':
      return [
        `- [${verification.kind}] ${verification.scenario} (${verification.evidence.join(', ')})`,
      ];
    case 'inspection':
      return [`- [${verification.kind}] ${verification.target}: ${verification.expectation}`];
  }
};

const linesFromRisk = (risk: ImplementationPlanRisk): readonly string[] => [
  `- **Risk:** ${risk.risk}`,
  `  - **Mitigation:** ${risk.mitigation}`,
];

export const implementationPlanMarkdownFrom = ({
  plan,
  strategy,
  selectionReason,
}: {
  readonly plan: ImplementationPlan;
  readonly strategy: string;
  readonly selectionReason: string;
}): string => {
  const lines: string[] = [plan.summary];

  lines.push('', '## Execution steps', '');
  plan.steps.forEach((step, index) => {
    lines.push(`### ${String(index + 1)}. ${step.title}`, '', step.objective, '');
    lines.push(`- Repository: \`${step.repository}\``);
    if (step.files.length > 0) {
      lines.push('- Files:');
      step.files.forEach((file) => {
        lines.push(`  - \`${file}\``);
      });
    }
    lines.push('- Verification:');
    step.verification.forEach((verification) => {
      lines.push(`  - ${verification}`);
    });
    lines.push('');
  });

  lines.push('## Acceptance', '');
  plan.acceptanceCriteria.forEach((criterion, index) => {
    lines.push(`${String(index + 1)}. ${criterion.expected}`);
    criterion.verification.forEach((verification) => {
      lines.push(...linesFromVerification(verification).map((line) => `   ${line}`));
    });
    lines.push('');
  });

  if (plan.assumptions.length > 0) {
    lines.push('## Assumptions', '');
    plan.assumptions.forEach((assumption) => {
      lines.push(`- ${assumption}`);
    });
    lines.push('');
  }

  if (plan.risks.length > 0) {
    lines.push('## Risks', '');
    plan.risks.forEach((risk) => {
      lines.push(...linesFromRisk(risk));
    });
    lines.push('');
  }

  lines.push(
    '## Strategy note',
    '',
    `- Strategy: \`${strategy}\``,
    `- Why this strategy: ${selectionReason}`,
  );
  return lines.join('\n').trim();
};
