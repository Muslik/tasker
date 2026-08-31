import { useMutation } from '@tanstack/react-query';

import type {
  ExecutionRunView,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
} from '../../server/operator-contracts.js';
import { resolveDependencyAvailable, resolveDependencyDiscovery } from '../api/index.js';
import { parsePackageNames } from './DependencyWaitSurface.js';

export const useDependencyMutation = ({
  task,
  projection,
  currentRun,
  onSettled,
}: {
  readonly task: OperatorTaskSummary;
  readonly projection: OperatorWorkflowProjection;
  readonly currentRun: ExecutionRunView | null;
  readonly onSettled: () => void;
}) =>
  useMutation({
    mutationFn: ({
      available,
      versions,
      provenance,
      discovery,
    }: {
      available: boolean;
      versions?: ReadonlyMap<string, string>;
      provenance?: { postId: string; url: string };
      discovery?: {
        producerTaskReference: string;
        producerRepository: string;
        packages: string;
        mode: 'final_only';
      };
    }) => {
      if (
        currentRun?.runtime !== 'execution' ||
        currentRun.status !== 'waiting' ||
        projection.current?.status !== 'waiting'
      )
        throw new Error('The dependency wait is unavailable');
      const action = projection.current.intervention;
      if (action.kind !== 'typed_resolution' || action.details === null)
        throw new Error('The dependency wait is unavailable');
      if (available && action.details.kind === 'dependency_available' && versions !== undefined) {
        return resolveDependencyAvailable(task.id, {
          expectedRunId: currentRun.runId,
          nodeId: projection.current.nodeId,
          waitKind: 'dependency.available@1',
          declarationId: action.details.declarationId,
          declarationRevision: action.details.declarationRevision,
          channel: action.details.channel,
          packages: action.details.packages.map((name) => ({
            name,
            version: versions.get(name) ?? '',
          })),
          ...(provenance?.postId === undefined || provenance.postId.length === 0
            ? {}
            : {
                provenance: {
                  kind: 'loop' as const,
                  postId: provenance.postId,
                  ...(provenance.url.length === 0 ? {} : { url: provenance.url }),
                },
              }),
        });
      }
      if (!available && action.details.kind === 'dependency_discovery' && discovery !== undefined) {
        return resolveDependencyDiscovery(task.id, {
          expectedRunId: currentRun.runId,
          nodeId: projection.current.nodeId,
          waitKind: 'dependency.discovery@1',
          requestArtifactId: action.details.requestArtifactId,
          producerTaskReference: discovery.producerTaskReference,
          producerRepository: discovery.producerRepository,
          packages: [...parsePackageNames(discovery.packages)],
          mode: discovery.mode,
        });
      }
      throw new Error('The dependency form does not match the active wait');
    },
    onSettled,
  });
