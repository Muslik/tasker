import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runM0Demo } from '../../src/app/m0-demo.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('M0 operator demo', () => {
  it('creates a durable, inspectable contract run without remote commands', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'tasker-m0-operator-'));
    directories.push(outputDirectory);

    const report = runM0Demo({ outputDirectory });
    const workflowArtifact = JSON.parse(readFileSync(report.workflow.artifactPath, 'utf8')) as {
      readonly graph: { readonly root: { readonly kind: string } };
    };
    const debugBundleText = readFileSync(report.debugBundlePath, 'utf8');

    expect(report.migrations).toHaveLength(1);
    expect(report.tables).toEqual(
      expect.arrayContaining(['events', 'aggregate_heads', 'outbox', 'leases', 'artifacts']),
    );
    expect(report.workflow.nodeCount).toBeGreaterThan(7);
    expect(workflowArtifact.graph.root.kind).toBe('sequence');
    expect(report.fixtures.map((fixture) => fixture.name)).toEqual([
      'jira_400_intake_failure',
      'quota_wait_releases_slot',
      'operator_intervention_is_append_only',
      'manual_takeover_requests_ownership_transfer',
    ]);
    expect(report.remoteCommandsCreated).toBe(0);
    expect(report.capabilities.canExecuteRemoteEffects).toBe(false);
    expect(existsSync(report.schemaDiagramPath)).toBe(true);
    expect(debugBundleText).not.toContain('demo-secret-must-not-persist');
  });
});
