import type { OperatorTaskSummary } from './operator-contracts.js';

const operatorPriority = (task: OperatorTaskSummary): number => {
  if (task.attention === 'operator') return 0;
  return task.status === 'done' ? 2 : 1;
};

export const orderOperatorTasks = (
  tasks: readonly OperatorTaskSummary[],
): readonly OperatorTaskSummary[] =>
  tasks.toSorted((left, right) => operatorPriority(left) - operatorPriority(right));
