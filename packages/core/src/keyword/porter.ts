// The Porter stemmer: M. F. Porter, "An algorithm for suffix stripping",
// Program 14(3), 1980. This follows Martin Porter's own reference
// implementation (the ANSI C version that produced the published vocabulary
// and output files, and that SQLite's `porter` tokenizer is modelled on),
// including its two documented departures from the paper: step 2 maps
// `-bli` → `-ble` (the paper has `-abli` → `-able`) and adds `-logi` → `-log`.
//
// Input must be lowercase ASCII letters; anything else is returned unchanged
// (see `isStemmable`). Words of one or two letters are returned unchanged.

const STEMMABLE = /^[a-z]+$/;

/** Whether `word` is a lowercase ASCII-letter word the stemmer applies to. */
export function isStemmable(word: string): boolean {
  return STEMMABLE.test(word);
}

/** Porter-stems a lowercase ASCII word. Other input is returned unchanged. */
export function porterStem(word: string): string {
  if (word.length <= 2 || !isStemmable(word)) return word;
  return new Stemmer(word).run();
}

class Stemmer {
  private b: string[];
  /** Index of the last letter of the current word. */
  private k: number;
  /** General offset into the word, set by `ends`. */
  private j = 0;

  constructor(word: string) {
    this.b = word.split('');
    this.k = word.length - 1;
  }

  run(): string {
    this.step1ab();
    if (this.k > 0) {
      this.step1c();
      this.step2();
      this.step3();
      this.step4();
      this.step5();
    }
    return this.b.slice(0, this.k + 1).join('');
  }

  /** Whether b[i] is a consonant. `y` is a consonant at the start or after a vowel. */
  private cons(i: number): boolean {
    switch (this.b[i]) {
      case 'a':
      case 'e':
      case 'i':
      case 'o':
      case 'u':
        return false;
      case 'y':
        return i === 0 ? true : !this.cons(i - 1);
      default:
        return true;
    }
  }

  /** The measure m of b[0..j]: the number of VC sequences in [C](VC)^m[V]. */
  private m(): number {
    let n = 0;
    let i = 0;
    const j = this.j;
    for (;;) {
      if (i > j) return n;
      if (!this.cons(i)) break;
      i++;
    }
    i++;
    for (;;) {
      for (;;) {
        if (i > j) return n;
        if (this.cons(i)) break;
        i++;
      }
      i++;
      n++;
      for (;;) {
        if (i > j) return n;
        if (!this.cons(i)) break;
        i++;
      }
      i++;
    }
  }

  /** Whether b[0..j] contains a vowel. */
  private vowelInStem(): boolean {
    for (let i = 0; i <= this.j; i++) if (!this.cons(i)) return true;
    return false;
  }

  /** Whether b[i-1..i] is a double consonant. */
  private doubleC(i: number): boolean {
    if (i < 1) return false;
    if (this.b[i] !== this.b[i - 1]) return false;
    return this.cons(i);
  }

  /** Whether b[i-2..i] is consonant-vowel-consonant, the last not w, x or y. */
  private cvc(i: number): boolean {
    if (i < 2 || !this.cons(i) || this.cons(i - 1) || !this.cons(i - 2)) return false;
    const ch = this.b[i];
    return ch !== 'w' && ch !== 'x' && ch !== 'y';
  }

  /** Whether b[0..k] ends with `s`; if so, sets j to the index before the suffix. */
  private ends(s: string): boolean {
    const len = s.length;
    if (len > this.k + 1) return false;
    for (let i = 0; i < len; i++) {
      if (this.b[this.k - len + 1 + i] !== s[i]) return false;
    }
    this.j = this.k - len;
    return true;
  }

  /** Replaces b[j+1..k] with `s` and adjusts k. */
  private setTo(s: string): void {
    this.b.length = this.j + 1;
    for (const ch of s) this.b.push(ch);
    this.k = this.j + s.length;
  }

  private r(s: string): void {
    if (this.m() > 0) this.setTo(s);
  }

  /** Plurals and -ed / -ing. */
  private step1ab(): void {
    if (this.b[this.k] === 's') {
      if (this.ends('sses')) this.k -= 2;
      else if (this.ends('ies')) this.setTo('i');
      else if (this.b[this.k - 1] !== 's') this.k--;
    }
    this.b.length = this.k + 1;
    if (this.ends('eed')) {
      if (this.m() > 0) this.k--;
    } else if ((this.ends('ed') || this.ends('ing')) && this.vowelInStem()) {
      this.k = this.j;
      this.b.length = this.k + 1;
      if (this.ends('at')) this.setTo('ate');
      else if (this.ends('bl')) this.setTo('ble');
      else if (this.ends('iz')) this.setTo('ize');
      else if (this.doubleC(this.k)) {
        this.k--;
        const ch = this.b[this.k];
        if (ch === 'l' || ch === 's' || ch === 'z') this.k++;
      } else {
        this.j = this.k;
        if (this.m() === 1 && this.cvc(this.k)) this.setTo('e');
      }
    }
    this.b.length = this.k + 1;
  }

  /** Terminal y → i when there is another vowel in the stem. */
  private step1c(): void {
    if (this.ends('y') && this.vowelInStem()) this.b[this.k] = 'i';
  }

  private replaceFirst(pairs: readonly (readonly [string, string])[], cond: () => boolean): void {
    for (const [suffix, replacement] of pairs) {
      if (this.ends(suffix)) {
        if (cond()) this.setTo(replacement);
        return;
      }
    }
  }

  /** Double suffixes to single ones, when m > 0. */
  private step2(): void {
    const table = STEP2[this.b[this.k - 1] ?? ''];
    if (table) this.replaceFirst(table, () => this.m() > 0);
  }

  /** -ic-, -full, -ness etc., when m > 0. */
  private step3(): void {
    const table = STEP3[this.b[this.k] ?? ''];
    if (table) this.replaceFirst(table, () => this.m() > 0);
  }

  /** Removes -ant, -ence etc., when m > 1. */
  private step4(): void {
    const table = STEP4[this.b[this.k - 1] ?? ''];
    if (!table) return;
    let found = false;
    for (const suffix of table) {
      if (this.ends(suffix)) {
        if (suffix === 'ion') {
          const ch = this.j >= 0 ? this.b[this.j] : undefined;
          if (ch !== 's' && ch !== 't') continue;
        }
        found = true;
        break;
      }
    }
    if (!found) return;
    if (this.m() > 1) {
      this.k = this.j;
      this.b.length = this.k + 1;
    }
  }

  /** Removes a final -e when m > 1 (or m = 1 and not *o), and -ll → -l when m > 1. */
  private step5(): void {
    this.j = this.k;
    if (this.b[this.k] === 'e') {
      const a = this.m();
      if (a > 1 || (a === 1 && !this.cvc(this.k - 1))) this.k--;
    }
    // As in the reference code, m() here still measures up to the original k.
    if (this.b[this.k] === 'l' && this.doubleC(this.k) && this.m() > 1) this.k--;
    this.b.length = this.k + 1;
  }
}

type Pairs = readonly (readonly [string, string])[];

// Keyed by the penultimate letter of the word, as in the reference code.
const STEP2: Readonly<Record<string, Pairs>> = {
  a: [
    ['ational', 'ate'],
    ['tional', 'tion'],
  ],
  c: [
    ['enci', 'ence'],
    ['anci', 'ance'],
  ],
  e: [['izer', 'ize']],
  l: [
    ['bli', 'ble'],
    ['alli', 'al'],
    ['entli', 'ent'],
    ['eli', 'e'],
    ['ousli', 'ous'],
  ],
  o: [
    ['ization', 'ize'],
    ['ation', 'ate'],
    ['ator', 'ate'],
  ],
  s: [
    ['alism', 'al'],
    ['iveness', 'ive'],
    ['fulness', 'ful'],
    ['ousness', 'ous'],
  ],
  t: [
    ['aliti', 'al'],
    ['iviti', 'ive'],
    ['biliti', 'ble'],
  ],
  g: [['logi', 'log']],
};

// Keyed by the last letter of the word.
const STEP3: Readonly<Record<string, Pairs>> = {
  e: [
    ['icate', 'ic'],
    ['ative', ''],
    ['alize', 'al'],
  ],
  i: [['iciti', 'ic']],
  l: [
    ['ical', 'ic'],
    ['ful', ''],
  ],
  s: [['ness', '']],
};

// Keyed by the penultimate letter of the word.
const STEP4: Readonly<Record<string, readonly string[]>> = {
  a: ['al'],
  c: ['ance', 'ence'],
  e: ['er'],
  i: ['ic'],
  l: ['able', 'ible'],
  n: ['ant', 'ement', 'ment', 'ent'],
  o: ['ion', 'ou'],
  s: ['ism'],
  t: ['ate', 'iti'],
  u: ['ous'],
  v: ['ive'],
  z: ['ize'],
};
