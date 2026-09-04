import { describe, expect, it } from 'vitest';

import {
  projectOperatorActivity,
  type OperatorActivitySources,
} from './operator-activity-projection.js';

const entry = (
  title: string,
  detail: string,
  occurredAt: string,
): OperatorActivitySources['workflow'][number] => ({
  sequence: 1,
  occurredAt,
  source: 'planner',
  level: 'info',
  title,
  detail,
});

const emptySources = (): OperatorActivitySources => ({
  jira: [],
  workflow: [],
  implementationPlanning: [],
  continuation: [],
  execution: [],
});

describe('operator activity projection', () => {
  it('lets implementation planning own candidate validation without matching detail text', () => {
    const projected = projectOperatorActivity({
      ...emptySources(),
      workflow: [
        entry('Workflow candidate corrected', 'Legacy workflow wording.', '2026-08-12T12:01:00Z'),
        entry('Workflow compiled and persisted', 'Graph accepted.', '2026-08-12T12:02:00Z'),
      ],
      implementationPlanning: [
        entry('Workflow candidate corrected', 'Current planning wording.', '2026-08-12T12:01:00Z'),
      ],
    });

    expect(projected.map(({ title, detail }) => [title, detail])).toEqual([
      ['Workflow candidate corrected', 'Current planning wording.'],
      ['Workflow compiled and persisted', 'Graph accepted.'],
    ]);
  });

  it('keeps workflow validation when no planning projection owns it', () => {
    const projected = projectOperatorActivity({
      ...emptySources(),
      workflow: [entry('Workflow rejected', 'Invalid graph.', '2026-08-12T12:00:00Z')],
    });

    expect(projected).toMatchObject([{ sequence: 1, title: 'Workflow rejected' }]);
  });
});
