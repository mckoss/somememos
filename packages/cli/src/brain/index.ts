// Shared helpers for commands: argument parsing with the global options, the
// brain context (`withBrain`), and output.

export {
  GLOBAL_OPTIONS,
  GLOBAL_OPTIONS_HELP,
  type GlobalOptions,
  parseCommandArgs,
} from './args.js';
export {
  BRAIN_BUSY_TIMEOUT_MS,
  type Brain,
  BrainNotFoundError,
  type WithBrainOptions,
  brainOptions,
  findBrainRoot,
  isBrainRoot,
  isDirectory,
  remindUncommitted,
  withBrain,
} from './brain.js';
export { CommandError, emit, oneLine, plural, printJson, printLines, warn } from './output.js';
export {
  type BrainLocation,
  type RemoteSession,
  type Session,
  locateBrain,
  openRemote,
  remindRemote,
  withSession,
} from './session.js';
