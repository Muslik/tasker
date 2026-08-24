import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const taskerRoot = fileURLToPath(new URL('../', import.meta.url));
const interactiveHarnessRoot = resolve(
  process.env.TASKER_INTERACTIVE_HARNESS_PATH?.trim() || resolve(taskerRoot, '..', 'harness'),
);
const importsRoot = resolve(taskerRoot, 'harness', 'workspace', 'imports');
const projectIds = [
  'front-avia',
  'front-backoffice',
  'front-bus',
  'front-components',
  'front-core-packages',
  'front-railways',
];

const requestedImports = [
  ['global-skills', resolve(interactiveHarnessRoot, 'global', 'skills')],
  ['global-rules', resolve(interactiveHarnessRoot, 'global', 'rules')],
  ['work-shared-skills', resolve(interactiveHarnessRoot, 'work', 'shared', 'skills')],
  ['work-shared-rules', resolve(interactiveHarnessRoot, 'work', 'shared', 'rules')],
  ...projectIds.flatMap((projectId) => [
    [`project-skills/${projectId}`, resolve(interactiveHarnessRoot, 'work', projectId, 'skills')],
    [
      `project-overrides/${projectId}`,
      resolve(interactiveHarnessRoot, 'work', projectId, 'overrides'),
    ],
  ]),
];

const ensureImport = (logicalPath, source) => {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) return false;
  const destination = resolve(importsRoot, logicalPath);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    if (!lstatSync(destination).isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink harness import: ${destination}`);
    }
    const current = resolve(dirname(destination), readlinkSync(destination));
    if (current !== source) throw new Error(`Harness import already points to ${current}`);
    process.stdout.write(`Harness import already ready: ${destination}\n`);
    return true;
  }
  symlinkSync(relative(dirname(destination), source), destination, 'dir');
  process.stdout.write(`Harness import: ${destination} -> ${source}\n`);
  return true;
};

const imported = requestedImports.filter(([logicalPath, source]) =>
  ensureImport(logicalPath, source),
);
if (imported.length === 0) {
  throw new Error(`Interactive harness provides no importable sources: ${interactiveHarnessRoot}`);
}
