import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { OperatorWorkflowStage } from '../../../src/control-plane/operator-contracts.js';
import { compactCommand } from '../../../src/cockpit/App.js';
import { WorkflowStages } from '../../../src/cockpit/WorkflowStages.js';

const stage = (
  key: string,
  id: string,
  label: string,
  status: OperatorWorkflowStage['status'],
): OperatorWorkflowStage => ({ key, id, label, status, steps: [] });

describe('operator workflow presentation', () => {
  it('projects graph suffixes into one semantic journey with one terminal stage', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowStages, {
        stages: [
          stage('bootstrap:workspace', 'workspace', 'Workspace', 'succeeded'),
          stage('execution:development', 'development', 'Development', 'succeeded'),
          stage('execution:complete', 'complete', 'Complete', 'succeeded'),
          stage('continuation:2:development', 'development', 'Development', 'running'),
          stage('continuation:2:complete', 'complete', 'Complete', 'planned'),
        ],
      }),
    );

    expect(html.match(/>Development</gu)).toHaveLength(1);
    expect(html.match(/>Complete</gu)).toHaveLength(1);
    expect(html).toContain('stage running');
  });

  it('keeps command headers compact while preserving meaningful command text', () => {
    expect(
      compactCommand(
        `/usr/bin/bash -lc "cd '/Users/test/Library/Application Support/Tasker/worktrees/${'a'.repeat(24)}' && pnpm run test:ui:docker"`,
      ),
    ).toBe('"cd \'$WORKSPACE\' && pnpm run test:ui:docker"');
  });
});
