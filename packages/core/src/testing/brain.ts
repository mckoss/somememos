// A seeded, deterministic generator of an invented brain, for tests, examples and
// documentation. Everything here is made up: the topics, people, projects and
// text are fictional, and nothing comes from a real brain.
//
// `generateBrain` is pure: it returns a timeline of dated steps (file writes,
// renames and deletes, each step with a commit message) plus ground truth that
// indexer and importer tests can check against. `materialize.ts` writes it to
// disk, optionally as a git history.

import { createRng } from './prng.js';

// ---------------------------------------------------------------------------
// Public types

export type Role = 'memo' | 'dated' | 'source' | 'excluded';
export type StepOp = 'ingest' | 'update' | 'session';
/** How a topic's activity changes over the timeline. */
export type TopicPhase = 'quiet' | 'steady' | 'hot' | 'heating';

export type FileChange =
  | { type: 'write'; path: string; content: string }
  /** A pure rename: the content is unchanged, so git detects it as a rename. */
  | { type: 'rename'; from: string; to: string }
  | { type: 'delete'; path: string };

export interface LinkTruth {
  /** The note containing the link. */
  source: string;
  /** The link exactly as written, e.g. `[[compost-tea#Recipe|the tea]]`. */
  raw: string;
  /** The target text before any `#heading` or `|alias`. */
  target: string;
  heading?: string;
  alias?: string;
  /** The note it pointed to at the end of its step, or null if it was dangling. */
  resolvedPath: string | null;
}

export interface StepTruth {
  created: string[];
  edited: string[];
  renamed: { from: string; to: string }[];
  deleted: string[];
  /** Links that this step added (each occurrence once), outside code fences. */
  linksAdded: LinkTruth[];
}

export interface Step {
  index: number;
  /** Unix seconds. Strictly increasing along the timeline. */
  time: number;
  op: StepOp;
  /** `<op> <summary>`, used as the commit message. */
  message: string;
  changes: FileChange[];
  truth: StepTruth;
}

export interface NoteTruth {
  path: string;
  role: Role;
  /** The `title:` from front matter, if the note has front matter. */
  frontMatterTitle?: string;
  /** `##` headings, in order (never the text inside code fences). */
  headings: string[];
  /** Links in the final content, in order, outside code fences. */
  links: LinkTruth[];
  /** Number of steps that wrote this note (creation included). */
  writes: number;
}

export interface TopicTruth {
  name: string;
  folder: string;
  phase: TopicPhase;
}

export interface BrainOptions {
  /** PRNG seed. Default 1. */
  seed?: number;
  /** Number of steps (commits). Default 60, minimum 20. */
  steps?: number;
  /** Number of topics, 3 to 8. Default 6. */
  topics?: number;
  /** Unix seconds of the first step. Default 2025-01-06T00:00:00Z. */
  start?: number;
  /** Length of the timeline in days. Default 180. */
  days?: number;
}

export interface SyntheticBrain {
  options: Required<BrainOptions>;
  steps: Step[];
  /** The final files, path to content, sorted by path. */
  files: Record<string, string>;
  /** Ground truth for every final note, sorted by path. */
  notes: NoteTruth[];
  topics: TopicTruth[];
  /** Notable features, so tests can find them without searching. */
  features: {
    /** A note renamed after other notes linked to it. */
    renamed: { from: string; to: string; step: number };
    /** A link target that dangled for a while and was created later. */
    danglingThenCreated: { target: string; path: string; linkedAt: number; createdAt: number };
    /** A note deleted near the end. */
    deleted: { path: string; step: number } | null;
    /** Indexes of steps that are bursts: several edits to one note within minutes. */
    bursts: { path: string; steps: number[] }[];
  };
}

export const EXCLUDED_FOLDER = 'private';

export const DEFAULT_BRAIN_OPTIONS: Required<BrainOptions> = {
  seed: 1,
  steps: 60,
  topics: 6,
  start: Date.UTC(2025, 0, 6) / 1000,
  days: 180,
};

export function roleOf(path: string): Role {
  if (path.startsWith('memos/')) return 'memo';
  if (path.startsWith('diary/')) return 'dated';
  if (path.startsWith('sources/')) return 'source';
  return 'excluded';
}

/** The diary path for a Unix time, in UTC: `diary/YYYY/MM/YYYY-MM-DD.md`. */
export function diaryPath(time: number): string {
  const date = isoDate(time);
  return `diary/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
}

// ---------------------------------------------------------------------------
// Invented vocabulary

interface TopicDef {
  name: string;
  nouns: string[];
  words: string[];
}

const TOPIC_DEFS: TopicDef[] = [
  {
    name: 'orchard',
    nouns: ['quince', 'graft', 'rootstock', 'cider', 'pruning', 'frost', 'pollinator', 'espalier'],
    words: ['blossom', 'scion', 'bark', 'orchard', 'ladder', 'harvest', 'sap', 'canopy'],
  },
  {
    name: 'telescope',
    nouns: [
      'mirror',
      'eyepiece',
      'collimation',
      'nebula',
      'mount',
      'dewshield',
      'finder',
      'eclipse',
    ],
    words: ['aperture', 'focus', 'seeing', 'star', 'tripod', 'lens', 'night', 'orbit'],
  },
  {
    name: 'boatbuilding',
    nouns: ['hull', 'keel', 'oar', 'varnish', 'plank', 'rigging', 'tiller', 'mast'],
    words: ['cedar', 'epoxy', 'clamp', 'bilge', 'stern', 'bow', 'scarf', 'launch'],
  },
  {
    name: 'sourdough',
    nouns: ['starter', 'crumb', 'levain', 'proofing', 'scoring', 'hydration', 'rye', 'banneton'],
    words: ['flour', 'crust', 'oven', 'dough', 'rise', 'salt', 'loaf', 'steam'],
  },
  {
    name: 'cartography',
    nouns: ['contour', 'compass', 'legend', 'projection', 'survey', 'atlas', 'gridline', 'inkwell'],
    words: ['map', 'scale', 'ridge', 'river', 'border', 'bearing', 'sheet', 'coast'],
  },
  {
    name: 'beekeeping',
    nouns: ['hive', 'queen', 'smoker', 'comb', 'swarm', 'nectar', 'frame', 'propolis'],
    words: ['bee', 'wax', 'honey', 'brood', 'drone', 'pollen', 'veil', 'colony'],
  },
  {
    name: 'clockwork',
    nouns: ['escapement', 'mainspring', 'pendulum', 'gear', 'balance', 'pinion', 'dial', 'chime'],
    words: ['tick', 'brass', 'arbor', 'tooth', 'oil', 'case', 'hand', 'bezel'],
  },
  {
    name: 'puppetry',
    nouns: ['marionette', 'shadow', 'string', 'stage', 'mask', 'glove', 'script', 'curtain'],
    words: ['puppet', 'cue', 'felt', 'lamp', 'voice', 'scene', 'prop', 'audience'],
  },
];

const PHASES: TopicPhase[] = [
  'quiet',
  'hot',
  'heating',
  'steady',
  'quiet',
  'hot',
  'steady',
  'heating',
];
const MODIFIERS = [
  'basics',
  'log',
  'ideas',
  'checklist',
  'questions',
  'plan',
  'glossary',
  'experiments',
  'mistakes',
  'reading',
];
const HEADINGS = [
  'Overview',
  'Open questions',
  'Log',
  'References',
  'Next steps',
  'Materials',
  'Results',
  'Ideas',
];
// Obviously fictional people and projects.
const PEOPLE = [
  'Marigold Thistlewick',
  'Barnaby Fenwhistle',
  'Odessa Pinecrumb',
  'Zebedee Quillfeather',
  'Persimmon Gale',
  'Tobias Mothwing',
];
const PROJECTS = ['Project Moonbarrow', 'the Teacup Initiative', 'Operation Lanternfish'];
const FILLER = [
  'the',
  'a',
  'with',
  'after',
  'before',
  'seems',
  'should',
  'try',
  'again',
  'small',
  'early',
  'second',
  'careful',
  'quick',
  'slow',
  'notes',
  'maybe',
  'because',
  'until',
  'checked',
];
const EDIT_VERBS = ['add notes', 'expand', 'fix details', 'record results', 'add questions'];

// ---------------------------------------------------------------------------
// The note model. Notes are kept as structure and rendered to markdown, so the
// ground truth (headings, links) comes from the model, not from parsing.

interface LinkRef {
  target: string;
  heading?: string;
  alias?: string;
}
type Inline = string | LinkRef;
type Block = { kind: 'para'; parts: Inline[] } | { kind: 'code'; lang: string; text: string };
interface Section {
  heading: string;
  blocks: Block[];
}
interface NoteModel {
  path: string;
  frontMatterTitle?: string;
  /** Extra front matter lines (for sources). */
  frontMatterExtra?: string[];
  h1?: string;
  preamble: Block[];
  sections: Section[];
}

function renderLink(link: LinkRef): string {
  return `[[${link.target}${link.heading ? `#${link.heading}` : ''}${link.alias ? `|${link.alias}` : ''}]]`;
}

function renderBlock(block: Block): string {
  if (block.kind === 'code') return `\`\`\`${block.lang}\n${block.text}\n\`\`\``;
  return block.parts.map((p) => (typeof p === 'string' ? p : `${renderLink(p)}.`)).join(' ');
}

function render(note: NoteModel): string {
  const parts: string[] = [];
  if (note.frontMatterTitle !== undefined) {
    parts.push(
      ['---', `title: ${note.frontMatterTitle}`, ...(note.frontMatterExtra ?? []), '---'].join(
        '\n',
      ),
    );
  }
  if (note.h1) parts.push(`# ${note.h1}`);
  for (const block of note.preamble) parts.push(renderBlock(block));
  for (const section of note.sections) {
    parts.push(`## ${section.heading}`);
    for (const block of section.blocks) parts.push(renderBlock(block));
  }
  return parts.join('\n\n') + '\n';
}

function linksOf(note: NoteModel): LinkRef[] {
  const out: LinkRef[] = [];
  const blocks = [...note.preamble, ...note.sections.flatMap((s) => s.blocks)];
  for (const block of blocks) {
    if (block.kind !== 'para') continue;
    for (const part of block.parts) if (typeof part !== 'string') out.push(part);
  }
  return out;
}

function cloneNote(note: NoteModel): NoteModel {
  return structuredClone(note);
}

// ---------------------------------------------------------------------------
// Helpers

function isoDate(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

function hhmm(time: number): string {
  return new Date(time * 1000).toISOString().slice(11, 16);
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

function profile(phase: TopicPhase, u: number): number {
  switch (phase) {
    case 'quiet':
      return u < 0.45 ? 3 : 0;
    case 'steady':
      return 1;
    case 'hot':
      return 0.6 + 2.5 * u;
    case 'heating':
      return u < 0.6 ? 0.15 : 0.15 + 8 * (u - 0.6);
  }
}

// ---------------------------------------------------------------------------
// The generator

interface MemoMeta {
  topic: string;
  frozen: boolean;
}

interface Slot {
  time: number;
  /** For a burst follower, the index of the step that leads the burst. */
  burstOf?: number;
  burstLeader?: boolean;
}

type Forced =
  | 'create-rename-subject'
  | 'link-dangling-and-subject'
  | 'link-again'
  | 'rename'
  | 'create-dangling'
  | 'delete';

const FORCED: [number, Forced][] = [
  [0.1, 'create-rename-subject'],
  [0.17, 'link-dangling-and-subject'],
  [0.27, 'link-again'],
  [0.5, 'rename'],
  [0.58, 'create-dangling'],
  [0.82, 'delete'],
];

export function generateBrain(options: BrainOptions = {}): SyntheticBrain {
  const opts: Required<BrainOptions> = { ...DEFAULT_BRAIN_OPTIONS, ...options };
  if (!Number.isInteger(opts.steps) || opts.steps < 20) throw new RangeError('steps must be >= 20');
  if (!Number.isInteger(opts.topics) || opts.topics < 3 || opts.topics > TOPIC_DEFS.length) {
    throw new RangeError(`topics must be 3..${TOPIC_DEFS.length}`);
  }
  if (!(opts.days > 0)) throw new RangeError('days must be > 0');
  const rng = createRng(opts.seed);
  const span = Math.floor(opts.days * 86_400);

  const topicDefs = TOPIC_DEFS.slice(0, opts.topics);
  const topics: TopicTruth[] = topicDefs.map((t, i) => ({
    name: t.name,
    folder: `memos/${t.name}`,
    phase: PHASES[i]!,
  }));
  const defOf = new Map(topicDefs.map((t) => [t.name, t]));
  const phaseOf = new Map(topics.map((t) => [t.name, t.phase]));

  // Unused memo slugs per topic, in a seeded order. Slugs are unique across the brain.
  const unused = new Map<string, string[]>();
  for (const t of topicDefs) {
    unused.set(t.name, rng.shuffle(t.nouns.flatMap((n) => MODIFIERS.map((m) => `${n}-${m}`))));
  }
  let extraNames = 0;
  const takeSlug = (topic: string, avoid: Set<string>): string => {
    const list = unused.get(topic)!;
    const i = list.findIndex((s) => !avoid.has(s));
    if (i >= 0) return list.splice(i, 1)[0]!;
    // Large brains: numbered names once the combinations run out.
    let slug: string;
    do slug = `${rng.pick(defOf.get(topic)!.nouns)}-notes-${++extraNames}`;
    while (avoid.has(slug));
    return slug;
  };

  // ---- the schedule: strictly increasing times, with bursts
  const slots: Slot[] = [];
  while (slots.length < opts.steps) {
    const base = opts.start + Math.floor((span * (slots.length + rng.next() * 0.9)) / opts.steps);
    const prev = slots.length ? slots[slots.length - 1]!.time : opts.start - 1;
    const time = Math.max(base, prev + 1);
    const remaining = opts.steps - slots.length;
    // Random bursts, and at least one by a third of the way through.
    const forceBurst =
      slots.length >= Math.round(opts.steps / 3) && !slots.some((s) => s.burstLeader);
    if (slots.length > 2 && remaining > 5 && (forceBurst || rng.chance(0.08))) {
      const leader = slots.length;
      slots.push({ time, burstLeader: true });
      const followers = rng.int(2, 3);
      let t = time;
      for (let k = 0; k < followers; k++) {
        t += rng.int(60, 540);
        slots.push({ time: t, burstOf: leader });
      }
    } else {
      slots.push({ time });
    }
  }
  slots.length = opts.steps;
  const forcedAt = new Map<number, Forced>();
  for (const [fraction, action] of FORCED) {
    let i = Math.round(fraction * opts.steps);
    while (
      i < opts.steps &&
      (forcedAt.has(i) || slots[i]!.burstOf !== undefined || slots[i]!.burstLeader)
    )
      i++;
    if (i >= opts.steps) throw new RangeError('could not place forced steps; use more steps');
    forcedAt.set(i, action);
  }

  // ---- state
  const notes = new Map<string, NoteModel>();
  const memoMeta = new Map<string, MemoMeta>();
  const writes = new Map<string, number>();
  const plannedDangling = new Map<string, string>(); // slug -> topic, linked before it exists
  const steps: Step[] = [];
  const bursts: SyntheticBrain['features']['bursts'] = [];
  let renameSubject = '';
  let renamed: SyntheticBrain['features']['renamed'] | undefined;
  let danglingSlug = '';
  let danglingLinkedAt = -1;
  let danglingCreatedAt = -1;
  let danglingPath = '';
  let firstMemo = '';
  let deleted: SyntheticBrain['features']['deleted'] = null;
  let sourceCount = 0;
  let codeFenceWritten = false;

  const allSlugs = () => new Set([...notes.keys()].map(basename));
  const memosIn = (topic: string) =>
    [...memoMeta.entries()].filter(([p, m]) => m.topic === topic && notes.has(p)).map(([p]) => p);

  // Per-step working set.
  let changes: FileChange[];
  let before = new Map<string, NoteModel | null>();
  let time = 0;
  let u = 0;

  const touch = (path: string) => {
    if (!before.has(path)) before.set(path, notes.has(path) ? cloneNote(notes.get(path)!) : null);
  };
  const write = (note: NoteModel) => {
    touch(note.path);
    notes.set(note.path, note);
  };

  const sentence = (topic: string): string => {
    const def = defOf.get(topic)!;
    const n = rng.int(5, 11);
    const words: string[] = [];
    for (let i = 0; i < n; i++) {
      words.push(
        rng.chance(0.45)
          ? rng.pick(def.words)
          : rng.chance(0.3)
            ? rng.pick(def.nouns)
            : rng.pick(FILLER),
      );
    }
    if (rng.chance(0.2)) words.push('with', rng.pick(PEOPLE));
    else if (rng.chance(0.1)) words.push('for', rng.pick(PROJECTS));
    const text = words.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1) + '.';
  };

  const pickTopic = (filter?: (t: TopicTruth) => boolean): string => {
    const pool = topics.filter((t) => !filter || filter(t));
    const weights = pool.map((t) => profile(t.phase, u));
    if (!weights.some((w) => w > 0)) return pool[0]!.name;
    return pool[rng.weighted(weights)]!.name;
  };
  const activeTopic = () => pickTopic((t) => t.phase === 'steady' || t.phase === 'hot');

  /** A link to an existing note of `topic` (or `fallback`), in a random form. */
  const linkTo = (path: string, preferForm?: 'bare' | 'path' | 'alias' | 'heading'): LinkRef => {
    const slug = basename(path);
    const target = notes.get(path);
    const form = preferForm ?? rng.pick(['bare', 'bare', 'path', 'alias', 'heading'] as const);
    if (form === 'path') return { target: path.replace(/\.md$/, '') };
    if (form === 'alias') {
      const topic = memoMeta.get(path)?.topic;
      const words = topic ? defOf.get(topic)!.words : FILLER;
      return { target: slug, alias: `${rng.pick(words)} notes` };
    }
    if (form === 'heading' && target && target.sections.length > 0) {
      return { target: slug, heading: rng.pick(target.sections).heading };
    }
    return { target: slug };
  };

  const paragraph = (topic: string, links: LinkRef[]): Block => {
    const parts: Inline[] = [sentence(topic)];
    for (const link of links) {
      parts.push(rng.pick(['See', 'Related:', 'Compare', 'Also']), link);
      if (rng.chance(0.5)) parts.push(sentence(topic));
    }
    return { kind: 'para', parts };
  };

  /** Links from a note in `topic` to a few existing notes, sometimes in other active topics. */
  const someLinks = (topic: string, self: string, max: number): LinkRef[] => {
    const out: LinkRef[] = [];
    const count = rng.int(0, max);
    for (let i = 0; i < count; i++) {
      const other = rng.chance(0.75) ? topic : pickTopic();
      const candidates = memosIn(other).filter((p) => p !== self);
      if (candidates.length === 0) continue;
      out.push(linkTo(rng.pick(candidates)));
    }
    return out;
  };

  const newHeading = (note: NoteModel): string => {
    const used = new Set(note.sections.map((s) => s.heading));
    const free = HEADINGS.filter((h) => !used.has(h));
    return free.length ? rng.pick(free) : `Log ${note.sections.length + 1}`;
  };

  const createMemo = (topic: string, slug: string, extraLinks: LinkRef[] = []): NoteModel => {
    const path = `memos/${topic}/${slug}.md`;
    const title = titleCase(slug);
    const note: NoteModel = { path, preamble: [], sections: [] };
    if (rng.chance(0.6)) note.frontMatterTitle = title;
    else if (rng.chance(0.5)) note.h1 = title;
    note.preamble.push(paragraph(topic, []));
    const sectionCount = rng.int(1, 3);
    for (let i = 0; i < sectionCount; i++) {
      const links =
        i === 0 ? [...extraLinks, ...someLinks(topic, path, 2)] : someLinks(topic, path, 1);
      note.sections.push({ heading: newHeading(note), blocks: [paragraph(topic, links)] });
    }
    if (!codeFenceWritten || rng.chance(0.2)) {
      codeFenceWritten = true;
      note.sections.push({
        heading: newHeading(note),
        blocks: [
          paragraph(topic, []),
          {
            kind: 'code',
            lang: 'markdown',
            text: `## Not a heading, inside a fence\nAn example link: [[not-a-real-link]] and [[${slug}#Overview|also not a link]].`,
          },
        ],
      });
    }
    memoMeta.set(path, { topic, frozen: !firstMemo || rng.chance(0.25) });
    if (!firstMemo) firstMemo = path;
    write(note);
    return note;
  };

  const editMemo = (path: string, extraLinks: LinkRef[] = []): void => {
    const note = cloneNote(notes.get(path)!);
    const topic = memoMeta.get(path)!.topic;
    const links = [...extraLinks, ...someLinks(topic, path, 1)];
    const r = rng.next();
    if (r < 0.35 || note.sections.length === 0) {
      note.sections.push({ heading: newHeading(note), blocks: [paragraph(topic, links)] });
    } else if (r < 0.75 || links.length > 0) {
      rng.pick(note.sections).blocks.push(paragraph(topic, links));
    } else {
      const section = rng.pick(note.sections);
      const para = section.blocks.find((b) => b.kind === 'para');
      if (para && para.kind === 'para') para.parts.push(sentence(topic));
      else section.blocks.push(paragraph(topic, []));
    }
    write(note);
  };

  /** An existing memo of `topic` that may still be edited, or a new one. */
  const editableMemo = (topic: string): { path: string; created: boolean } => {
    const candidates = memosIn(topic).filter((p) => !memoMeta.get(p)!.frozen);
    if (candidates.length > 0 && rng.chance(0.8)) {
      // Favor the oldest few: some notes are edited many times.
      const weights = candidates.map((_, i) => 1 / (i + 1));
      return { path: candidates[rng.weighted(weights)]!, created: false };
    }
    const slug = takeSlug(topic, allSlugs());
    return { path: createMemo(topic, slug).path, created: true };
  };

  const diaryEntry = (topic: string, links: LinkRef[]): void => {
    const path = diaryPath(time);
    const existing = notes.get(path);
    const note: NoteModel = existing
      ? cloneNote(existing)
      : { path, h1: isoDate(time), preamble: [], sections: [] };
    note.sections.push({ heading: `${hhmm(time)} ${topic}`, blocks: [paragraph(topic, links)] });
    write(note);
  };

  const writePrivate = (): void => {
    const path = rng.chance(0.6)
      ? `${EXCLUDED_FOLDER}/journal.md`
      : `${EXCLUDED_FOLDER}/ideas-${rng.int(1, 3)}.md`;
    const existing = notes.get(path);
    const note: NoteModel = existing
      ? cloneNote(existing)
      : { path, h1: 'Private', preamble: [], sections: [] };
    note.sections.push({
      heading: `Entry ${isoDate(time)} ${hhmm(time)}`,
      blocks: [paragraph(activeTopic(), [])],
    });
    write(note);
  };

  for (let index = 0; index < opts.steps; index++) {
    const slot = slots[index]!;
    time = slot.time;
    u = (time - opts.start) / span;
    changes = [];
    before = new Map();
    const renames: { from: string; to: string }[] = [];
    const deletes: string[] = [];
    let op: StepOp = 'update';
    let summary: string;

    const forced = forcedAt.get(index);
    if (forced === 'create-rename-subject') {
      const topic = activeTopic();
      const note = createMemo(topic, takeSlug(topic, allSlugs()));
      memoMeta.get(note.path)!.frozen = false;
      renameSubject = note.path;
      summary = `create ${basename(note.path)}`;
    } else if (forced === 'link-dangling-and-subject') {
      const topic = memoMeta.get(renameSubject)!.topic;
      danglingSlug = takeSlug(topic, allSlugs());
      plannedDangling.set(danglingSlug, topic);
      danglingLinkedAt = index;
      op = 'session';
      diaryEntry(topic, [{ target: danglingSlug }, linkTo(renameSubject, 'bare')]);
      summary = `${topic} ${hhmm(time)}`;
    } else if (forced === 'link-again') {
      const topic = memoMeta.get(renameSubject)!.topic;
      const others = memosIn(topic).filter((p) => p !== renameSubject && !memoMeta.get(p)!.frozen);
      const extra = [
        linkTo(renameSubject, 'alias'),
        { target: danglingSlug, alias: 'still to write' },
      ];
      if (others.length > 0) {
        const path = rng.pick(others);
        editMemo(path, extra);
        summary = `${basename(path)}: add links`;
      } else {
        const note = createMemo(topic, takeSlug(topic, allSlugs()), extra);
        summary = `create ${basename(note.path)}`;
      }
    } else if (forced === 'rename') {
      const topic = memoMeta.get(renameSubject)!.topic;
      const to = `memos/${topic}/${takeSlug(topic, allSlugs())}.md`;
      const note = cloneNote(notes.get(renameSubject)!);
      notes.delete(renameSubject);
      note.path = to;
      notes.set(to, note);
      memoMeta.set(to, memoMeta.get(renameSubject)!);
      memoMeta.delete(renameSubject);
      renames.push({ from: renameSubject, to });
      changes.push({ type: 'rename', from: renameSubject, to });
      renamed = { from: renameSubject, to, step: index };
      summary = `rename ${basename(renameSubject)} to ${basename(to)}`;
    } else if (forced === 'create-dangling') {
      const topic = plannedDangling.get(danglingSlug)!;
      const note = createMemo(topic, danglingSlug, [linkTo(renamed!.to, 'path')]);
      plannedDangling.delete(danglingSlug);
      danglingCreatedAt = index;
      danglingPath = note.path;
      summary = `create ${basename(note.path)}`;
    } else if (forced === 'delete') {
      // A frozen memo of an active topic; never the first memo (kept as a never-edited note).
      const protectedPaths = new Set([renamed!.to, danglingPath, firstMemo]);
      const deletable = [...memoMeta.entries()]
        .filter(([p]) => notes.has(p) && !protectedPaths.has(p))
        .filter(([, m]) => phaseOf.get(m.topic) !== 'quiet');
      const frozen = deletable.filter(([, m]) => m.frozen);
      const candidates = (frozen.length > 0 ? frozen : deletable).map(([p]) => p);
      if (candidates.length > 0) {
        const path = rng.pick(candidates);
        notes.delete(path);
        memoMeta.delete(path);
        deletes.push(path);
        changes.push({ type: 'delete', path });
        deleted = { path, step: index };
        summary = `remove ${basename(path)}`;
      } else {
        const topic = activeTopic();
        const { path } = editableMemo(topic);
        editMemo(path);
        summary = `${basename(path)}: ${rng.pick(EDIT_VERBS)}`;
      }
    } else if (slot.burstOf !== undefined) {
      const burst = bursts[bursts.length - 1]!;
      editMemo(burst.path);
      burst.steps.push(index);
      summary = `${basename(burst.path)}: ${rng.pick(['fix typo', 'add detail', 'tidy'])}`;
    } else if (slot.burstLeader) {
      const topic = pickTopic();
      let target = editableMemo(topic);
      if (target.path === firstMemo) {
        target = { path: createMemo(topic, takeSlug(topic, allSlugs())).path, created: true };
      }
      if (!target.created) editMemo(target.path);
      memoMeta.get(target.path)!.frozen = false;
      bursts.push({ path: target.path, steps: [index] });
      summary = `${basename(target.path)}: ${rng.pick(EDIT_VERBS)}`;
    } else {
      const topic = pickTopic();
      const r = rng.next();
      if (r < 0.15) {
        op = 'ingest';
        sourceCount++;
        const slug = `${topic}-reading-${sourceCount}`;
        const path = `sources/${topic}/${slug}.md`;
        const title = `${titleCase(rng.pick(defOf.get(topic)!.nouns))} Field Notes ${sourceCount}`;
        write({
          path,
          frontMatterTitle: title,
          frontMatterExtra: ['origin: invented for tests'],
          preamble: [paragraph(topic, []), paragraph(topic, [])],
          sections: [{ heading: 'Excerpt', blocks: [paragraph(topic, [])] }],
        });
        const { path: memo, created } = editableMemo(topic);
        const sourceLink: LinkRef = { target: path.replace(/\.md$/, '') };
        if (created) {
          const note = cloneNote(notes.get(memo)!);
          note.sections[0]!.blocks.push(paragraph(topic, [sourceLink]));
          write(note);
        } else {
          editMemo(memo, [sourceLink]);
        }
        summary = `${title} into ${basename(memo)}`;
      } else if (r < 0.55) {
        op = 'session';
        const memos = memosIn(topic);
        const links: LinkRef[] = [];
        for (let k = rng.int(1, 3); k > 0 && memos.length > 0; k--)
          links.push(linkTo(rng.pick(memos)));
        if (rng.chance(0.15)) {
          const slug = takeSlug(topic, allSlugs());
          plannedDangling.set(slug, topic);
          links.push({ target: slug });
        }
        diaryEntry(topic, links);
        if (rng.chance(0.5)) editMemo(editableMemo(topic).path);
        summary = `${topic} ${hhmm(time)}`;
      } else {
        const planned = [...plannedDangling.entries()].filter(
          ([s, t]) => t === topic && s !== danglingSlug,
        );
        if (planned.length > 0 && rng.chance(0.3)) {
          const [slug] = rng.pick(planned);
          plannedDangling.delete(slug);
          createMemo(topic, slug);
          summary = `create ${slug}`;
        } else {
          const target = editableMemo(topic);
          if (!target.created) editMemo(target.path);
          summary = target.created
            ? `create ${basename(target.path)}`
            : `${basename(target.path)}: ${rng.pick(EDIT_VERBS)}`;
        }
      }
    }
    if (index === 0 || rng.chance(0.1)) writePrivate();

    // ---- collect changes and truth for this step
    const created: string[] = [];
    const edited: string[] = [];
    const linksAdded: LinkTruth[] = [];
    for (const [path, old] of before) {
      const note = notes.get(path)!;
      const content = render(note);
      changes.push({ type: 'write', path, content });
      writes.set(path, (writes.get(path) ?? 0) + 1);
      (old ? edited : created).push(path);
      const oldCounts = new Map<string, number>();
      for (const link of old ? linksOf(old) : []) {
        const raw = renderLink(link);
        oldCounts.set(raw, (oldCounts.get(raw) ?? 0) + 1);
      }
      for (const link of linksOf(note)) {
        const raw = renderLink(link);
        const left = oldCounts.get(raw) ?? 0;
        if (left > 0) oldCounts.set(raw, left - 1);
        else linksAdded.push(linkTruth(path, link));
      }
    }
    for (const r of renames) writes.set(r.to, (writes.get(r.from) ?? 0) + (writes.get(r.to) ?? 0));
    for (const r of renames) writes.delete(r.from);
    for (const d of deletes) writes.delete(d);
    // Resolve links against the files that exist at the end of the step.
    for (const link of linksAdded) link.resolvedPath = resolve(link.target, notes);

    steps.push({
      index,
      time,
      op,
      message: `${op} ${summary}`,
      changes,
      truth: { created, edited, renamed: renames, deleted: deletes, linksAdded },
    });
  }

  const paths = [...notes.keys()].sort();
  const files: Record<string, string> = {};
  for (const p of paths) files[p] = render(notes.get(p)!);
  const noteTruths: NoteTruth[] = paths.map((p) => {
    const note = notes.get(p)!;
    const truth: NoteTruth = {
      path: p,
      role: roleOf(p),
      headings: note.sections.map((s) => s.heading),
      links: linksOf(note).map((l) => ({
        ...linkTruth(p, l),
        resolvedPath: resolve(l.target, notes),
      })),
      writes: writes.get(p) ?? 0,
    };
    if (note.frontMatterTitle !== undefined) truth.frontMatterTitle = note.frontMatterTitle;
    return truth;
  });

  return {
    options: opts,
    steps,
    files,
    notes: noteTruths,
    topics,
    features: {
      renamed: renamed!,
      danglingThenCreated: {
        target: danglingSlug,
        path: danglingPath,
        linkedAt: danglingLinkedAt,
        createdAt: danglingCreatedAt,
      },
      deleted,
      bursts,
    },
  };
}

function linkTruth(source: string, link: LinkRef): LinkTruth {
  const truth: LinkTruth = {
    source,
    raw: renderLink(link),
    target: link.target,
    resolvedPath: null,
  };
  if (link.heading !== undefined) truth.heading = link.heading;
  if (link.alias !== undefined) truth.alias = link.alias;
  return truth;
}

/**
 * Resolve a link target the way the generator writes them: a target with a `/`
 * is a path without `.md`; otherwise it is a file name, unique in this brain.
 */
function resolve(target: string, notes: Map<string, NoteModel>): string | null {
  if (target.includes('/')) return notes.has(`${target}.md`) ? `${target}.md` : null;
  for (const path of notes.keys()) {
    if (roleOf(path) !== 'excluded' && basename(path) === target) return path;
  }
  return null;
}

/** The files after step `upTo` (inclusive; default the last step), path to content. */
export function filesAfter(steps: readonly Step[], upTo = steps.length - 1): Map<string, string> {
  const files = new Map<string, string>();
  for (const step of steps.slice(0, upTo + 1)) {
    for (const change of step.changes) {
      if (change.type === 'write') files.set(change.path, change.content);
      else if (change.type === 'delete') files.delete(change.path);
      else {
        const content = files.get(change.from);
        if (content === undefined) throw new Error(`rename of missing file ${change.from}`);
        files.delete(change.from);
        files.set(change.to, content);
      }
    }
  }
  return files;
}
