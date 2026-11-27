import { type AnalyzerOptions, analyze } from './analyze.js';

/** The searchable fields of a section, in a fixed order. */
export const FIELDS = ['title', 'heading', 'body'] as const;
export type Field = (typeof FIELDS)[number];

/** One number per field (term frequencies, lengths, weights, `b` values). */
export type FieldValues = Readonly<Record<Field, number>>;

/** Token positions of one term in each field (ascending; empty when absent). */
export type FieldPositions = Readonly<Record<Field, readonly number[]>>;

/**
 * The searchable unit: one section of a note. `title` is the note's title
 * (repeated for every section of the note), `heading` the section's heading
 * (empty for a preamble), `body` the section's text.
 */
export interface Section {
  readonly title: string;
  readonly heading: string;
  readonly body: string;
}

/** What the index keeps for one term in one section. */
export interface TermEntry {
  /** Term frequency per field. At least one field is > 0. */
  readonly tf: FieldValues;
  /** Token positions per field; `positions[f].length === tf[f]`. */
  readonly positions: FieldPositions;
}

/**
 * A section turned into indexable data: field lengths in tokens, plus, for
 * each distinct term, its frequency and positions in each field. This is what
 * a storage layer persists: one row per section (`lengths`) and one posting
 * row per (term, section) (`terms`).
 */
export interface AnalyzedSection {
  readonly lengths: FieldValues;
  readonly terms: ReadonlyMap<string, TermEntry>;
}

/** A FieldValues with every field set to `value`. */
export function fieldValues(value: number): FieldValues {
  return { title: value, heading: value, body: value };
}

/** Analyzes each field of a section into lengths and per-term postings. */
export function analyzeSection(
  section: Section,
  options?: Partial<AnalyzerOptions>,
): AnalyzedSection {
  const lengths = { title: 0, heading: 0, body: 0 };
  const acc = new Map<string, Record<Field, number[]>>();
  for (const field of FIELDS) {
    const tokens = analyze(section[field], options);
    lengths[field] = tokens.length;
    for (const token of tokens) {
      let entry = acc.get(token.text);
      if (!entry) {
        entry = { title: [], heading: [], body: [] };
        acc.set(token.text, entry);
      }
      entry[field].push(token.position);
    }
  }
  const terms = new Map<string, TermEntry>();
  for (const [term, positions] of acc) {
    terms.set(term, {
      tf: {
        title: positions.title.length,
        heading: positions.heading.length,
        body: positions.body.length,
      },
      positions,
    });
  }
  return { lengths, terms };
}
