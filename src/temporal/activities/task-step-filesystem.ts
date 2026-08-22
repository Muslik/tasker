import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface TaskStepFilesystemPaths {
  readonly artifactsPath: string;
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
    await rm(scratchPath, { recursive: true, force: true });
    await Promise.all([
      mkdir(artifactsPath, { recursive: true, mode: 0o700 }),
      mkdir(scratchPath, { recursive: true, mode: 0o700 }),
    ]);
    return { artifactsPath, scratchPath };
  }

  public cleanupScratch(paths: TaskStepFilesystemPaths): Promise<void> {
    return rm(paths.scratchPath, { recursive: true, force: true });
  }
}
