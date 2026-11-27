// Event kinds (PLAN.md section 4, "Items, events and kinds"). Scores are
// stored per kind, unweighted; weights are applied when scores are read.

/** Every event kind, in canonical order. */
export const EVENT_KINDS = Object.freeze(['read', 'edit', 'mention'] as const);

/** The kind of an event: `'read' | 'edit' | 'mention'`. */
export type EventKind = (typeof EVENT_KINDS)[number];

/** Whether `kind` is one of the event kinds. */
export function isEventKind(kind: unknown): kind is EventKind {
  return typeof kind === 'string' && (EVENT_KINDS as readonly string[]).includes(kind);
}
