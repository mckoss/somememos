import { describe, expect, it } from 'vitest';
import { isStemmable, porterStem } from './porter.js';

// Word → stem pairs from Porter's 1980 paper and the reference vocabulary
// output (tartarus.org/martin/PorterStemmer: voc.txt / output.txt).
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  // Step 1a
  ['caresses', 'caress'],
  ['ponies', 'poni'],
  ['ties', 'ti'],
  ['caress', 'caress'],
  ['cats', 'cat'],
  // Step 1b
  ['feed', 'feed'],
  ['agreed', 'agre'],
  ['plastered', 'plaster'],
  ['bled', 'bled'],
  ['motoring', 'motor'],
  ['sing', 'sing'],
  ['conflated', 'conflat'],
  ['troubled', 'troubl'],
  ['sized', 'size'],
  ['hopping', 'hop'],
  ['tanned', 'tan'],
  ['falling', 'fall'],
  ['hissing', 'hiss'],
  ['fizzed', 'fizz'],
  ['failing', 'fail'],
  ['filing', 'file'],
  // Step 1c
  ['happy', 'happi'],
  ['sky', 'sky'],
  // Step 2 (full stems)
  ['relational', 'relat'],
  ['conditional', 'condit'],
  ['rational', 'ration'],
  ['valenci', 'valenc'],
  ['hesitanci', 'hesit'],
  ['digitizer', 'digit'],
  ['conformabli', 'conform'],
  ['radicalli', 'radic'],
  ['differentli', 'differ'],
  ['vileli', 'vile'],
  ['analogousli', 'analog'],
  ['vietnamization', 'vietnam'],
  ['predication', 'predic'],
  ['operator', 'oper'],
  ['feudalism', 'feudal'],
  ['decisiveness', 'decis'],
  ['hopefulness', 'hope'],
  ['callousness', 'callous'],
  ['formaliti', 'formal'],
  ['sensitiviti', 'sensit'],
  ['sensibiliti', 'sensibl'],
  // Step 3
  ['triplicate', 'triplic'],
  ['formative', 'form'],
  ['formalize', 'formal'],
  ['electriciti', 'electr'],
  ['electrical', 'electr'],
  ['hopeful', 'hope'],
  ['goodness', 'good'],
  // Step 4
  ['revival', 'reviv'],
  ['allowance', 'allow'],
  ['inference', 'infer'],
  ['airliner', 'airlin'],
  ['gyroscopic', 'gyroscop'],
  ['adjustable', 'adjust'],
  ['defensible', 'defens'],
  ['irritant', 'irrit'],
  ['replacement', 'replac'],
  ['adjustment', 'adjust'],
  ['dependent', 'depend'],
  ['adoption', 'adopt'],
  ['homologou', 'homolog'],
  ['communism', 'commun'],
  ['activate', 'activ'],
  ['angulariti', 'angular'],
  ['homologous', 'homolog'],
  ['effective', 'effect'],
  ['bowdlerize', 'bowdler'],
  // Step 5
  ['probate', 'probat'],
  ['rate', 'rate'],
  ['cease', 'ceas'],
  ['controll', 'control'],
  ['roll', 'roll'],
  // Whole-word examples from the paper and common usage
  ['generalizations', 'gener'],
  ['oscillators', 'oscil'],
  ['connect', 'connect'],
  ['connected', 'connect'],
  ['connecting', 'connect'],
  ['connection', 'connect'],
  ['connections', 'connect'],
  ['controlling', 'control'],
  ['rolling', 'roll'],
  ['running', 'run'],
  ['runs', 'run'],
  ['generously', 'gener'],
  ['abate', 'abat'],
  ['abated', 'abat'],
  ['abatement', 'abat'],
  ['abilities', 'abil'],
  ['ability', 'abil'],
  ['able', 'abl'],
  ['abandon', 'abandon'],
  ['abandoned', 'abandon'],
  ['abandonment', 'abandon'],
  ['knack', 'knack'],
  ['knightly', 'knightli'],
  ['skies', 'ski'],
  ['dying', 'dy'],
  ['lying', 'ly'],
  ['news', 'new'],
  ['agreement', 'agreement'],
  ['archaeology', 'archaeolog'],
  ['bliss', 'bliss'],
];

describe('porterStem', () => {
  it.each(PAIRS)('%s → %s', (word, stem) => {
    expect(porterStem(word)).toBe(stem);
  });

  it('leaves words of one or two letters unchanged', () => {
    for (const w of ['a', 'is', 'as', 'us', 'ed']) expect(porterStem(w)).toBe(w);
  });

  it('leaves non-ASCII-letter tokens unchanged', () => {
    for (const w of ['v1', 'mp3', '2024', 'straße', 'Running', 'naïve']) {
      expect(porterStem(w)).toBe(w);
    }
    expect(isStemmable('running')).toBe(true);
    expect(isStemmable('mp3')).toBe(false);
  });
});
