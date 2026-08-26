import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

import { loadHarnessPack } from '../dist/harness/loader.js';
import { nodeCommandRunner } from '../dist/providers/command-runner.js';
import {
  BitbucketRepositoryClient,
  loadBitbucketRepositoryConfiguration,
} from '../dist/repositories/index.js';
import { systemClock } from '../dist/shared/clock.js';
import {
  DockerWorkspaceCommandRunner,
  DockerWorkspaceRuntimeManager,
  DockerWorkspaceRuntimeStore,
  HarnessProfileWorkspaceBootstrapAdapter,
  loadDockerWorkspaceConfiguration,
  loadWorkspaceHarnessPack,
  resolveWorkspaceRuntimePolicy,
} from '../dist/workspaces/index.js';

const defaultProjectNames = [
  'front-railways',
  'front-bus',
  'front-avia',
  'front-core-packages',
  'front-index',
  'front-components',
  'front-backoffice',
];
const requestedProjectNames = process.env.TASKER_SMOKE_PROJECTS?.split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const projectNames =
  requestedProjectNames === undefined || requestedProjectNames.length === 0
    ? defaultProjectNames
    : requestedProjectNames;

const smokeRoot = resolve(
  process.env.TASKER_SMOKE_ROOT?.trim() ||
    resolve(homedir(), 'Library', 'Application Support', 'Tasker', 'smoke'),
);
const repositoryRoot = resolve(smokeRoot, 'repositories');
const workspaceRoot = resolve(smokeRoot, 'worktrees');
const runtimeRoot = resolve(smokeRoot, 'docker-runtimes');
const harnessSnapshotRoot = resolve(smokeRoot, 'harness-snapshots');
const reportRoot = resolve(smokeRoot, 'reports');
const dockerEnvironment = {
  ...process.env,
  TASKER_WORKSPACE_STORE: workspaceRoot,
  TASKER_DOCKER_RUNTIME_STORE: runtimeRoot,
};
const dockerConfiguration = loadDockerWorkspaceConfiguration(dockerEnvironment);
const runtimeStore = new DockerWorkspaceRuntimeStore(runtimeRoot);
const dockerCommands = new DockerWorkspaceCommandRunner(
  dockerConfiguration,
  nodeCommandRunner,
  runtimeStore,
);
const runtimeManager = new DockerWorkspaceRuntimeManager(
  dockerConfiguration,
  nodeCommandRunner,
  dockerCommands,
  runtimeStore,
  systemClock,
);
const workspaceHarnessPack = loadWorkspaceHarnessPack(resolve('harness/workspace'));
const workspaceBootstrap = new HarnessProfileWorkspaceBootstrapAdapter(
  {
    sourcePackPath: workspaceHarnessPack.rootPath,
    snapshotStorePath: harnessSnapshotRoot,
  },
  nodeCommandRunner,
  systemClock,
);
const harness = loadHarnessPack();
const bitbucketConfiguration = loadBitbucketRepositoryConfiguration();
if (bitbucketConfiguration === null) {
  throw new Error('Bitbucket configuration is required for project harness smoke');
}
const repositorySource = new BitbucketRepositoryClient(bitbucketConfiguration);

mkdirSync(repositoryRoot, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(harnessSnapshotRoot, { recursive: true });
mkdirSync(reportRoot, { recursive: true });

const output = (result) => {
  if (result.status === 'spawn_failed') return result.message;
  return [result.stdout, result.stderr]
    .filter((value) => value.trim().length > 0)
    .join('\n')
    .trim();
};

const reportOutput = (result) => {
  const value = output(result);
  return value.length <= 8_000
    ? value
    : `${value.slice(0, 4_000)}\n... smoke output truncated ...\n${value.slice(-4_000)}`;
};

const runHost = async (cwd, args, timeoutMs = 10 * 60_000) => {
  const result = await nodeCommandRunner.run({
    command: 'git',
    args,
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${bitbucketConfiguration.token}`,
      GIT_SSH_COMMAND:
        'ssh -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdin: '',
    timeoutMs,
  });
  if (result.status !== 'exited' || result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${output(result)}`);
  }
  return result.stdout.trim();
};

const ensureRepository = async (project) => {
  const path = resolve(repositoryRoot, project.repository.replace('/', '--'));
  const lookup = await repositorySource.find(project.repository);
  if (lookup.status !== 'found') {
    throw new Error(
      lookup.status === 'unavailable'
        ? lookup.problem.message
        : `Bitbucket repository ${project.repository} was not resolved`,
    );
  }
  const remote = lookup.repository.cloneUrl;
  if (!existsSync(path)) {
    await runHost(repositoryRoot, ['clone', '--no-checkout', '--origin', 'origin', remote, path]);
  } else {
    await runHost(path, ['remote', 'set-url', 'origin', remote]);
  }
  await runHost(path, ['fetch', '--prune', 'origin', project.git.baseBranch]);
  return {
    path,
    baseCommit: await runHost(path, ['rev-parse', `refs/remotes/origin/${project.git.baseBranch}`]),
  };
};

const ensureWorkspace = async (project, repository, policyHash) => {
  const workspaceId = createHash('sha256')
    .update(
      `smoke:${project.repository}:${repository.baseCommit}:${policyHash}:${workspaceHarnessPack.contentSha256}`,
    )
    .digest('hex')
    .slice(0, 24);
  const path = resolve(workspaceRoot, workspaceId);
  const branch = `tasker-smoke/${project.repository.split('/').at(-1)}/${workspaceId}`;
  if (!existsSync(path)) {
    await runHost(repository.path, [
      'worktree',
      'add',
      '-b',
      branch,
      '--',
      path,
      repository.baseCommit,
    ]);
  }
  const actualCommit = await runHost(path, ['rev-parse', 'HEAD']);
  if (actualCommit !== repository.baseCommit) {
    throw new Error(`Smoke workspace ${path} is not pinned to ${repository.baseCommit}`);
  }
  return {
    schemaVersion: 1,
    workspaceId,
    taskReference: `smoke:${project.repository}`,
    workflowId: `smoke:${project.repository}:${repository.baseCommit}`,
    workflowRunId: `smoke-${workspaceId}`,
    repository: {
      reference: project.repository,
      sourcePath: repository.path,
      baseBranch: project.git.baseBranch,
      baseCommit: repository.baseCommit,
    },
    runnerId: 'smoke',
    path,
    branch,
    preparedAt: systemClock.now(),
  };
};

const gitStatus = (path) => runHost(path, ['status', '--porcelain=v1', '--untracked-files=all']);

const processResult = (reference, index, invocation, result, statusBefore, statusAfter) => ({
  reference,
  index,
  command: invocation.command,
  args: invocation.args,
  status:
    result.status === 'exited' ? (result.exitCode === 0 ? 'passed' : 'failed') : result.status,
  exitCode: result.status === 'exited' ? result.exitCode : null,
  durationMs: result.durationMs,
  cleanBefore: statusBefore.length === 0,
  cleanAfter: statusAfter.length === 0,
  output: reportOutput(result),
});

const smokeProject = async (project) => {
  const startedAt = systemClock.now();
  try {
    const repository = await ensureRepository(project);
    const policy = resolveWorkspaceRuntimePolicy(harness.company, project);
    const workspace = await ensureWorkspace(project, repository, policy.policyHash);
    const bootstrapped = await workspaceBootstrap.apply(
      workspace,
      `workspace:${workspace.workspaceId}:bootstrap@1`,
    );
    if (!bootstrapped.ok) {
      return {
        repository: project.repository,
        status: 'harness_failed',
        startedAt,
        completedAt: systemClock.now(),
        baseCommit: repository.baseCommit,
        workspaceId: workspace.workspaceId,
        failure: bootstrapped.error,
        processes: [],
      };
    }
    const prepared = await runtimeManager.prepare(workspace, policy, {
      onProgress: ({ phase, detail }) => {
        process.stdout.write(
          `[${project.repository}] ${phase}${detail === undefined ? '' : `: ${detail}`}\n`,
        );
      },
    });
    if (!prepared.ok) {
      return {
        repository: project.repository,
        status: 'runtime_failed',
        startedAt,
        completedAt: systemClock.now(),
        baseCommit: repository.baseCommit,
        workspaceId: workspace.workspaceId,
        failure: prepared.error,
        processes: [],
      };
    }
    const processes = [];
    for (const [reference, plan] of Object.entries(project.processCommands).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      for (const [index, invocation] of plan.commands.entries()) {
        const before = await gitStatus(workspace.path);
        const result = await dockerCommands.run({
          operationId: `smoke:${workspace.workspaceId}:${reference}:${String(index + 1)}`,
          command: invocation.command,
          args: invocation.args,
          cwd: workspace.path,
          workspaceAccess: 'read_write',
          stdin: '',
          timeoutMs: plan.timeoutMs,
        });
        const after = await gitStatus(workspace.path);
        const receipt = processResult(reference, index + 1, invocation, result, before, after);
        processes.push(receipt);
        process.stdout.write(
          `[${project.repository}] ${reference} ${invocation.command}: ${receipt.status}\n`,
        );
        if (receipt.status !== 'passed' || !receipt.cleanAfter) {
          break;
        }
      }
      if ((await gitStatus(workspace.path)).length > 0) break;
    }
    const clean = (await gitStatus(workspace.path)).length === 0;
    return {
      repository: project.repository,
      status:
        clean && processes.every((process) => process.status === 'passed') ? 'passed' : 'failed',
      startedAt,
      completedAt: systemClock.now(),
      baseCommit: repository.baseCommit,
      workspaceId: workspace.workspaceId,
      harness: bootstrapped.value.receipt,
      runtime: {
        image: prepared.value.image,
        imageId: prepared.value.imageId,
        policyHash: prepared.value.policyHash,
      },
      clean,
      processes,
    };
  } catch (error) {
    return {
      repository: project.repository,
      status: 'infrastructure_failed',
      startedAt,
      completedAt: systemClock.now(),
      failure: { message: error instanceof Error ? error.message : 'Unknown smoke failure' },
      processes: [],
    };
  }
};

const selected = projectNames.map((name) => {
  const project = harness.projects.find(
    (candidate) => candidate.repository === `onetwotrip/${name}`,
  );
  if (project === undefined) throw new Error(`Harness project onetwotrip/${name} is missing`);
  return project;
});

const results = [];
for (const project of selected) results.push(await smokeProject(project));

const report = {
  schemaVersion: 1,
  startedAt: results[0]?.startedAt ?? systemClock.now(),
  completedAt: systemClock.now(),
  smokeRoot,
  results,
};
const reportPath = resolve(reportRoot, `${report.completedAt.replaceAll(/[:.]/gu, '-')}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`Smoke report: ${reportPath}\n`);
process.exitCode = results.every((result) => result.status === 'passed') ? 0 : 1;
