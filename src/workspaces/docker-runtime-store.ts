import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  DockerWorkspaceRuntimeReceiptSchema,
  type DockerWorkspaceRuntimeReceipt,
} from './docker-runtime-contracts.js';

export class DockerWorkspaceRuntimeStore {
  public constructor(private readonly rootPath: string) {}

  public async read(workspaceId: string): Promise<DockerWorkspaceRuntimeReceipt | null> {
    try {
      return DockerWorkspaceRuntimeReceiptSchema.parse(
        JSON.parse(await readFile(this.pathFor(workspaceId), 'utf8')) as unknown,
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new Error(`Docker runtime receipt for ${workspaceId} is invalid`, { cause: error });
      }
      throw error;
    }
  }

  public async write(receiptInput: DockerWorkspaceRuntimeReceipt): Promise<void> {
    const receipt = DockerWorkspaceRuntimeReceiptSchema.parse(receiptInput);
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(receipt.workspaceId);
    const temporary = `${destination}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  public async remove(workspaceId: string): Promise<void> {
    await rm(this.pathFor(workspaceId), { force: true });
  }

  private pathFor(workspaceId: string): string {
    return join(this.rootPath, `${workspaceId}.json`);
  }
}
