import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface TaskStepFilesystemPaths {
  readonly artifactsPath: string;
  readonly inputsPath: string;
  readonly scratchPath: string;
}

export class TaskStepFilesystemStore {
  private readonly rootPath: string;

  public constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  public async prepare(operationId: string): Promise<TaskStepFilesystemPaths> {
    const key = createHash('sha256').update(operationId).digest('hex');
    const artifactsPath = join(this.rootPath, 'artifacts', key);
    const scratchPath = join(this.rootPath, 'scratch', key);
    const inputsPath = join(this.rootPath, 'inputs', key);
    await Promise.all([
      rm(scratchPath, { recursive: true, force: true }),
      rm(inputsPath, { recursive: true, force: true }),
    ]);
    await Promise.all([
      mkdir(artifactsPath, { recursive: true, mode: 0o700 }),
      mkdir(scratchPath, { recursive: true, mode: 0o700 }),
      mkdir(inputsPath, { recursive: true, mode: 0o700 }),
    ]);
    return { artifactsPath, inputsPath, scratchPath };
  }

  public cleanupScratch(paths: TaskStepFilesystemPaths): Promise<void> {
    return Promise.all([
      rm(paths.scratchPath, { recursive: true, force: true }),
      rm(paths.inputsPath, { recursive: true, force: true }),
    ]).then(() => undefined);
  }
}
