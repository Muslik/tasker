import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { URL } from 'node:url';

const sourceDirectory = new URL('../src/ledger/sql/', import.meta.url);
const outputDirectory = new URL('../dist/ledger/sql/', import.meta.url);

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
cpSync(sourceDirectory, outputDirectory, { recursive: true });
