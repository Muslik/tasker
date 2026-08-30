const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const toText = (value: number): string => String(value);

const parseTimestamp = (timestamp: string | null): number | null => {
  if (timestamp === null) return null;

  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? null : value;
};

const formatCompactDuration = (durationMs: number): string => {
  if (durationMs < MINUTE_MS) return '<1m';

  if (durationMs < HOUR_MS) {
    return `${toText(Math.floor(durationMs / MINUTE_MS))}m`;
  }

  if (durationMs < DAY_MS) {
    const hours = Math.floor(durationMs / HOUR_MS);
    const minutes = Math.floor((durationMs % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${toText(hours)}h` : `${toText(hours)}h ${toText(minutes)}m`;
  }

  const days = Math.floor(durationMs / DAY_MS);
  const hours = Math.floor((durationMs % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${toText(days)}d` : `${toText(days)}d ${toText(hours)}h`;
};

export const formatElapsed = (timestamp: string | null, now = Date.now()): string => {
  const parsed = parseTimestamp(timestamp);
  if (parsed === null) return 'No updates';

  return `${formatCompactDuration(Math.max(0, now - parsed))} ago`;
};

export const formatDuration = (
  startedAt: string | null,
  completedAt: string | null,
  now = Date.now(),
): string => {
  const started = parseTimestamp(startedAt);
  if (started === null) return 'Unknown';

  const completed = parseTimestamp(completedAt) ?? now;
  return formatCompactDuration(Math.max(0, completed - started));
};
