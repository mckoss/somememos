import { describe, expect, it } from 'vitest';
import { exactState, lineSeparatorFor, stateText } from './editor-text.ts';

describe('editor text', () => {
  it('picks CRLF only when every line ending is CRLF', () => {
    expect(lineSeparatorFor('a\nb')).toBe('\n');
    expect(lineSeparatorFor('a\r\nb\r\n')).toBe('\r\n');
    expect(lineSeparatorFor('a\r\nb\n')).toBe('\n');
    expect(lineSeparatorFor('a\r\nb\rc')).toBe('\n');
  });

  it('round-trips any text byte for byte', () => {
    const samples = [
      '',
      '# Title\n\nBody\n',
      'no trailing newline',
      '\r\n# windows\r\nline\r\n',
      'mixed\r\nendings\nand\rold mac\r',
      '\uFEFF# bom\n',
      '  leading and trailing spaces  \n\n\n',
      'tabs\tand\u00a0nbsp and emoji 🍐\n',
    ];
    for (const text of samples) expect(stateText(exactState(text))).toBe(text);
  });

  it('inserts new lines the way the note already ends them', () => {
    const state = exactState('a\r\nb');
    const next = state.update({ changes: { from: 1, insert: state.lineBreak } }).state;
    expect(stateText(next)).toBe('a\r\n\r\nb');
  });
});
