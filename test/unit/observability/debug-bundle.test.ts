import { describe, expect, it } from 'vitest';

import {
  buildDebugBundleManifest,
  debugBundleManifestSchema,
} from '../../../src/observability/debug-bundle.js';
import { redactSourceValue } from '../../../src/observability/redaction.js';

describe('buildDebugBundleManifest', () => {
  it('builds a deterministic manifest with sorted references and redaction summary only', () => {
    const redaction = redactSourceValue(
      {
        transcript: {
          apiKey: 'very-secret',
        },
      },
      {
        exactKeys: ['apiKey'],
      },
    );

    expect(redaction.status).toBe('redacted');
    if (redaction.status !== 'redacted') {
      throw new Error('Expected redacted summary');
    }

    const manifest = buildDebugBundleManifest(
      {
        run: {
          runId: 'run-42',
          workflowId: 'workflow-7',
          versions: {
            run: 'run.v1',
            workflow: 'workflow.v3',
            schema: 'schema.v1',
          },
        },
        events: [
          {
            eventId: 'event-2',
            kind: 'attempt',
            recordedAt: '2026-07-31T13:00:00.000Z',
          },
          {
            eventId: 'event-1',
            kind: 'run',
            recordedAt: '2026-07-31T12:00:00.000Z',
          },
        ],
        artifacts: [
          {
            artifactId: 'artifact-2',
            kind: 'transcript',
            redactionStatus: 'redacted',
            createdAt: '2026-07-31T13:01:00.000Z',
            lineage: {
              sourceEventId: 'event-2',
            },
          },
          {
            artifactId: 'artifact-1',
            kind: 'bundle',
            redactionStatus: 'clean',
            createdAt: '2026-07-31T13:05:00.000Z',
            lineage: {
              parentArtifactId: 'artifact-0',
            },
          },
        ],
        redaction: redaction.summary,
      },
      {
        clock: {
          now: () => '2026-08-01T08:00:00.000Z',
        },
      },
    );

    expect(manifest).toEqual({
      manifestSchemaVersion: 'debug-bundle-manifest.v1',
      manifestId: 'debug-bundle:run-42:2026-08-01T08:00:00.000Z',
      createdAt: '2026-08-01T08:00:00.000Z',
      run: {
        runId: 'run-42',
        workflowId: 'workflow-7',
        versions: {
          run: 'run.v1',
          workflow: 'workflow.v3',
          schema: 'schema.v1',
        },
      },
      events: [
        {
          eventId: 'event-1',
          kind: 'run',
          recordedAt: '2026-07-31T12:00:00.000Z',
        },
        {
          eventId: 'event-2',
          kind: 'attempt',
          recordedAt: '2026-07-31T13:00:00.000Z',
        },
      ],
      artifacts: [
        {
          artifactId: 'artifact-1',
          kind: 'bundle',
          redactionStatus: 'clean',
          createdAt: '2026-07-31T13:05:00.000Z',
          lineage: {
            parentArtifactId: 'artifact-0',
          },
        },
        {
          artifactId: 'artifact-2',
          kind: 'transcript',
          redactionStatus: 'redacted',
          createdAt: '2026-07-31T13:01:00.000Z',
          lineage: {
            sourceEventId: 'event-2',
          },
        },
      ],
      redaction: {
        status: 'redacted',
        redactedCount: 1,
        blockedCount: 0,
        redactions: [
          {
            path: '$.transcript.apiKey',
            reason: 'exact_key',
          },
        ],
        blocked: [],
      },
    });

    expect(() => debugBundleManifestSchema.parse(manifest)).not.toThrow();

    const manifestText = JSON.stringify(manifest);
    expect(manifestText).not.toContain('very-secret');
    expect(manifestText).not.toContain('"value"');
  });
});
