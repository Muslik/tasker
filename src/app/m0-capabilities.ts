const moduleNames = [
  'domain',
  'ledger',
  'workflow',
  'queue',
  'runner',
  'providers',
  'integrations',
  'review',
  'observability',
  'app',
] as const;

export type ModuleName = (typeof moduleNames)[number];

export interface MilestoneCapabilities {
  readonly milestone: 'M0';
  readonly modules: readonly ModuleName[];
  readonly canCompileWorkflow: true;
  readonly canPersistContracts: true;
  readonly canExecuteRemoteEffects: false;
  readonly canInvokeProviders: false;
}

export const m0Capabilities = {
  milestone: 'M0',
  modules: moduleNames,
  canCompileWorkflow: true,
  canPersistContracts: true,
  canExecuteRemoteEffects: false,
  canInvokeProviders: false,
} as const satisfies MilestoneCapabilities;
