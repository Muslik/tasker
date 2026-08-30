import type {
  AcceptanceVerification,
  ImplementationPlan,
} from '../../planning/implementation-plan.js';

const testLabels = {
  unit: 'unit test',
  integration: 'integration test',
  e2e: 'end-to-end test',
  visual: 'visual test',
} as const;
const evidenceLabels = {
  video: 'video',
  image: 'screenshot',
  log: 'logs',
  structured_output: 'structured result',
} as const;
const listPhrase = (items: readonly string[]): string =>
  items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
const profileLabel = (profile: string): string => {
  if (profile === 'full_with_visual') return 'Full verification with visual comparison';
  if (profile === 'full') return 'Full verification';
  return profile
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
};
const verificationLines = (verification: AcceptanceVerification): readonly string[] => {
  switch (verification.kind) {
    case 'automated_test':
      return [
        `- **${verification.source === 'existing' ? 'Existing' : 'New'} ${testLabels[verification.level]}:** ${verification.scenario}`,
      ];
    case 'process':
      return [`- **${profileLabel(verification.profile)}:** ${verification.scenario}`];
    case 'runtime_evidence':
      return [
        `- **Runtime evidence:** ${verification.scenario} Artifacts: ${listPhrase(verification.evidence.map((item) => evidenceLabels[item]))}.`,
      ];
    case 'inspection':
      return [`- **Inspect ${verification.target}:** ${verification.expectation}`];
  }
};

export const implementationPlanMarkdownFrom = ({
  plan,
  strategy,
  selectionReason,
}: {
  readonly plan: ImplementationPlan;
  readonly strategy: string;
  readonly selectionReason: string;
}): string => {
  const lines = [plan.summary, '', '## Execution steps', ''];
  plan.steps.forEach((step, index) => {
    lines.push(
      `### ${String(index + 1)}. ${step.title}`,
      '',
      step.objective,
      '',
      `- Repository: \`${step.repository}\``,
    );
    if (step.files.length > 0)
      lines.push('- Files:', ...step.files.map((file) => `  - \`${file}\``));
    lines.push('- Verification:', ...step.verification.map((item) => `  - ${item}`), '');
  });
  lines.push('## Acceptance', '');
  plan.acceptanceCriteria.forEach((criterion, index) => {
    lines.push(`${String(index + 1)}. ${criterion.expected}`);
    criterion.verification.forEach((item) =>
      lines.push(...verificationLines(item).map((line) => `   ${line}`)),
    );
    lines.push('');
  });
  if (plan.assumptions.length > 0)
    lines.push('## Assumptions', '', ...plan.assumptions.map((item) => `- ${item}`), '');
  if (plan.risks.length > 0)
    lines.push(
      '## Risks',
      '',
      ...plan.risks.flatMap((risk) => [
        `- **Risk:** ${risk.risk}`,
        `  - **Mitigation:** ${risk.mitigation}`,
      ]),
      '',
    );
  lines.push(
    '## Strategy note',
    '',
    `- Strategy: \`${strategy}\``,
    `- Why this strategy: ${selectionReason}`,
  );
  return lines.join('\n').trim();
};
