import { useState } from 'react';

import type { ExecutionRunView } from '../../server/operator-contracts.js';
import { Button } from './ui/button.js';
import { Textarea } from './ui/textarea.js';
import { ActionAlert } from './ActionAlert.js';

export const PlanningClarificationSurface = ({
  run,
  pending,
  error,
  onSubmit,
}: {
  readonly run: Extract<ExecutionRunView, { runtime: 'bootstrap' }>;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (answers: readonly { questionId: string; answer: string }[]) => void;
}) => {
  const questions = run.planning?.status === 'needs_clarification' ? run.planning.questions : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (questions.length === 0) return null;
  const complete = questions.every((question) => (answers[question.id] ?? '').trim().length > 0);
  return (
    <section
      aria-label="Planning clarification"
      data-testid="planning-clarification"
      className="rounded-xl border border-amber-400/50 bg-card p-4"
    >
      <h2 className="text-base font-semibold">Planner needs clarification</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Answer every question before planning can continue.
      </p>
      <div className="mt-4 space-y-4">
        {questions.map((question) => (
          <label className="block space-y-1.5 text-sm" key={question.id}>
            <span className="font-medium">{question.question}</span>
            <span className="block text-xs text-muted-foreground">{question.reason}</span>
            <Textarea
              className="min-h-20 w-full resize-y"
              value={answers[question.id] ?? ''}
              disabled={pending}
              onChange={(event) => {
                setAnswers((current) => ({ ...current, [question.id]: event.target.value }));
              }}
            />
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          disabled={!complete || pending}
          onClick={() => {
            onSubmit(
              questions.map((question) => ({
                questionId: question.id,
                answer: (answers[question.id] ?? '').trim(),
              })),
            );
          }}
        >
          {pending ? 'Planning…' : 'Continue planning'}
        </Button>
      </div>
      <ActionAlert error={error} />
    </section>
  );
};
