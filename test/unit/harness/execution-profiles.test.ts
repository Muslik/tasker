import { describe, expect, it } from 'vitest';

import {
  resolveAgentExecutionProfile,
  resolveImplementationPlannerProfile,
  resolveTaskExecutionProfile,
  resolveWorkflowAnalyzerProfile,
  validateExecutionProfileConfiguration,
  type ExecutionProfileConfiguration,
  type ProjectExecutionProfileOverrides,
} from '../../../src/harness/index.js';

const company = {
  executionProfiles: {
    'company-fast': {
      provider: 'codex',
      command: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      timeoutMs: 60_000,
      serviceTier: 'fast',
    },
    'company-deep': {
      provider: 'codex',
      command: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      timeoutMs: 120_000,
      serviceTier: 'fast',
    },
    'project-deep': {
      provider: 'claude',
      command: 'claude',
      model: 'opus',
      effort: 'high',
      timeoutMs: 120_000,
    },
    implementation: {
      provider: 'codex',
      command: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      timeoutMs: 120_000,
      serviceTier: 'fast',
    },
  },
  executionProfileRouting: {
    workflowAnalyzer: 'company-fast',
    implementationPlanner: {
      fast: 'company-fast',
      ralplan: 'company-deep',
    },
    taskStrategies: {
      simple: {
        context: 'company-fast',
        implementation: 'company-fast',
        verification: 'company-fast',
        review: 'company-deep',
      },
      standard: {
        context: 'company-fast',
        implementation: 'company-deep',
        verification: 'company-fast',
        review: 'company-deep',
      },
      complex: {
        context: 'company-deep',
        implementation: 'company-deep',
        verification: 'company-deep',
        review: 'company-deep',
      },
    },
  },
  apiPricing: {
    version: 'test-pricing-v1',
    sourceUrls: ['https://example.com/pricing'],
    models: {
      'gpt-5.6-terra': {
        inputPerMillionUsd: 2,
        cachedInputPerMillionUsd: 0.2,
        outputPerMillionUsd: 12,
      },
      'gpt-5.6-sol': {
        inputPerMillionUsd: 4,
        cachedInputPerMillionUsd: 0.4,
        outputPerMillionUsd: 20,
      },
    },
  },
} as const satisfies ExecutionProfileConfiguration;

const project = {
  workflowAnalyzer: 'project-deep',
  implementationPlanner: { ralplan: 'project-deep' },
  agents: { implementation: 'project-deep' },
  taskStrategies: { simple: { implementation: 'project-deep' } },
} as const satisfies ProjectExecutionProfileOverrides;

describe('execution profile resolution', () => {
  it('resolves company routing, project overrides, and explicit overrides in order', () => {
    expect(resolveWorkflowAnalyzerProfile(company, null).name).toBe('company-fast');
    expect(resolveWorkflowAnalyzerProfile(company, project).name).toBe('project-deep');
    expect(resolveWorkflowAnalyzerProfile(company, project, 'company-deep').name).toBe(
      'company-deep',
    );
    expect(resolveWorkflowAnalyzerProfile(company, null).apiPricing).toMatchObject({
      version: 'test-pricing-v1',
      inputPerMillionUsd: 2,
    });
    expect(resolveWorkflowAnalyzerProfile(company, project).apiPricing).toBeNull();

    expect(resolveImplementationPlannerProfile(company, project, 'fast').name).toBe('company-fast');
    expect(resolveImplementationPlannerProfile(company, project, 'ralplan').name).toBe(
      'project-deep',
    );
    expect(resolveAgentExecutionProfile(company, project, 'implementation').name).toBe(
      'project-deep',
    );
    expect(
      resolveAgentExecutionProfile(company, project, 'implementation', 'company-deep').name,
    ).toBe('company-deep');
    expect(resolveTaskExecutionProfile(company, null, 'simple', 'implementation').name).toBe(
      'company-fast',
    );
    expect(resolveTaskExecutionProfile(company, project, 'simple', 'implementation').name).toBe(
      'project-deep',
    );
    expect(resolveTaskExecutionProfile(company, project, 'simple', 'review').name).toBe(
      'company-deep',
    );
  });

  it('derives profile identity from the complete resolved configuration', () => {
    const first = resolveWorkflowAnalyzerProfile(company, null);
    const changed = resolveWorkflowAnalyzerProfile(
      {
        ...company,
        executionProfiles: {
          ...company.executionProfiles,
          'company-fast': {
            ...company.executionProfiles['company-fast'],
            effort: 'low',
          },
        },
      },
      null,
    );

    expect(first.configurationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed.configurationSha256).not.toBe(first.configurationSha256);
  });

  it('fails closed when any routed or requested profile is unknown', () => {
    expect(() => {
      validateExecutionProfileConfiguration(
        {
          ...company,
          executionProfileRouting: {
            ...company.executionProfileRouting,
            workflowAnalyzer: 'missing-profile',
          },
        },
        [],
        ['implementation'],
      );
    }).toThrow('Unknown execution profile missing-profile');

    expect(() => {
      validateExecutionProfileConfiguration(
        company,
        [{ executionProfileOverrides: project }],
        ['missing-agent-profile'],
      );
    }).toThrow('Unknown execution profile missing-agent-profile');

    expect(() => {
      validateExecutionProfileConfiguration(
        company,
        [{ executionProfileOverrides: { agents: { future: 'missing-profile' } } }],
        ['implementation'],
      );
    }).toThrow('Unknown execution profile missing-profile');
  });
});
