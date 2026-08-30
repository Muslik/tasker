import { useEffect, useRef, useState } from 'react';

import type {
  ResearchDocumentReviewResolution,
  ResearchDocumentReviewWaitDetails,
} from '../../shared/research-document-review.js';
import { ResearchDocumentReviewAnnotationSchema } from '../../shared/research-document-review.js';
import { captureResearchDocumentSelection } from '../lib/research-document-review-selection.js';
import { renderResearchDocumentHtml } from '../lib/research-document-review-render.js';
import {
  loadResearchDocumentReviewDraft,
  saveResearchDocumentReviewDraft,
  type ResearchDocumentReviewAnnotationDraft,
} from '../lib/research-document-review-storage.js';
import { Button } from './ui/button.js';

export const ResearchDocumentReviewEditor = ({
  draftKey,
  details,
  pending,
  error,
  onSubmit,
}: {
  readonly draftKey: string;
  readonly details: ResearchDocumentReviewWaitDetails;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: (input: ResearchDocumentReviewResolution) => void;
}) => {
  const documentRef = useRef<HTMLDivElement | null>(null);
  const [guidance, setGuidance] = useState(
    () => loadResearchDocumentReviewDraft(draftKey)?.guidance ?? '',
  );
  const [annotations, setAnnotations] = useState<ResearchDocumentReviewAnnotationDraft[]>(
    () => loadResearchDocumentReviewDraft(draftKey)?.annotations ?? [],
  );
  const [selection, setSelection] = useState<{ quote: string; left: number; top: number } | null>(
    null,
  );
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const documentHtml = renderResearchDocumentHtml(details.documentStorageHtml);

  useEffect(() => {
    saveResearchDocumentReviewDraft(draftKey, { guidance, annotations });
  }, [annotations, draftKey, guidance]);

  const trimmedGuidance = guidance.trim();
  const submittedAnnotations = annotations.map((annotation) => ({
    quote: annotation.quote,
    note: annotation.note.trim(),
  }));
  const invalidAnnotations = submittedAnnotations.some(
    (annotation) => !ResearchDocumentReviewAnnotationSchema.safeParse(annotation).success,
  );
  const canRequestChanges =
    !pending &&
    !invalidAnnotations &&
    annotations.length <= 50 &&
    (trimmedGuidance.length > 0 || submittedAnnotations.length > 0);

  return (
    <section
      aria-label="Research document review"
      data-testid="research-document-review-surface"
      className="rounded-xl border border-amber-400/50 bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-600">
            Action required
          </p>
          <h2 className="mt-1 text-base font-semibold">Research document review</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Review the document before publication and task filing.
          </p>
        </div>
        <span className="rounded-full border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-xs">
          Document approval gate
        </span>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(18rem,0.9fr)]">
        <div className="relative">
          {selection === null ? null : (
            <Button
              className="fixed z-30"
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
                setAnnotations((current) => [
                  ...current,
                  { id: localAnnotationId(), quote: selection.quote, note: '' },
                ]);
                setSelection(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              Добавить аннотацию
            </Button>
          )}
          <div
            className="research-document max-h-[68vh] overflow-auto rounded-lg border bg-background p-5"
            ref={documentRef}
            onKeyUp={() => {
              updateSelection(documentRef.current, setSelection, setSelectionError);
            }}
            onMouseUp={() => {
              updateSelection(documentRef.current, setSelection, setSelectionError);
            }}
            dangerouslySetInnerHTML={{ __html: documentHtml }}
          />
        </div>
        <div className="space-y-4">
          <div className="rounded-lg border bg-background p-4">
            <h3 className="text-sm font-semibold">Annotations</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Select text in the document to attach inline review notes.
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
                      maxLength={2_000}
                      placeholder="What should change in this excerpt?"
                      value={annotation.note}
                      disabled={pending}
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
            Operator guidance
            <textarea
              aria-label="Research review guidance"
              className="mt-3 min-h-28 w-full resize-y"
              maxLength={10_000}
              placeholder="Overall guidance for the next draft attempt"
              value={guidance}
              disabled={pending}
              onChange={(event) => {
                setGuidance(event.target.value);
              }}
            />
          </label>
          {selectionError === null ? null : (
            <p className="text-sm text-destructive">{selectionError}</p>
          )}
          {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={pending}
              type="button"
              onClick={() => {
                onSubmit({ decision: 'approve' });
              }}
            >
              Approve
            </Button>
            <Button
              disabled={!canRequestChanges}
              type="button"
              variant="outline"
              onClick={() => {
                if (!canRequestChanges) return;
                onSubmit({
                  decision: 'request_changes',
                  annotations: submittedAnnotations,
                  ...(trimmedGuidance.length === 0 ? {} : { guidance: trimmedGuidance }),
                });
              }}
            >
              Request changes
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
