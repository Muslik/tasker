import { z } from 'zod';

export const TrackerStatusUpdatesSchema = z.enum(['enabled', 'disabled']);

export type TrackerStatusUpdates = z.infer<typeof TrackerStatusUpdatesSchema>;
