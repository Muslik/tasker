import { createHash } from 'node:crypto';

export const checksumString = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
