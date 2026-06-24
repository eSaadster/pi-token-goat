/**
 * Tests for hints.dedup_hints() — content-hash deduplication of hints.
 *
 * 1:1 port of tests/test_hint_content_dedup.py.
 *
 * Mapping notes (Python → TS):
 *  - session.SessionCache(session_id=, started_ts=, last_activity_ts=)
 *      → new session.SessionCache({ session_id, started_ts, last_activity_ts }).
 *  - HintItem(text, priority) → new HintItem(text, priority) (positional, same
 *    arg order as the Python dataclass).
 *  - `"x" in hint.text` (HintItem) → hint.text.includes("x"). HintItem carries a
 *    plain `text: string` (it is NOT a ReadHint), so we assert on `.text`
 *    directly, matching the Python `result[0].text` accesses.
 *  - cache.hints_content_dedup is a dict[str, (summary, count)] in Python; in TS
 *    it is Record<string, [string, number]>. `list(d.items())[0]` → the first
 *    [key, [summary, count]] pair of Object.entries(...).
 *  - `result == hints` (list identity-by-value in Python) → assert the returned
 *    array is the SAME reference the impl returns it unchanged (dedup_hints
 *    returns the input array when session_cache is null) and otherwise compare
 *    element-wise.
 *  - session.HINTS_CONTENT_DEDUP_MAX is the FIFO cap constant.
 *
 * No deferred modules (cli/read_commands/hooks_read/parser/bash_parser) are
 * imported by this suite, so nothing is skipped.
 */
import { describe, expect, it } from "vitest";

import * as session from "../src/token_goat/session.js";
import {
  HINT_PRIORITY_HIGH,
  HINT_PRIORITY_LOW,
  HINT_PRIORITY_MEDIUM,
  HintItem,
  dedup_hints,
} from "../src/token_goat/hints.js";

// ---------------------------------------------------------------------------
// Shared helper: build a fresh SessionCache mirroring the Python fixtures
//   session.SessionCache(session_id="test", started_ts=0.0, last_activity_ts=0.0)
// ---------------------------------------------------------------------------
function makeCache(): session.SessionCache {
  return new session.SessionCache({
    session_id: "test",
    started_ts: 0.0,
    last_activity_ts: 0.0,
  });
}

/** First [summary, count] tuple of cache.hints_content_dedup (Python list(...items())[0]). */
function firstDedupEntry(
  cache: session.SessionCache,
): [string, number] {
  const entries = Object.entries(cache.hints_content_dedup);
  const first = entries[0];
  expect(first).toBeDefined();
  return first![1];
}

describe("TestDedupHints", () => {
  it("test_no_session_cache_returns_unchanged", () => {
    // When session_cache is None, hints are returned unchanged.
    const hints = [
      new HintItem("First hint", HINT_PRIORITY_HIGH),
      new HintItem("Second hint", HINT_PRIORITY_MEDIUM),
    ];
    const result = dedup_hints(hints, null);
    expect(result).toBe(hints);
  });

  it("test_first_occurrence_recorded", () => {
    // First occurrence of a hint records its content hash in the session.
    const cache = makeCache();
    const hint_text = "This is a unique hint text";
    const hints = [new HintItem(hint_text, HINT_PRIORITY_HIGH)];

    const result = dedup_hints(hints, cache);

    // Hint should be unchanged (first occurrence).
    expect(result.length).toBe(1);
    expect(result[0]!.text).toBe(hint_text);
    // Content hash should be recorded in the cache.
    expect(Object.keys(cache.hints_content_dedup).length).toBe(1);
  });

  it("test_duplicate_content_compressed", () => {
    // Identical hint content on second call is compressed to a short stub.
    const cache = makeCache();
    const hint_text = "Repeated hint text";
    const hints1 = [new HintItem(hint_text, HINT_PRIORITY_HIGH)];

    // First call: hint recorded.
    const result1 = dedup_hints(hints1, cache);
    expect(result1[0]!.text).toBe(hint_text);

    // Second call with same text: should be compressed.
    const hints2 = [new HintItem(hint_text, HINT_PRIORITY_HIGH)];
    const result2 = dedup_hints(hints2, cache);

    expect(result2.length).toBe(1);
    // Text should be compressed to short stub.
    expect(result2[0]!.text.includes("Same as previously shown hint for")).toBe(true);
    expect(
      result2[0]!.text.includes(hint_text.replace(/\n/g, " ").slice(0, 50)) ||
        result2[0]!.text.includes("..."),
    ).toBe(true);
  });

  it("test_different_content_not_deduped", () => {
    // Different hint texts are not confused with each other.
    const cache = makeCache();
    const hint1 = new HintItem("First unique hint", HINT_PRIORITY_HIGH);
    const hint2 = new HintItem("Second unique hint", HINT_PRIORITY_MEDIUM);

    const result = dedup_hints([hint1, hint2], cache);

    // Both should be unchanged.
    expect(result.length).toBe(2);
    expect(result[0]!.text).toBe("First unique hint");
    expect(result[1]!.text).toBe("Second unique hint");
    // Both content hashes should be recorded.
    expect(Object.keys(cache.hints_content_dedup).length).toBe(2);
  });

  it("test_normalization_handles_whitespace", () => {
    // Hints differing only in whitespace are treated as duplicates.
    const cache = makeCache();
    // Same content, different formatting.
    const hint_text_1 = "The hint text";
    const hint_text_2 = "  The hint text  "; // Extra whitespace

    const result1 = dedup_hints([new HintItem(hint_text_1, HINT_PRIORITY_HIGH)], cache);
    expect(result1[0]!.text).toBe(hint_text_1);

    const result2 = dedup_hints([new HintItem(hint_text_2, HINT_PRIORITY_MEDIUM)], cache);
    // Whitespace-normalized match should trigger dedup.
    expect(result2[0]!.text.includes("Same as previously shown hint for")).toBe(true);
  });

  it("test_case_insensitive_dedup", () => {
    // Hints differing only in case are treated as duplicates.
    const cache = makeCache();
    const hint_lower = "read lines 1–50 from file.py";
    const hint_upper = "READ LINES 1–50 FROM FILE.PY";

    const result1 = dedup_hints([new HintItem(hint_lower, HINT_PRIORITY_HIGH)], cache);
    expect(result1[0]!.text).toBe(hint_lower);

    const result2 = dedup_hints([new HintItem(hint_upper, HINT_PRIORITY_MEDIUM)], cache);
    // Case-normalized match should trigger dedup.
    expect(result2[0]!.text.includes("Same as previously shown hint for")).toBe(true);
  });

  it("test_priority_preserved_after_dedup", () => {
    // Deduped hints retain their original priority.
    const cache = makeCache();
    const hint_text = "Same hint with different priority";

    const result1 = dedup_hints([new HintItem(hint_text, HINT_PRIORITY_HIGH)], cache);
    expect(result1[0]!.hint_priority).toBe(HINT_PRIORITY_HIGH);

    const result2 = dedup_hints([new HintItem(hint_text, HINT_PRIORITY_LOW)], cache);
    // Second occurrence with LOW priority should preserve the LOW priority.
    expect(result2[0]!.hint_priority).toBe(HINT_PRIORITY_LOW);
  });

  it("test_empty_hints_list", () => {
    // Empty hint list returns empty list.
    const cache = makeCache();
    const result = dedup_hints([], cache);
    expect(result).toEqual([]);
  });

  it("test_summary_text_generation", () => {
    // Summary text is first ~50 chars of the original hint.
    const cache = makeCache();
    const long_hint =
      "This is a very long hint text that exceeds fifty characters and should be truncated";

    dedup_hints([new HintItem(long_hint, HINT_PRIORITY_HIGH)], cache);

    // Extract the summary from the cached entry.
    expect(Object.keys(cache.hints_content_dedup).length).toBe(1);
    const [summary] = firstDedupEntry(cache);
    expect(summary.length).toBeLessThanOrEqual(50);
    expect(summary.startsWith("This is a very long hint text")).toBe(true);
  });

  it("test_multiline_hint_handling", () => {
    // Newlines in hint text are replaced with spaces in summary.
    const cache = makeCache();
    const multiline_hint = "First line\nSecond line\nThird line";

    dedup_hints([new HintItem(multiline_hint, HINT_PRIORITY_HIGH)], cache);

    // Summary should have newlines replaced with spaces.
    const [summary] = firstDedupEntry(cache);
    expect(summary.includes("\n")).toBe(false);
    expect(summary.includes("First line Second line")).toBe(true);
  });

  it("test_content_dedup_count_incremented", () => {
    // Count for repeated content is incremented.
    const cache = makeCache();
    const hint_text = "Repeated content";

    // First occurrence.
    dedup_hints([new HintItem(hint_text, HINT_PRIORITY_HIGH)], cache);
    const [, count1] = firstDedupEntry(cache);
    expect(count1).toBe(1);

    // Second occurrence.
    dedup_hints([new HintItem(hint_text, HINT_PRIORITY_HIGH)], cache);
    const [, count2] = firstDedupEntry(cache);
    expect(count2).toBe(2);
  });

  it("test_fifo_eviction_on_cap_exceeded", () => {
    // When hints_content_dedup exceeds cap, oldest entries are evicted.
    const cache = makeCache();
    // Add hints up to the cap + 1 to trigger eviction.
    const cap = session.HINTS_CONTENT_DEDUP_MAX;
    const hints: HintItem[] = [];
    for (let i = 0; i < cap + 1; i++) {
      hints.push(new HintItem(`Hint ${i}`, HINT_PRIORITY_HIGH));
    }

    dedup_hints(hints, cache);

    // Cache should not exceed the cap.
    expect(Object.keys(cache.hints_content_dedup).length).toBeLessThanOrEqual(cap);
    // The first hint should be evicted (FIFO).
    const containsHint0 = Object.values(cache.hints_content_dedup).some((v) =>
      String(v).includes("Hint 0"),
    );
    expect(containsHint0).toBe(false);
  });

  it("test_multiple_hints_deduped_independently", () => {
    // Multiple hints in one call are deduped independently.
    const cache = makeCache();
    const hints1 = [
      new HintItem("Unique hint A", HINT_PRIORITY_HIGH),
      new HintItem("Unique hint B", HINT_PRIORITY_MEDIUM),
    ];
    dedup_hints(hints1, cache);

    // Second call with one repeat and one new.
    const hints2 = [
      new HintItem("Unique hint A", HINT_PRIORITY_LOW), // Repeat
      new HintItem("Unique hint C", HINT_PRIORITY_HIGH), // New
    ];
    const result = dedup_hints(hints2, cache);

    expect(result.length).toBe(2);
    // First should be deduped (stub).
    expect(result[0]!.text.includes("Same as previously shown hint for")).toBe(true);
    // Second should be original (new).
    expect(result[1]!.text).toBe("Unique hint C");
  });
});
