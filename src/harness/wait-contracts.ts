import { z } from 'zod';

import type { WaitContract } from '../graph/contracts.js';

export const harnessWaitContracts = [
  {
    id: 'code_review',
    version: '1',
    stage: { id: 'review', label: 'Review' },
    resolutionSchema: z
      .object({
        decision: z.enum(['approved', 'changes_requested']),
        reviewId: z.string().min(1),
      })
      .strict(),
    resolutionMapping: {
      discriminator: 'decision',
      cases: {
        approved: {
          'review.approved@1': true,
          'review.changes_requested@1': false,
        },
        changes_requested: {
          'review.approved@1': false,
          'review.changes_requested@1': true,
        },
      },
    },
    artifactContracts: ['pull-request-review'],
    description: 'Wait for a human review decision or actionable PR comments.',
  },
  {
    id: 'operator_guidance',
    version: '1',
    stage: { id: 'attention', label: 'Needs attention' },
    resolutionSchema: z
      .object({
        decision: z.literal('resume'),
        guidance: z.string().trim().min(1),
      })
      .strict(),
    description: 'Pause an exhausted bounded loop for explicit operator correction.',
  },
  {
    id: 'ci_retry',
    version: '1',
    stage: { id: 'delivery', label: 'Deliver' },
    resolutionSchema: z
      .object({
        decision: z.literal('resume'),
        guidance: z.string().trim().min(1).optional(),
      })
      .strict(),
    description: 'Wait until a likely-flaky exact-revision CI build has been retried.',
  },
  {
    id: 'ci_infrastructure',
    version: '1',
    stage: { id: 'delivery', label: 'Deliver' },
    resolutionSchema: z
      .object({
        decision: z.literal('resume'),
        guidance: z.string().trim().min(1).optional(),
      })
      .strict(),
    description: 'Wait until the reported CI infrastructure problem has been corrected.',
  },
  {
    id: 'ci_unknown',
    version: '1',
    stage: { id: 'attention', label: 'Needs attention' },
    resolutionSchema: z
      .object({
        decision: z.literal('resume'),
        guidance: z.string().trim().min(1).optional(),
      })
      .strict(),
    description: 'Pause an unclassified CI failure for an operator decision.',
  },
  {
    id: 'translation_complete',
    version: '1',
    stage: { id: 'implementation', label: 'Implement' },
    resolutionSchema: z.object({ translationRevision: z.string().min(1) }).strict(),
    description: 'Wait for the translator to finish external work.',
  },
  {
    id: 'dependency_available',
    version: '1',
    stage: { id: 'implementation', label: 'Implement' },
    resolutionSchema: z
      .object({
        decision: z.literal('recheck'),
        declarationId: z.string().min(1),
        declarationRevision: z.number().int().positive(),
        observationId: z.string().min(1),
      })
      .strict(),
    description: 'Wait until every exact package version in a dependency is verified in Nexus.',
  },
  {
    id: 'dependency_discovery',
    version: '1',
    stage: { id: 'implementation', label: 'Implement' },
    resolutionSchema: z
      .object({
        decision: z.literal('configured'),
        requestArtifactId: z.string().min(1),
        declarationId: z.string().min(1),
      })
      .strict(),
    description: 'Wait for an operator to configure a newly discovered external dependency.',
  },
] satisfies readonly WaitContract[];
