// Plain-language messages for the engine's errors (`EngineError` codes).

import { engine } from '@somememos/core';

const MESSAGES: Record<engine.EngineErrorCode, string> = {
  'invalid-path':
    'That isn’t a usable note name. Note paths are folders and a file name ending in .md, like memos/my-note.md.',
  excluded: 'That folder is private: it is excluded from somememos, so its notes are never shown.',
  'not-found':
    'There’s no note there. It may have been renamed or deleted, or its folder has no role.',
  exists: 'A note with that name already exists. Choose another name.',
  'source-immutable':
    'This note is a source. Sources can’t be changed once they exist; make a memo that quotes it instead.',
  'no-dated-pattern':
    'This brain has no diary folder. Add a “dated” folder in More → Folder roles to use the diary.',
  'invalid-argument': 'Something in that request wasn’t valid.',
};

/** A message a person can act on, for anything thrown by the brain. */
export function errorMessage(error: unknown): string {
  if (engine.isEngineError(error)) {
    const base = MESSAGES[error.code] ?? 'Something went wrong.';
    // invalid-argument messages are about the request itself, which helps here.
    return error.code === 'invalid-argument' ? `${base} (${error.message})` : base;
  }
  if (error instanceof Error && error.name === 'QuotaExceededError') {
    return 'This device is out of storage space for the app.';
  }
  return `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
}

/** The error's code, when it is an engine error. */
export function errorCode(error: unknown): engine.EngineErrorCode | null {
  return engine.isEngineError(error) ? error.code : null;
}
