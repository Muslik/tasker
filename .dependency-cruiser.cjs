module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      // TODO(rebuild): integration review evidence and execution contracts form a pre-existing type cycle.
      from: { path: '^src/', pathNot: '^src/integrations/(execution|bitbucket/review)\\.ts$' },
      to: { circular: true },
    },
    // Matrix: dependencies normally point toward shared infrastructure:
    // kernel -> graph/planning/steps -> agents/workspace/integrations/store/server/ui -> shared.
    // These reverse edges are forbidden where the rebuilt code has no legacy wiring.
    // TODO(rebuild): kernel worker bootstrap still wires planning, steps, agents, workspace,
    // server, store, integrations, and harness modules; Phase 4 can reduce this surface.
    {
      name: 'graph-not-kernel',
      severity: 'error',
      from: { path: '^src/graph' },
      to: { path: '^src/kernel' },
    },
    {
      name: 'planning-not-kernel',
      severity: 'error',
      from: { path: '^src/planning' },
      to: { path: '^src/kernel' },
    },
    // TODO(rebuild): step activities consume kernel execution/bootstrap contracts.
    {
      name: 'agents-not-kernel',
      severity: 'error',
      from: { path: '^src/agents' },
      to: { path: '^src/kernel' },
    },
    {
      name: 'workspace-not-kernel',
      severity: 'error',
      from: { path: '^src/workspace' },
      to: { path: '^src/kernel' },
    },
    {
      name: 'integrations-not-kernel',
      severity: 'error',
      from: { path: '^src/integrations' },
      to: { path: '^src/kernel' },
    },
    {
      name: 'store-not-kernel',
      severity: 'error',
      from: { path: '^src/store' },
      to: { path: '^src/kernel' },
    },
    {
      name: 'shared-not-domain',
      severity: 'error',
      from: { path: '^src/shared' },
      to: {
        path: '^src/(kernel|graph|planning|steps|agents|workspace|integrations|store|server|ui)',
      },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: '(^|/)node_modules/' },
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
    exclude: ['(^|/)test/', '(^|/)src/.*\\.test\\.[cm]?[jt]sx?$'],
  },
};
