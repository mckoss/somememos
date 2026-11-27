// Store-backed entry points: gather what the pure ranking functions need from
// a `storage.Stores`, rank, and add snippets. Search results and activation
// lists are not events: nothing here writes to the log.

import { parseQuery, type ParsedQuery } from '../keyword/query.js';
import { searchSource } from '../keyword/search.js';
import { makeSnippet } from '../keyword/snippet.js';
import type { Stores } from '../storage/types.js';
import { parseSectionId } from '../storage/validate.js';
import { linkGraphFromMaps, type LinkGraph } from './activation.js';
import {
  resolveRankingParams,
  spreadingActive,
  type RankMode,
  type RankingParams,
  type RankingParamsInput,
} from './params.js';
import { rankByActivation, rankKeywordHits, type NoteMeta, type RankedResult } from './rank.js';

/** Prefetches the links spreading needs around `items`, as a synchronous graph. */
export async function loadLinkGraph(
  stores: Stores,
  items: Iterable<string>,
  p: RankingParams,
): Promise<LinkGraph> {
  const outgoing = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  const dir = p.spreading.direction;
  for (const item of new Set(items)) {
    if (dir === 'outgoing' || dir === 'both') {
      outgoing.set(
        item,
        (await stores.notes.linksFrom(item)).map((l) => l.target),
      );
    }
    if (dir === 'backlinks' || dir === 'both') {
      backlinks.set(item, await stores.notes.backlinks(item));
    }
  }
  return linkGraphFromMaps(outgoing, backlinks);
}

async function noteMap(stores: Stores): Promise<Map<string, NoteMeta>> {
  return new Map((await stores.notes.listNotes()).map((n) => [n.path, n]));
}

export interface RankSearchOptions extends RankingParamsInput {
  /** The ranking mode. Default `'hot'`. */
  readonly mode?: RankMode;
  /** Snippet length in characters (`keyword.makeSnippet`). */
  readonly snippetLength?: number;
}

/**
 * Keyword search ranked by `mode` (default `hot`): each note appears once,
 * with its best section, a snippet and the score components.
 */
export async function rankSearch(
  stores: Stores,
  query: string | ParsedQuery,
  options: RankSearchOptions = {},
): Promise<RankedResult[]> {
  const { mode = 'hot', snippetLength, ...input } = options;
  const p = resolveRankingParams(input);
  const parsed = typeof query === 'string' ? parseQuery(query, stores.terms.analyzer) : query;
  const hits = await searchSource(stores.terms, parsed, {
    mode: p.matchMode,
    params: p.keyword,
  });
  const scores = await stores.scores.getAll();
  const notes = await noteMap(stores);
  let links: LinkGraph | undefined;
  if (spreadingActive(p)) {
    const paths = new Set<string>();
    for (const h of hits) {
      const sid = parseSectionId(h.id);
      if (sid) paths.add(sid.path);
    }
    links = await loadLinkGraph(stores, paths, p);
  }
  const ranked = rankKeywordHits(hits, { scores, notes, ...(links ? { links } : {}) }, mode, p);
  const out: RankedResult[] = [];
  for (const r of ranked) {
    const section = r.sectionId === null ? undefined : await stores.terms.getSection(r.sectionId);
    out.push({
      ...r,
      title: notes.get(r.item)?.title ?? section?.title ?? r.title,
      heading: section?.heading ?? r.heading,
      snippet: section
        ? makeSnippet(section.body, parsed, {
            analyzer: stores.terms.analyzer,
            ...(snippetLength !== undefined ? { targetLength: snippetLength } : {}),
          })
        : null,
    });
  }
  return out;
}

/**
 * The keyword-less list for `mode`: memo notes and dangling items ranked by
 * activation alone (dangling ones flagged).
 */
export async function rankActivation(
  stores: Stores,
  mode: RankMode = 'hot',
  options: RankingParamsInput = {},
): Promise<RankedResult[]> {
  const p = resolveRankingParams(options);
  const scores = await stores.scores.getAll();
  const notes = await noteMap(stores);
  const links = spreadingActive(p) ? await loadLinkGraph(stores, scores.keys(), p) : undefined;
  return rankByActivation({ scores, notes, ...(links ? { links } : {}) }, mode, p);
}
