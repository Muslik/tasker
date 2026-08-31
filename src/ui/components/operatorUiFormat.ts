import type { OperatorTaskInvocationListRow } from '../../server/operator-contracts.js';

const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

export const formatOperatorInteger = (value: number | null): string =>
  value === null ? '\u2014' : value.toLocaleString('en-US');

export const formatOperatorTimestamp = (value: string | null): string =>
  value === null ? '\u2014' : value.replace('T', ' ').replace('.000Z', 'Z');

export const formatOperatorPromptKb = (promptBytes: number): string =>
  `${(promptBytes / 1024).toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} KB`;

export const formatOperatorUsd = (amountUsd: number): string =>
  `$${amountUsd.toLocaleString('en-US', {
    minimumFractionDigits: amountUsd === 0 ? 0 : 4,
    maximumFractionDigits: 4,
  })}`;

export const formatOperatorCost = (cost: OperatorTaskInvocationListRow['cost']): string =>
  cost.source === 'unrated' ? '\u2014' : formatOperatorUsd(cost.amountUsd);

export const formatOperatorDurationMs = (durationMs: number): string => {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / SECOND_MS);
  const days = Math.floor(totalSeconds / DAY_SECONDS);
  const hours = Math.floor((totalSeconds % DAY_SECONDS) / HOUR_SECONDS);
  const minutes = Math.floor((totalSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
  const seconds = totalSeconds % MINUTE_SECONDS;
  if (totalSeconds < MINUTE_SECONDS) return `${String(seconds)}s`;

  const parts: string[] = [];

  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0 || days > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${String(minutes)}m`);
  parts.push(`${String(seconds).padStart(2, '0')}s`);

  return parts.join(' ');
};
