import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqliteLedger } from '../ledger/index.js';
import { systemClock } from '../shared/clock.js';
import type { WorkflowTreeNode } from './m1-contracts.js';
import { createM1WorkflowService } from './m1-service.js';

type WriteLine = (line: string) => void;

const usage = [
  'Usage:',
  '  tasker-m1 list [--db path]',
  '  tasker-m1 generate <fixture-id> [--db path]',
  '  tasker-m1 show <fixture-id> [--db path]',
].join('\n');

export const renderWorkflowTree = (root: WorkflowTreeNode): string => {
  const lines: string[] = [];

  const visit = (node: WorkflowTreeNode, prefix: string, connector: string): void => {
    const retry = node.retryBudget === null ? '' : ` · retry≤${String(node.retryBudget)}`;
    const wait = node.waitKind === undefined ? '' : ` · wait=${node.waitKind}`;
    lines.push(`${prefix}${connector}${node.kind}: ${node.label}${retry}${wait}`);

    node.children.forEach((child, index) => {
      const last = index === node.children.length - 1;
      visit(child, `${prefix}${connector === '' ? '' : '   '}`, last ? '└─ ' : '├─ ');
    });
  };

  visit(root, '', '');
  return lines.join('\n');
};

const parseDatabasePath = (args: readonly string[]): string => {
  const index = args.indexOf('--db');
  const value = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (value === undefined || value.length === 0)) {
    throw new Error('--db requires a path');
  }
  return resolve(value ?? '.tasker/m1-operator.sqlite');
};

export const runM1Cli = (args: readonly string[], write: WriteLine = console.log): number => {
  const command = args[0];
  if (command !== 'list' && command !== 'generate' && command !== 'show') {
    write(usage);
    return 2;
  }

  const databasePath = parseDatabasePath(args);
  mkdirSync(dirname(databasePath), { recursive: true });
  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });

  try {
    const service = createM1WorkflowService(ledger.repository, systemClock);

    if (command === 'list') {
      for (const fixture of service.listFixtures().fixtures) {
        write(`${fixture.id}\t${fixture.family}\t${fixture.title}`);
      }
      return 0;
    }

    const fixtureId = args[1];
    if (fixtureId === undefined || fixtureId.startsWith('--')) {
      write(usage);
      return 2;
    }

    const result = command === 'generate' ? service.generate(fixtureId) : service.read(fixtureId);
    if (!result.ok) {
      write(`error: ${result.error.kind}`);
      return 1;
    }
    if (result.value === null) {
      write(`No persisted workflow for ${fixtureId}; run generate first.`);
      return 1;
    }

    const response = result.value;
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
  } finally {
    ledger.close();
  }
};

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  process.exitCode = runM1Cli(process.argv.slice(2));
}
