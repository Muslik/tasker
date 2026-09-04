import type { JiraProductResolution } from '../../shared/product.js';
import { Badge } from './ui/badge.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.js';
import { Checkbox } from './ui/checkbox.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import { Textarea } from './ui/textarea.js';

type PlanningStrategy = 'auto' | 'fast' | 'ralplan';

export type TaskLaunchSettingsFieldsProps = {
  readonly product: JiraProductResolution['product'];
  readonly operatorBrief: string;
  readonly planningStrategy: PlanningStrategy;
  readonly planReview: boolean;
  readonly trackerStatusUpdates: boolean;
  readonly pending: boolean;
  readonly onOperatorBriefChange: (value: string) => void;
  readonly onPlanningStrategyChange: (value: PlanningStrategy) => void;
  readonly onPlanReviewChange: (checked: boolean) => void;
  readonly onTrackerStatusUpdatesChange: (checked: boolean) => void;
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
  <Card size="sm" className="border shadow-none">
    <CardHeader className="border-b">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Settings</CardTitle>
        {product === null ? null : <Badge variant="outline">{product.title}</Badge>}
      </div>
      <CardDescription>Failure never blocks implementation, evidence, or comments.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      <label className="block space-y-1.5 text-xs font-medium">
        <span>Бриф оператора</span>
        <Textarea
          aria-label="Бриф оператора"
          className="min-h-24 resize-y"
          maxLength={10_000}
          value={operatorBrief}
          disabled={pending}
          onChange={(event) => {
            onOperatorBriefChange(event.target.value);
          }}
        />
      </label>
      <label className="block space-y-1.5 text-xs font-medium">
        <span>Planning strategy</span>
        <Select
          value={planningStrategy}
          disabled={pending}
          onValueChange={(value) => {
            if (value !== null) onPlanningStrategyChange(value);
          }}
        >
          <SelectTrigger className="w-full" aria-label="Planning strategy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automatic</SelectItem>
            <SelectItem value="fast">Fast</SelectItem>
            <SelectItem value="ralplan">Consensus plan</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm">
        <Checkbox
          checked={planReview}
          disabled={pending}
          onCheckedChange={(checked) => {
            onPlanReviewChange(checked);
          }}
        />
        <span className="space-y-1">
          <span className="block font-medium">Require plan review</span>
          <span className="block text-xs text-muted-foreground">
            Keep plan approval required before execution begins.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm">
        <Checkbox
          checked={trackerStatusUpdates}
          disabled={pending}
          onCheckedChange={(checked) => {
            onTrackerStatusUpdatesChange(checked);
          }}
        />
        <span className="space-y-1">
          <span className="block font-medium">Update Jira statuses</span>
          <span className="block text-xs text-muted-foreground">
            Failure never blocks implementation, evidence, or comments.
          </span>
        </span>
      </label>
    </CardContent>
  </Card>
);
