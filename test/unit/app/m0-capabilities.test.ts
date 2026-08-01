import { describe, expect, it } from 'vitest';

import { m0Capabilities } from '../../../src/app/m0-capabilities.js';

describe('M0 safety boundary', () => {
  it('exposes contracts without any remote execution capability', () => {
    expect(m0Capabilities).toMatchObject({
      milestone: 'M0',
      canCompileWorkflow: true,
      canPersistContracts: true,
      canExecuteRemoteEffects: false,
      canInvokeProviders: false,
    });
  });
});
