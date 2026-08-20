import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const taskerRoot = fileURLToPath(new URL('../', import.meta.url));
const interactiveHarnessRoot = resolve(
  process.env.TASKER_INTERACTIVE_HARNESS_PATH?.trim() || resolve(taskerRoot, '..', 'harness'),
);
const source = resolve(interactiveHarnessRoot, 'global', 'skills');
const destination = resolve(taskerRoot, 'harness', 'workspace', 'imports', 'global-skills');

if (!existsSync(source) || !lstatSync(source).isDirectory()) {
  throw new Error(`Interactive harness global skills do not exist: ${source}`);
}

mkdirSync(dirname(destination), { recursive: true });
if (existsSync(destination)) {
  if (!lstatSync(destination).isSymbolicLink()) {
    throw new Error(`Refusing to replace non-symlink harness import: ${destination}`);
  }
  const current = resolve(dirname(destination), readlinkSync(destination));
  if (current !== source) {
    throw new Error(`Harness import already points to ${current}`);
  }
  process.stdout.write(`Harness import already ready: ${destination}\n`);
  process.exit(0);
}

symlinkSync(relative(dirname(destination), source), destination, 'dir');
process.stdout.write(`Harness import: ${destination} -> ${source}\n`);
