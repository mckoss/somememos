import { describe, expect, it } from 'vitest';
import { engine } from '@somememos/core';
import { errorCode, errorMessage } from './errors.ts';

describe('errorMessage', () => {
  it('explains engine errors in plain words, without the path', () => {
    const err = new engine.EngineError('excluded', 'excluded', null);
    expect(errorMessage(err)).toMatch(/private/);
    expect(errorCode(err)).toBe('excluded');
  });

  it('accepts an error that crossed a worker boundary', () => {
    const json = new engine.EngineError('exists', 'a note exists at x.md', 'x.md').toJSON();
    expect(errorMessage(json)).toMatch(/already exists/);
  });

  it('adds detail for invalid arguments', () => {
    expect(errorMessage(new engine.EngineError('invalid-argument', 'bad date'))).toMatch(
      /bad date/,
    );
  });

  it('falls back for other errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('Something went wrong: boom');
    expect(errorCode(new Error('boom'))).toBeNull();
  });
});
