/**
 * Shannon entropy utilities for protecting high-entropy tokens (UUIDs, hashes, JWTs).
 *
 * Faithful port of src/token_goat/entropy.py. Pure, dependency-free, sync.
 *
 * Parity notes:
 *  - Math.log2 mirrors CPython's math.log2 (both are IEEE-754 double). V8 and
 *    CPython can differ in the last ULP due to summation order in the Shannon
 *    sum; the Python tests assert on thresholds (>= / <), not exact bits, so
 *    behavior parity holds. The golden-artifact parity layer (tests/parity/)
 *    will use an epsilon for any exact-float golden once it lands.
 *  - The regex character classes are copied verbatim from the Python source:
 *      _TOKEN_SPLIT_RE = /[\s=:]+/     (split on whitespace, '=', ':')
 *      _HAS_NONALPHA_RE = /[0-9\-_./+=@]/   (non-alphabetic marker)
 *  - Character counting iterates code points; all test inputs are ASCII so this
 *    matches Python's str iteration exactly.
 */

/** Minimum normalized Shannon entropy for a token to be "high". */
export const _ENTROPY_THRESHOLD = 0.85;

/** Minimum token length (in characters) to be considered. */
export const _ENTROPY_MIN_LEN = 8;

// Split on whitespace, '=', and ':' so "key=value" and "host:token" pairs are
// scored separately. Verbatim port of re.compile(r"[\s=:]+").
const _TOKEN_SPLIT_RE = /[\s=:]+/;

// Match tokens with non-alphabetic characters (digits, hyphens, underscores,
// etc.). Verbatim port of re.compile(r"[0-9\-_./+=@]").
const _HAS_NONALPHA_RE = /[0-9\-_./+=@]/;

/**
 * Return normalized Shannon entropy of token in [0.0, 1.0].
 *
 * H = -sum(p_i * log2(p_i)) / log2(len(charset))
 * where charset = set of unique characters in token.
 * Returns 0.0 for tokens with fewer than 2 unique characters.
 */
export function scoreEntropy(token: string): number {
  const charset = new Set<string>(token);
  if (charset.size < 2) {
    return 0.0;
  }
  const n = token.length;
  const counts = new Map<string, number>();
  for (const ch of token) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0.0;
  for (const cnt of counts.values()) {
    const p = cnt / n;
    entropy -= p * Math.log2(p);
  }
  return entropy / Math.log2(charset.size);
}

/**
 * Return true if any token in line has normalized entropy >= minEntropy, length
 * >= minLength, and contains non-alphabetic chars.
 *
 * Tokens are extracted by splitting on whitespace, '=', and ':' so that
 * key=value and host:token pairs are evaluated independently. A token is only
 * flagged if it has both high entropy AND contains at least one digit, hyphen,
 * underscore, or other special character — this filters out normal English
 * words.
 */
export function hasHighEntropyToken(
  line: string,
  minEntropy: number = _ENTROPY_THRESHOLD,
  minLength: number = _ENTROPY_MIN_LEN,
): boolean {
  for (const token of line.split(_TOKEN_SPLIT_RE)) {
    if (
      token.length >= minLength &&
      scoreEntropy(token) >= minEntropy &&
      _HAS_NONALPHA_RE.test(token)
    ) {
      return true;
    }
  }
  return false;
}
