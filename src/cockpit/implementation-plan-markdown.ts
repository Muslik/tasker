import type {
  AcceptanceVerification,
  ImplementationPlan,
} from '../planning/implementation-plan.js';

type ImplementationPlanRisk = ImplementationPlan['risks'][number];

const automatedTestLevelLabels = {
  unit: 'unit test',
  integration: 'integration test',
  e2e: 'end-to-end test',
  visual: 'visual test',
} as const satisfies Record<
  Extract<AcceptanceVerification, { kind: 'automated_test' }>['level'],
  string
>;

const evidenceLabels = {
  video: 'video',
  image: 'screenshot',
  log: 'logs',
  structured_output: 'structured result',
} as const satisfies Record<
  Extract<AcceptanceVerification, { kind: 'runtime_evidence' }>['evidence'][number],
  string
>;

const processProfileLabel = (profile: string): string => {
  if (profile === 'full_with_visual') return 'Full verification with visual comparison';
  if (profile === 'full') return 'Full verification';
  return profile
    .split(/[_-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
};

const listPhrase = (items: readonly string[]): string => {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
};

const linesFromVerification = (verification: AcceptanceVerification): readonly string[] => {
  switch (verification.kind) {
    case 'automated_test':
      return [
        `- **${verification.source === 'existing' ? 'Existing' : 'New'} ${automatedTestLevelLabels[verification.level]}:** ${verification.scenario}`,
      ];
    case 'process':
      return [`- **${processProfileLabel(verification.profile)}:** ${verification.scenario}`];
    case 'runtime_evidence':
      return [
        `- **Runtime evidence:** ${verification.scenario} Artifacts: ${listPhrase(verification.evidence.map((evidence) => evidenceLabels[evidence]))}.`,
      ];
    case 'inspection':
      return [`- **Inspect ${verification.target}:** ${verification.expectation}`];
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
