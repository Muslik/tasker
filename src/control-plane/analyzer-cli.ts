import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqliteLedger } from '../ledger/index.js';
import { createWorkflowAnalyzerContext, findTaskFixture } from '../planning/index.js';
import { CodexCliWorkflowAnalyzer, nodeCommandRunner } from '../providers/index.js';
import { systemClock } from '../shared/clock.js';
import type { WorkflowResponse } from './m1-contracts.js';
import { renderWorkflowTree } from './m1-cli.js';
import { createM1WorkflowService } from './m1-service.js';

type WriteLine = (line: string) => void;

const usage = ['Usage:', '  tasker-analyze <fixture-id> --repo <repository-path> [--db path]'].join(
  '\n',
);

const optionValue = (args: readonly string[], name: string): string | null => {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (value === undefined || value.startsWith('--'))) {
    throw new Error(`${name} requires a value`);
  }
  return value ?? null;
};

const renderResponse = (response: WorkflowResponse, write: WriteLine): number => {
  write(response.view.fixture.title);
  write(`status=${response.status} hash=${response.view.workflow.graphHash ?? 'none'}`);

  if (response.view.workflow.tree === null) {
    for (const issue of response.view.workflow.validatorReport.issues) {
      write(`- ${issue.code} ${issue.path.join('.')}: ${issue.message}`);
    }
    return 1;
  }

  write(renderWorkflowTree(response.view.workflow.tree));
  return 0;
};

export const runAnalyzerCli = async (
  args: readonly string[],
  write: WriteLine = console.log,
): Promise<number> => {
  const fixtureId = args[0];
  if (fixtureId === undefined || fixtureId.startsWith('--')) {
    write(usage);
    return 2;
  }

  let repositoryPath: string;
  let databasePath: string;
  try {
    const repositoryOption = optionValue(args, '--repo');
    if (repositoryOption === null) {
      write(usage);
      return 2;
    }
    repositoryPath = resolve(repositoryOption);
    databasePath = resolve(optionValue(args, '--db') ?? '.tasker/m1-operator.sqlite');
  } catch (error) {
    write(error instanceof Error ? error.message : 'Invalid arguments');
    return 2;
  }

  const fixture = findTaskFixture(fixtureId);
  if (fixture === undefined) {
    write(`error: fixture_not_found (${fixtureId})`);
    return 1;
  }

  mkdirSync(dirname(databasePath), { recursive: true });
  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });

  try {
    const service = createM1WorkflowService(ledger.repository, systemClock);
    const existing = service.read(fixtureId);
    if (!existing.ok) {
      write(`error: ${existing.error.kind}`);
      return 1;
    }
    if (existing.value !== null) {
      write('Using the already persisted workflow; no provider call was made.');
      return renderResponse(existing.value, write);
    }

    write(`Analyzing ${fixture.taskId} in ${repositoryPath} with Codex read-only mode…`);
    const analyzer = new CodexCliWorkflowAnalyzer(nodeCommandRunner);
    const analyzed = await analyzer.analyze({
      ...createWorkflowAnalyzerContext(fixture),
      repositoryPath,
    });
    if (!analyzed.ok) {
      write(`error: ${analyzed.error.kind}`);
      if ('message' in analyzed.error) write(analyzed.error.message);
      if ('issues' in analyzed.error) {
        analyzed.error.issues.forEach((issue) => {
          write(`- ${issue}`);
        });
      }
      if ('stderr' in analyzed.error && analyzed.error.stderr.length > 0) {
        write(analyzed.error.stderr);
      }
      return 1;
    }

    const generated = service.generateFromAnalyzerOutput(
      fixtureId,
      analyzed.value.output,
      analyzed.value.receipt,
    );
    if (!generated.ok) {
      write(`error: ${generated.error.kind}`);
      return 1;
    }

    const usage = analyzed.value.receipt.usage;
    write(
      `Codex analysis: ${String(Math.round(analyzed.value.receipt.durationMs))} ms, ${String(usage.inputTokens + usage.outputTokens)} measured tokens, hypothetical API cost unavailable until a model rate card is configured.`,
    );
    return renderResponse(generated.value, write);
  } finally {
    ledger.close();
  }
};

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  process.exitCode = await runAnalyzerCli(process.argv.slice(2));
}
