import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const readEnvFile = (filename: string): Readonly<Record<string, string>> => {
  try {
    return Object.fromEntries(
      readFileSync(filename, 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=');
          const key = line.slice(0, separator).trim();
          const value = line
            .slice(separator + 1)
            .trim()
            .replace(/^(['"])(.*)\1$/u, '$2');
          return [key, value] as const;
        }),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
};

export const loadHarnessEnvironmentDefaults = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> => {
  const harnessWorkPath = environment.TASKER_HARNESS_WORK_PATH ?? resolve('..', 'harness', 'work');
  return readEnvFile(resolve(harnessWorkPath, '.env'));
};
