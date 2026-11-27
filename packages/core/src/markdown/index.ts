// Markdown parsing: front matter, sections, titles, wiki-links, link
// resolution and diffing, and folder roles. Isomorphic: no Node built-ins.

export {
  indentWidth,
  parseAtxHeading,
  scanBlocks,
  splitLines,
  type BlockScan,
  type LineKind,
  type ScannedLine,
} from './blocks.js';
export {
  chunkNote,
  noteTitle,
  sectionsFromScan,
  titleFromPath,
  titleFromScan,
  type Section,
} from './chunker.js';
export { detectFrontMatter, type FrontMatter } from './front-matter.js';
export { maskCodeSpans, splitWikiLink, stripInlineMarkdown, type WikiLinkParts } from './inline.js';
export { addedLinkItems, linkItems } from './link-diff.js';
export { linksFromScan, parseLinks, type WikiLink } from './links.js';
export { parseNote, type ParsedNote } from './note.js';
export { isPublished } from './publish.js';
export {
  baseName,
  dirName,
  hasNonMarkdownExtension,
  isMarkdownPath,
  normalizePath,
  stripMd,
} from './paths.js';
export {
  createLinkResolver,
  normalizeDanglingKey,
  resolutionItem,
  resolveLink,
  type LinkResolution,
  type LinkResolver,
} from './resolve.js';
export {
  DEFAULT_FOLDER_ROLES,
  PathPatternError,
  ROLE_PRECEDENCE,
  SCORED_ROLES,
  classifyPath,
  compilePathPattern,
  createRoleClassifier,
  isScoredRole,
  isValidCalendarDate,
  matchDatedPath,
  parseCalendarDate,
  renderDatedPath,
  type FolderRole,
  type FolderRolesConfig,
  type PathPattern,
  type RoleClassifier,
  type RoleMatch,
} from './roles.js';
