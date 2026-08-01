import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSqliteLedger } from '../ledger/index.js';
import {
  createJiraIssueService,
  JiraServerClient,
  loadJiraConfiguration,
} from '../integrations/index.js';
import { CodexCliWorkflowAnalyzer, nodeCommandRunner } from '../providers/index.js';
import {
  discoverRepositoryCatalog,
  loadRepositoryCatalogConfiguration,
} from '../repositories/index.js';
import { systemClock } from '../shared/clock.js';
import { buildM1Api } from './m1-api.js';
import { createM1WorkflowService } from './m1-service.js';
import { CodexWorkflowGenerator } from './workflow-generator.js';

const parsePort = (input: string | undefined): number => {
  const port = input === undefined ? 4311 : Number(input);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TASKER_PORT: ${input ?? ''}`);
  }
  return port;
};

export const startM1Server = async (): Promise<void> => {
  const databasePath = resolve(process.env.TASKER_DB_PATH ?? '.tasker/m1-operator.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });

  const ledger = openSqliteLedger({ filename: databasePath, clock: systemClock });
  const service = createM1WorkflowService(ledger.repository, systemClock);
  const repositoryCatalog = discoverRepositoryCatalog(loadRepositoryCatalogConfiguration());
  const jiraIssueService = createJiraIssueService(
    ledger.repository,
    systemClock,
    new JiraServerClient(loadJiraConfiguration()),
    { repositoryCatalog },
  );
  const workflowGenerator =
    process.env.TASKER_WORKFLOW_PROVIDER === 'deterministic'
      ? undefined
      : new CodexWorkflowGenerator(
          service,
          new CodexCliWorkflowAnalyzer(nodeCommandRunner),
          resolve(process.env.TASKER_REPOSITORY_PATH ?? '.'),
        );
  const cockpitDirectory = resolve('dist/cockpit');
  const api = buildM1Api({
    service,
    jiraIssueService,
    logger: true,
    ...(workflowGenerator === undefined ? {} : { workflowGenerator }),
    ...(existsSync(cockpitDirectory) ? { cockpitDirectory } : {}),
  });

  const close = async (): Promise<void> => {
    await api.close();
    ledger.close();
  };

  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());

  await api.listen({ host: '127.0.0.1', port: parsePort(process.env.TASKER_PORT) });
};

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await startM1Server();
}
