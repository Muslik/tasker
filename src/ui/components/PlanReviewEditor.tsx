import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { PlanReviewRound } from '../../server/plan-review.js';
import {
  planReviewFeedbackFrom,
  type PlanReviewAnnotationInput,
  type PlanReviewDraftAnnotation,
} from '../lib/plan-review-feedback.js';
import {
  clearPlanReviewDraft,
  loadPlanReviewDraft,
  savePlanReviewDraft,
} from '../lib/plan-review-storage.js';
import { captureResearchDocumentSelection } from '../lib/research-document-review-selection.js';
import { PlanReviewHistory } from './PlanReviewHistory.js';
import { Button } from './ui/button.js';

export const appendPlanReviewAnnotation = (
  annotations: readonly PlanReviewDraftAnnotation[],
  annotation: PlanReviewDraftAnnotation,
): PlanReviewDraftAnnotation[] => [...annotations, annotation];

export const PlanReviewEditor = ({
  draftKey,
  markdown,
  planTitle,
  planAttempt,
  history,
  pending,
  error,
  onReview,
}: {
  readonly draftKey: string;
  readonly markdown: string;
  readonly planTitle: string;
  readonly planAttempt: number;
  readonly history: readonly PlanReviewRound[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly onReview: (
    decision: 'approve' | 'request_changes',
    guidance: string,
    annotations: readonly PlanReviewAnnotationInput[],
  ) => void;
}) => {
  const planRef = useRef<HTMLDivElement | null>(null);
  const [guidance, setGuidance] = useState(() => loadPlanReviewDraft(draftKey)?.guidance ?? '');
  const [annotations, setAnnotations] = useState<PlanReviewDraftAnnotation[]>(() => [
    ...(loadPlanReviewDraft(draftKey)?.annotations ?? []),
  ]);
  const [selection, setSelection] = useState<{ quote: string; left: number; top: number } | null>(
    null,
  );
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<'idle' | 'submitted' | 'pending'>('idle');

  useEffect(() => {
    savePlanReviewDraft(draftKey, { guidance, annotations });
  }, [annotations, draftKey, guidance]);

  useEffect(() => {
    if (submitState === 'submitted' && pending) {
      setSubmitState('pending');
      return;
    }
    if (submitState !== 'pending' || pending) return;
    if (error !== null) {
      setSubmitState('idle');
      return;
    }
    clearPlanReviewDraft(draftKey);
    setGuidance('');
    setAnnotations([]);
    setSelection(null);
    setSelectionError(null);
    setSubmitState('idle');
  }, [draftKey, error, pending, submitState]);

  const trimmedGuidance = guidance.trim();
  const submittedAnnotations = annotations
    .map((annotation) => ({
      quote: annotation.quote.trim(),
      note: annotation.note.trim(),
    }))
    .filter((annotation) => annotation.quote.length > 0 || annotation.note.length > 0);
  const feedback = planReviewFeedbackFrom({ guidance: trimmedGuidance, annotations });
  const annotationsMissingNotes = submittedAnnotations.some(
    (annotation) => annotation.note.length === 0,
  );
  const feedbackError = annotationsMissingNotes
    ? 'Each annotation needs a note before you can request changes.'
    : feedback.length > 10_000
      ? 'Combined review feedback must be 10000 characters or fewer.'
      : null;
  const canRequestChanges =
    !pending && feedback.length > 0 && annotations.length <= 50 && feedbackError === null;

  return (
    <section
      aria-label="Review implementation plan"
      data-testid="plan-review-surface"
      className="rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-600">
            Action required
          </p>
          <h2 className="mt-1 text-base font-semibold">Implementation plan</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {planTitle} · attempt {String(planAttempt)}
          </p>
        </div>
        <span className="rounded-full border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-xs">
          Review required
        </span>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(18rem,0.9fr)]">
        <div className="relative">
          {selection === null ? null : (
            <Button
              className="fixed z-30"
              data-testid="plan-review-add-annotation"
              disabled={pending}
              size="sm"
              style={{ left: selection.left, top: selection.top + 8 }}
              type="button"
              onClick={() => {
                if (annotations.length >= 50) {
                  setSelection(null);
                  setSelectionError('You can submit up to 50 annotations.');
                  return;
                }
                setAnnotations((current) =>
                  appendPlanReviewAnnotation(current, {
                    id: localAnnotationId(),
                    quote: selection.quote,
                    note: '',
                  }),
                );
                setSelection(null);
                setSelectionError(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              Add annotation
            </Button>
          )}
          <div
            className="max-h-[68vh] overflow-auto rounded-lg border bg-background p-4"
            data-testid="plan-review-markdown"
            ref={planRef}
            onKeyUp={() => {
              updateSelection(planRef.current, setSelection, setSelectionError);
            }}
            onMouseUp={() => {
              updateSelection(planRef.current, setSelection, setSelectionError);
            }}
          >
            <div className="research-document tasker-plan-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <div className="rounded-lg border bg-background p-4">
            <h3 className="text-sm font-semibold">Annotations</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Select text in the rendered plan to attach review notes to the exact excerpt.
            </p>
            <div className="mt-3 space-y-3">
              {annotations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No annotations yet.</p>
              ) : (
                annotations.map((annotation, index) => (
                  <article className="rounded-md border p-3" key={annotation.id}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        Annotation {String(index + 1)}
                      </p>
                      <button
                        className="text-xs text-destructive"
                        type="button"
                        onClick={() => {
                          setAnnotations((current) =>
                            current.filter((item) => item.id !== annotation.id),
                          );
                        }}
                      >
                        Delete
                      </button>
                    </div>
                    <blockquote className="mt-2 border-l-2 pl-3 text-sm italic">
                      {annotation.quote}
                    </blockquote>
                    <textarea
                      aria-label={`Annotation ${String(index + 1)} note`}
                      className="mt-3 min-h-24 w-full resize-y"
                      disabled={pending}
                      maxLength={2_000}
                      placeholder="What should change in this excerpt?"
                      value={annotation.note}
                      onChange={(event) => {
                        setAnnotations((current) =>
                          current.map((item) =>
                            item.id === annotation.id
                              ? { ...item, note: event.target.value }
                              : item,
                          ),
                        );
                      }}
                    />
                  </article>
                ))
              )}
            </div>
          </div>
          <label className="block rounded-lg border bg-background p-4 text-sm font-medium">
            Overall guidance
            <textarea
              aria-label="Plan review guidance"
              className="mt-3 min-h-28 w-full resize-y"
              disabled={pending}
              maxLength={10_000}
              placeholder="Overall guidance for the next planning attempt"
              value={guidance}
              onChange={(event) => {
                setGuidance(event.target.value);
              }}
            />
          </label>
          {selectionError === null ? null : (
            <p className="text-sm text-destructive">{selectionError}</p>
          )}
          {feedbackError === null ? null : (
            <p className="text-sm text-destructive">{feedbackError}</p>
          )}
          {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
          <PlanReviewHistory history={history} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!canRequestChanges}
              onClick={() => {
                if (!canRequestChanges) return;
                setSubmitState('submitted');
                onReview('request_changes', trimmedGuidance, submittedAnnotations);
              }}
            >
              {pending ? 'Sending…' : 'Request changes'}
            </Button>
            <Button
              type="button"
              disabled={pending || trimmedGuidance.length > 0 || annotations.length > 0}
              onClick={() => {
                setSubmitState('submitted');
                onReview('approve', '', []);
              }}
            >
              {pending ? 'Approving…' : 'Approve plan'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};

const updateSelection = (
  container: HTMLDivElement | null,
  setSelection: (selection: { quote: string; left: number; top: number } | null) => void,
  setSelectionError: (error: string | null) => void,
) => {
  if (typeof window === 'undefined') return;
  const captured = captureResearchDocumentSelection(window.getSelection(), container);
  if (captured.kind === 'captured') {
    setSelection({
      quote: captured.quote,
      left: captured.rect.left,
      top: captured.rect.top,
    });
    setSelectionError(null);
    return;
  }
  setSelection(null);
  setSelectionError(
    captured.kind === 'too_long' ? 'Selected excerpt must be 500 characters or fewer.' : null,
  );
};

const localAnnotationId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
