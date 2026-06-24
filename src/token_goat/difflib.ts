/**
 * Faithful port of the parts of CPython's `difflib` that token-goat uses for
 * "did you mean …?" close-match suggestions: `SequenceMatcher.ratio` (with the
 * `quick_ratio` / `real_quick_ratio` pre-filters and the autojunk heuristic) and
 * `get_close_matches`.
 *
 * difflib treats a `str` as a sequence of characters; Python iterates a `str` by
 * Unicode code point, so sequences here are code-point arrays (`Array.from(s)`),
 * not UTF-16 units — identifiers are ASCII in practice, but this keeps parity on
 * astral input. `hints.ts` carries its own restricted SequenceMatcher for
 * `unified_diff`; this module is the char-level matcher the symbol/section/file
 * suggestion paths share.
 */

/** Split a string into its Unicode code points (Python `list(str)`). */
function _codepoints(s: string): string[] {
  return Array.from(s);
}

/**
 * Port of `difflib.SequenceMatcher` restricted to ratio computation.
 *
 * `isjunk` is always null (token-goat never passes one). `autojunk` matches
 * CPython's default: in `set_seq2` / `_chainB`, when the second sequence has
 * ≥ 200 elements, elements occurring in more than `len(b)//100 + 1` positions
 * are treated as popular and dropped from the index (the autojunk heuristic).
 */
export class SequenceMatcher {
  private a: string[] = [];
  private b: string[] = [];
  private b2j: Map<string, number[]> = new Map();
  private fullbcount: Map<string, number> | null = null;
  private readonly autojunk: boolean;

  constructor(a = "", b = "", autojunk = true) {
    this.autojunk = autojunk;
    this.set_seqs(a, b);
  }

  set_seqs(a: string, b: string): void {
    this.set_seq1(a);
    this.set_seq2(b);
  }

  set_seq1(a: string): void {
    this.a = _codepoints(a);
  }

  set_seq2(b: string): void {
    this.b = _codepoints(b);
    this.fullbcount = null;
    this._chainB();
  }

  private _chainB(): void {
    const b = this.b;
    const b2j = this.b2j;
    b2j.clear();
    for (let i = 0; i < b.length; i++) {
      const elt = b[i]!;
      const indices = b2j.get(elt);
      if (indices !== undefined) indices.push(i);
      else b2j.set(elt, [i]);
    }
    // Autojunk: purge popular (non-junk) elements when b is large.
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      const popular: string[] = [];
      for (const [elt, idxs] of b2j) {
        if (idxs.length > ntest) popular.push(elt);
      }
      for (const elt of popular) b2j.delete(elt);
    }
  }

  /** Port of `find_longest_match` (no junk). Returns [i, j, size]. */
  private _findLongestMatch(
    alo: number,
    ahi: number,
    blo: number,
    bhi: number,
  ): [number, number, number] {
    const a = this.a;
    const b = this.b;
    const b2j = this.b2j;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len: Map<number, number> = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len: Map<number, number> = new Map();
      const indices = b2j.get(a[i]!);
      if (indices !== undefined) {
        for (const j of indices) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    // Extend the best match by non-junk elements on each end (junk set empty).
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize += 1;
    }
    return [besti, bestj, bestsize];
  }

  /** Port of `get_matching_blocks`. Returns [i, j, size] triples (incl. the final (la, lb, 0)). */
  get_matching_blocks(): Array<[number, number, number]> {
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const matchingBlocks: Array<[number, number, number]> = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this._findLongestMatch(alo, ahi, blo, bhi);
      if (k > 0) {
        matchingBlocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    matchingBlocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    // Collapse adjacent equal blocks (difflib's non_adjacent merge).
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Array<[number, number, number]> = [];
    for (const [i2, j2, k2] of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) nonAdjacent.push([i1, j1, k1]);
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) nonAdjacent.push([i1, j1, k1]);
    nonAdjacent.push([la, lb, 0]);
    return nonAdjacent;
  }

  /** Port of `ratio` — 2.0 * M / T where M is total match size, T is len(a)+len(b). */
  ratio(): number {
    let matches = 0;
    for (const [, , size] of this.get_matching_blocks()) matches += size;
    return _calculateRatio(matches, this.a.length + this.b.length);
  }

  /** Port of `quick_ratio` — an upper bound on ratio computed from char counts. */
  quick_ratio(): number {
    if (this.fullbcount === null) {
      const fullbcount = new Map<string, number>();
      for (const elt of this.b) fullbcount.set(elt, (fullbcount.get(elt) ?? 0) + 1);
      this.fullbcount = fullbcount;
    }
    const fullbcount = this.fullbcount;
    const avail = new Map<string, number>();
    let matches = 0;
    for (const elt of this.a) {
      const numb = avail.has(elt) ? avail.get(elt)! : (fullbcount.get(elt) ?? 0);
      avail.set(elt, numb - 1);
      if (numb > 0) matches += 1;
    }
    return _calculateRatio(matches, this.a.length + this.b.length);
  }

  /** Port of `real_quick_ratio` — an upper bound from the sequence lengths. */
  real_quick_ratio(): number {
    const la = this.a.length;
    const lb = this.b.length;
    return _calculateRatio(Math.min(la, lb), la + lb);
  }
}

/** Port of `difflib._calculate_ratio`. */
function _calculateRatio(matches: number, length: number): number {
  if (length) return (2.0 * matches) / length;
  return 1.0;
}

/** Code-point lexicographic comparison (Python str ordering). */
function _cmpCodepoints(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const ca = ai[i]!.codePointAt(0)!;
    const cb = bi[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return ai.length === bi.length ? 0 : ai.length < bi.length ? -1 : 1;
}

/**
 * Port of `difflib.get_close_matches(word, possibilities, n=3, cutoff=0.6)`.
 *
 * Returns the best `n` matches (ratio ≥ `cutoff`) ordered by descending
 * `(ratio, possibility)` — CPython uses `heapq.nlargest(n, [(ratio, x), …])`
 * with no key, so ties in ratio break by the possibility string descending.
 */
export function get_close_matches(
  word: string,
  possibilities: Iterable<string>,
  n = 3,
  cutoff = 0.6,
): string[] {
  if (!(n > 0)) throw new Error(`n must be > 0: ${n}`);
  if (!(cutoff >= 0.0 && cutoff <= 1.0)) throw new Error(`cutoff must be in [0.0, 1.0]: ${cutoff}`);
  const result: Array<[number, string]> = [];
  const s = new SequenceMatcher();
  s.set_seq2(word);
  for (const x of possibilities) {
    s.set_seq1(x);
    if (s.real_quick_ratio() >= cutoff && s.quick_ratio() >= cutoff && s.ratio() >= cutoff) {
      result.push([s.ratio(), x]);
    }
  }
  // heapq.nlargest(n, result) with no key: full-tuple compare (ratio, then x).
  result.sort((A, B) => (B[0] !== A[0] ? B[0] - A[0] : _cmpCodepoints(B[1], A[1])));
  return result.slice(0, n).map(([, x]) => x);
}
