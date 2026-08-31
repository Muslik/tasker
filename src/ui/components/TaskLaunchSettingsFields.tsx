import type { ChangeEvent } from 'react';

import type { JiraProductResolution } from '../../shared/product.js';

export type TaskLaunchSettingsFieldsProps = {
  readonly product: JiraProductResolution['product'];
  readonly operatorBrief: string;
  readonly planningStrategy: 'auto' | 'fast' | 'ralplan';
  readonly planReview: boolean;
  readonly trackerStatusUpdates: boolean;
  readonly pending: boolean;
  readonly onOperatorBriefChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onPlanningStrategyChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  readonly onPlanReviewChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onTrackerStatusUpdatesChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

export const TaskLaunchSettingsFields = ({
  product,
  operatorBrief,
  planningStrategy,
  planReview,
  trackerStatusUpdates,
  pending,
  onOperatorBriefChange,
  onPlanningStrategyChange,
  onPlanReviewChange,
  onTrackerStatusUpdatesChange,
}: TaskLaunchSettingsFieldsProps) => (
  <fieldset className="space-y-2 rounded-lg border p-3">
    <legend className="px-1 text-xs font-semibold">Settings</legend>
    <label className="block space-y-1.5 text-xs font-medium">
      Бриф оператора
      <textarea
        aria-label="Бриф оператора"
        className="min-h-24 w-full resize-y"
        maxLength={10_000}
        value={operatorBrief}
        disabled={pending}
        onChange={onOperatorBriefChange}
      />
    </label>
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>Planning strategy</span>
      <select
        className="rounded-md border bg-background px-2 py-1"
        value={planningStrategy}
        disabled={pending}
        onChange={onPlanningStrategyChange}
      >
        <option value="auto">Automatic</option>
        <option value="fast">Fast</option>
        <option value="ralplan">Consensus plan</option>
      </select>
    </label>
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={planReview}
        disabled={pending}
        onChange={onPlanReviewChange}
      />
      Require plan review
    </label>
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={trackerStatusUpdates}
        disabled={pending}
        onChange={onTrackerStatusUpdatesChange}
      />
      Update Jira statuses
    </label>
    {product === null ? null : (
      <p className="text-xs text-muted-foreground">Determined by product: {product.title}</p>
    )}
    <p className="text-xs text-muted-foreground">
      Failure never blocks implementation, evidence, or comments.
    </p>
  </fieldset>
);
