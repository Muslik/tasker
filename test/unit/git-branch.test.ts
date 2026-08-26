import { describe, expect, it } from 'vitest';

import { taskBranchName, taskBranchNameMatches } from '../../src/shared/git-branch.js';

describe('task branch names', () => {
  it('derives an editable Git branch from the Jira key and summary', () => {
    expect(taskBranchName('FC-2244', 'Fix limiter interceptor')).toBe(
      'FC-2244-fix-limiter-interceptor',
    );
    expect(taskBranchNameMatches('FC-2244-limiter-200', 'FC-2244')).toBe(true);
    expect(taskBranchNameMatches('FI-1309-limiter-200', 'FC-2244')).toBe(false);
  });
});
