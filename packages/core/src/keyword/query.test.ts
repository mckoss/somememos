import { describe, expect, it } from 'vitest';
import { parseQuery } from './query.js';

describe('parseQuery', () => {
  it('turns words into stemmed term clauses', () => {
    expect(parseQuery('Running Shoes')).toEqual({
      clauses: [
        { kind: 'term', term: 'run' },
        { kind: 'term', term: 'shoe' },
      ],
      terms: ['run', 'shoe'],
    });
  });

  it('parses quoted phrases, straight or curly', () => {
    expect(parseQuery('"red kite" hill “old oak”').clauses).toEqual([
      { kind: 'phrase', terms: ['red', 'kite'] },
      { kind: 'term', term: 'hill' },
      { kind: 'phrase', terms: ['old', 'oak'] },
    ]);
  });

  it('treats a one-word phrase as a term and an unclosed quote as running to the end', () => {
    expect(parseQuery('"kite"').clauses).toEqual([{ kind: 'term', term: 'kite' }]);
    expect(parseQuery('hill "red kite').clauses).toEqual([
      { kind: 'term', term: 'hill' },
      { kind: 'phrase', terms: ['red', 'kite'] },
    ]);
  });

  it('drops duplicate clauses and lists distinct terms once', () => {
    const q = parseQuery('kites kite "red kite" "red kites"');
    expect(q.clauses).toEqual([
      { kind: 'term', term: 'kite' },
      { kind: 'phrase', terms: ['red', 'kite'] },
    ]);
    expect(q.terms).toEqual(['kite', 'red']);
  });

  it('gives operators no special meaning', () => {
    expect(parseQuery('cats AND -dogs').terms).toEqual(['cat', 'and', 'dog']);
  });

  it('splits compound identifiers into terms; quotes make them a phrase', () => {
    expect(parseQuery('snake_case').clauses).toEqual([
      { kind: 'term', term: 'snake' },
      { kind: 'term', term: 'case' },
    ]);
    expect(parseQuery('"snake_case"').clauses).toEqual([
      { kind: 'phrase', terms: ['snake', 'case'] },
    ]);
  });

  it('returns no clauses for an empty query', () => {
    expect(parseQuery('  "" !! ')).toEqual({ clauses: [], terms: [] });
  });
});
