import { useState } from 'react';

import type { OperatorInterventionAction } from '../../server/operator-contracts.js';
import { Button } from './ui/button.js';

type TypedAction = Extract<OperatorInterventionAction, { kind: 'typed_resolution' }>;
type Details = NonNullable<TypedAction['details']>;
type Available = Extract<Details, { kind: 'dependency_available' }>;
type Discovery = Extract<Details, { kind: 'dependency_discovery' }>;

export const DependencyWaitSurface = ({
  action,
  pending,
  error,
  onAvailable,
  onDiscovery,
}: {
  readonly action: TypedAction;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onAvailable: (
    versions: ReadonlyMap<string, string>,
    provenance: { postId: string; url: string },
  ) => void;
  readonly onDiscovery: (input: {
    producerTaskReference: string;
    producerRepository: string;
    packages: string;
    mode: 'final_only';
  }) => void;
}) => {
  const details = action.details;
  if (details === null) return null;
  if (details.kind === 'dependency_available')
    return (
      <AvailableSurface details={details} pending={pending} error={error} onSubmit={onAvailable} />
    );
  return (
    <DiscoverySurface details={details} pending={pending} error={error} onSubmit={onDiscovery} />
  );
};

const AvailableSurface = ({
  details,
  pending,
  error,
  onSubmit,
}: {
  readonly details: Available;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (
    versions: ReadonlyMap<string, string>,
    provenance: { postId: string; url: string },
  ) => void;
}) => {
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [postId, setPostId] = useState('');
  const [url, setUrl] = useState('');
  const complete = details.packages.every((name) => (versions[name] ?? '').trim().length > 0);
  return (
    <section
      aria-label="Dependency available"
      className="rounded-xl border border-amber-400/50 bg-card p-4"
    >
      <h2 className="text-sm font-semibold">Published versions</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Verify exact versions for the {details.channel} dependency before Tasker continues.
      </p>
      <div className="mt-4 space-y-3">
        {details.packages.map((name) => (
          <label className="block text-xs font-medium" key={name}>
            {name}
            <input
              className="mt-1 w-full"
              placeholder="1.2.3"
              value={versions[name] ?? ''}
              disabled={pending}
              onChange={(event) => {
                setVersions((current) => ({ ...current, [name]: event.target.value }));
              }}
            />
          </label>
        ))}
        <label className="block text-xs font-medium">
          Loop post ID
          <input
            className="mt-1 w-full"
            value={postId}
            disabled={pending}
            onChange={(event) => {
              setPostId(event.target.value);
            }}
          />
        </label>
        <label className="block text-xs font-medium">
          Provenance URL (optional)
          <input
            className="mt-1 w-full"
            value={url}
            disabled={pending}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
        </label>
      </div>
      {error === null ? null : <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          disabled={!complete || pending}
          onClick={() => {
            onSubmit(new Map(Object.entries(versions)), { postId: postId.trim(), url: url.trim() });
          }}
        >
          {pending ? 'Verifying…' : 'Verify published versions'}
        </Button>
      </div>
    </section>
  );
};

const DiscoverySurface = ({
  details,
  pending,
  error,
  onSubmit,
}: {
  readonly details: Discovery;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (input: {
    producerTaskReference: string;
    producerRepository: string;
    packages: string;
    mode: 'final_only';
  }) => void;
}) => {
  const [producerTaskReference, setProducerTaskReference] = useState(
    details.declaration.status === 'recorded' ? details.declaration.producerTaskReference : '',
  );
  const [producerRepository, setProducerRepository] = useState(
    details.declaration.status === 'recorded'
      ? details.declaration.producerRepository
      : details.requestedRepository,
  );
  const [packages, setPackages] = useState(
    details.declaration.status === 'recorded'
      ? details.declaration.packages.join('\n')
      : (details.expectedPackage ?? ''),
  );
  const complete =
    producerTaskReference.trim().length > 0 &&
    producerRepository.trim().length > 0 &&
    packages.trim().length > 0;
  return (
    <section
      aria-label="Dependency discovery"
      className="rounded-xl border border-amber-400/50 bg-card p-4"
    >
      <h2 className="text-sm font-semibold">Configure dependency</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Record the producer repository and package names discovered during planning.
      </p>
      <div className="mt-4 space-y-3">
        <label className="block text-xs font-medium">
          Producer task reference
          <input
            className="mt-1 w-full"
            value={producerTaskReference}
            disabled={pending}
            onChange={(event) => {
              setProducerTaskReference(event.target.value);
            }}
          />
        </label>
        <label className="block text-xs font-medium">
          Producer repository
          <input
            className="mt-1 w-full"
            value={producerRepository}
            disabled={pending}
            onChange={(event) => {
              setProducerRepository(event.target.value);
            }}
          />
        </label>
        <label className="block text-xs font-medium">
          Packages
          <textarea
            className="mt-1 min-h-20 w-full"
            value={packages}
            disabled={pending}
            onChange={(event) => {
              setPackages(event.target.value);
            }}
          />
        </label>
      </div>
      {error === null ? null : <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          disabled={!complete || pending}
          onClick={() => {
            onSubmit({
              producerTaskReference: producerTaskReference.trim(),
              producerRepository: producerRepository.trim(),
              packages,
              mode: 'final_only',
            });
          }}
        >
          {pending ? 'Saving…' : 'Configure dependency'}
        </Button>
      </div>
    </section>
  );
};

export const parsePackageNames = (value: string): readonly string[] =>
  value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
