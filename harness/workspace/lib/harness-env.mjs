/**
 * Единый загрузчик <слой>/.env для node-скриптов скиллов.
 * Паритет с lib/harness_env.py: читаем всегда, реальное окружение старше файла.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Tasker passes the external secret file explicitly. The local fallback keeps the
// package usable outside Tasker without ever placing secrets in a snapshot.
export const ENV_FILE = process.env.TASKER_HARNESS_ENV_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

export function loadEnv(envFile = ENV_FILE) {
  let content;
  try {
    content = readFileSync(envFile, 'utf-8');
  } catch {
    return null;
  }

  for (const line of content.split('\n')) {
    const match = line.match(/^\s*([^#=\s][^=]*)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    if (process.env[key]) continue;
    process.env[key] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }

  return envFile;
}

export function require_(...names) {
  loadEnv();
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Не заданы переменные: ${missing.join(', ')} (искал в окружении и в ${ENV_FILE})`);
  }
  return names.map((n) => process.env[n]);
}
