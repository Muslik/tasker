export type SelectionRect = {
  readonly left: number;
  readonly top: number;
};

type CaptureSelectionOptions = {
  readonly maxLength?: number;
};

type RangeLike = {
  readonly commonAncestorContainer: unknown;
  getBoundingClientRect(): { left: number; bottom: number };
};

type SelectionLike = {
  readonly rangeCount: number;
  toString(): string;
  getRangeAt(index: number): RangeLike;
};

type ContainerLike = {
  contains(node: unknown): boolean;
};

export type CapturedSelection =
  | { readonly kind: 'empty' | 'outside' | 'too_long' }
  | {
      readonly kind: 'captured';
      readonly quote: string;
      readonly rect: SelectionRect;
    };

export const captureResearchDocumentSelection = (
  selection: SelectionLike | null,
  container: ContainerLike | null,
  options?: CaptureSelectionOptions,
): CapturedSelection => {
  if (selection === null || container === null || selection.rangeCount === 0)
    return { kind: 'empty' };
  const quote = selection.toString();
  if (quote.trim().length === 0) return { kind: 'empty' };
  if (quote.length > (options?.maxLength ?? 500)) return { kind: 'too_long' };
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return { kind: 'outside' };
  const rect = range.getBoundingClientRect();
  return {
    kind: 'captured',
    quote,
    rect: {
      left: rect.left,
      top: rect.bottom,
    },
  };
};
