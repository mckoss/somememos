// @somememos/server: the somememos server's logic, independent of SvelteKit.
// Brains kept as git repositories (one commit per accepted change set), the
// sync protocol, the engine over HTTP, and access checks. apps/web mounts
// `App.handle` on its /api routes. Node-only.

export {
  type App,
  type AppOptions,
  type RequestInfo,
  createApp,
  createAppFromEnv,
} from './http.js';
export {
  type Authorizer,
  FailureLimiter,
  type FailureLimiterOptions,
  MIN_TOKEN_LENGTH,
  OWNER_ID,
  type Principal,
  type TokenSet,
  bearerToken,
  hashToken,
  parseTokens,
  tokenAuthorizer,
  tokenMatches,
} from './auth.js';
export {
  BRAIN_ID,
  type BrainContext,
  BrainError,
  type BrainErrorCode,
  type BrainInfo,
  BrainService,
  type BrainServiceOptions,
  CLIENT_ID,
  type CommittedChanges,
  SERVER_CLIENT_ID,
  type StoredConfig,
  parseStoredConfig,
} from './brains.js';
export { type ConfigResult, type ServerConfig, loadServerConfig } from './config.js';
export { ENGINE_ERROR_STATUS, HttpError } from './errors.js';
export {
  BRANCH,
  BrainRepo,
  COMMITTER,
  type CommitInfo,
  type CommitInput,
  GitError,
  ORPHAN_REF_PREFIX,
  type StagedChange,
  commitMessage,
  gitEnvironment,
  isCommitId,
  runGit,
} from './git.js';
export { createGitContentStore } from './git-content.js';
export {
  type NoteHistory,
  type NoteVersion,
  type PastVersion,
  noteHistory,
  pastVersion,
} from './history.js';
export { PAGE_TEXT_BYTES, parseSyncRequest, readPage, runSync } from './sync.js';
export { TransactionPool } from './tx-pool.js';
