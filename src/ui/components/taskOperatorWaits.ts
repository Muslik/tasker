const dedicatedWaitSurfaceTargets = {
  human_clarification: {
    surfaceId: 'planning-clarification-surface',
    actionLabel: 'Open clarification form',
  },
  'plan.approved@1': {
    surfaceId: 'plan-review-surface',
    actionLabel: 'Open plan review',
  },
  'workflow_change.review@1': {
    surfaceId: 'workflow-change-review-surface',
    actionLabel: 'Open workflow review',
  },
  'code_review@1': {
    surfaceId: 'code-review-surface',
    actionLabel: 'Open code review',
  },
  'dependency.available@1': {
    surfaceId: 'dependency-wait-surface',
    actionLabel: 'Open dependency form',
  },
  'dependency.discovery@1': {
    surfaceId: 'dependency-wait-surface',
    actionLabel: 'Open dependency form',
  },
  'research.document-review@1': {
    surfaceId: 'research-document-review-surface',
    actionLabel: 'Open document review',
  },
} satisfies Record<string, { readonly surfaceId: string; readonly actionLabel: string }>;

type DedicatedWaitKind = keyof typeof dedicatedWaitSurfaceTargets;

const hasDedicatedWaitSurfaceTarget = (waitKind: string): waitKind is DedicatedWaitKind =>
  waitKind in dedicatedWaitSurfaceTargets;

export const getDedicatedWaitSurfaceTarget = (
  waitKind: string,
): { readonly surfaceId: string; readonly actionLabel: string } | null =>
  hasDedicatedWaitSurfaceTarget(waitKind) ? dedicatedWaitSurfaceTargets[waitKind] : null;

export const isDedicatedWaitKind = (waitKind: string): boolean =>
  getDedicatedWaitSurfaceTarget(waitKind) !== null;
