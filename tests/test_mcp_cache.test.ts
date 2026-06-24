/**
 * Unit tests for token_goat/mcp_cache. 1:1 port of tests/test_mcp_cache.py.
 *
 * Covers (the mcp_cache-owned subset):
 *  - is_mcp_read_only classification (read-only vs mutable verbs)
 *  - mcp_hash stability across dict insertion order
 *  - store_mcp_result / load_mcp_result round-trip
 *
 * Test-seam mapping (Python → TS):
 *  - patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path)
 *      → no explicit patch needed. _mcp_outputs_dir() routes through
 *        cache_common.get_cache_dir("mcp_outputs"), which resolves under
 *        paths.dataDir(); setup.ts's setDataDirOverride gives each test its own
 *        throwaway data dir, so store_mcp_result and load_mcp_result both read
 *        the same isolated mcp_outputs dir and the round-trip is reproduced
 *        exactly. (The Python patch only existed to redirect the on-disk store;
 *        the data-dir override is the TS analogue.)
 *  - tmp_path fixture → unused; the per-test data dir override supplies isolation.
 *
 * Deliberately skipped (depend on not-yet-ported modules):
 *  - TestSessionMcpMethods — imports token_goat.session (SessionCache,
 *    MCP_RESULT_HASHES_MAX). session.py is not ported yet.
 *  - TestHandleMcpDedup — imports token_goat.hooks_fetch (_handle_mcp_dedup,
 *    _MCP_INLINE_THRESHOLD) and token_goat.session.safe_load. hooks_fetch.py is
 *    not ported yet.
 *  Each is written as it.skip with a one-line PORT note and counted in
 *  tests_skipped.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity.
 */
import { describe, expect, it } from "vitest";

import {
  MCP_MAX_CACHE_BYTES,
  is_mcp_read_only,
  load_mcp_result,
  mcp_hash,
  store_mcp_result,
} from "../src/token_goat/mcp_cache.js";

// ---------------------------------------------------------------------------
// is_mcp_read_only classification
// ---------------------------------------------------------------------------

describe("TestIsMcpReadOnly", () => {
  it("test_list_files_is_read_only", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__list_issues")).toBe(true);
  });

  it("test_get_file_is_read_only", () => {
    expect(is_mcp_read_only("mcp__claude_ai_Google_Drive__get_file_metadata")).toBe(true);
  });

  it("test_search_is_read_only", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__search_repositories")).toBe(true);
  });

  it("test_create_is_mutable", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__create_issue")).toBe(false);
  });

  it("test_delete_is_mutable", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__delete_file")).toBe(false);
  });

  it("test_push_is_mutable", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__push_files")).toBe(false);
  });

  it("test_update_is_mutable", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__update_pull_request")).toBe(false);
  });

  it("test_non_mcp_tool_is_false", () => {
    expect(is_mcp_read_only("Read")).toBe(false);
    expect(is_mcp_read_only("Bash")).toBe(false);
    expect(is_mcp_read_only("WebFetch")).toBe(false);
  });

  it("test_mcp_without_mutable_verb_is_read_only", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__get_commit")).toBe(true);
  });

  it("test_label_message_is_mutable", () => {
    // label verb is in the blocklist
    expect(is_mcp_read_only("mcp__claude_ai_Gmail_GG__label_message")).toBe(false);
  });

  it("test_list_labels_is_read_only", () => {
    // list is not in the blocklist
    expect(is_mcp_read_only("mcp__claude_ai_Gmail_GG__list_labels")).toBe(true);
  });

  it("test_add_comment_is_mutable", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__add_issue_comment")).toBe(false);
  });

  it("test_merge_pull_request_is_mutable", () => {
    expect(is_mcp_read_only("mcp__plugin_github_github__merge_pull_request")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcp_hash stability
// ---------------------------------------------------------------------------

describe("TestMcpHash", () => {
  it("test_same_input_same_hash", () => {
    const h1 = mcp_hash("mcp__github__list_issues", { owner: "foo", repo: "bar" });
    const h2 = mcp_hash("mcp__github__list_issues", { owner: "foo", repo: "bar" });
    expect(h1).toBe(h2);
  });

  it("test_insertion_order_invariant", () => {
    // Dict built in different orders → same hash
    const h1 = mcp_hash("tool", { a: 1, b: 2 });
    const h2 = mcp_hash("tool", { b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it("test_different_tool_different_hash", () => {
    const h1 = mcp_hash("mcp__github__list_issues", { owner: "foo" });
    const h2 = mcp_hash("mcp__github__search_issues", { owner: "foo" });
    expect(h1).not.toBe(h2);
  });

  it("test_different_input_different_hash", () => {
    const h1 = mcp_hash("tool", { repo: "a" });
    const h2 = mcp_hash("tool", { repo: "b" });
    expect(h1).not.toBe(h2);
  });

  it("test_returns_16_hex_chars", () => {
    const h = mcp_hash("tool", {});
    expect(h.length).toBe(16);
    expect([...h].every((c) => "0123456789abcdef".includes(c))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// store_mcp_result / load_mcp_result round-trip
// ---------------------------------------------------------------------------

describe("TestMcpResultStorage", () => {
  it("test_store_and_load_roundtrip", () => {
    const result_text = '{"issues": [{"id": 1, "title": "bug"}]}';
    // Python patched get_cache_dir→tmp_path; setup.ts's per-test data-dir
    // override supplies the same isolation (store + load share the dir).
    const output_id = store_mcp_result("sess-1", "abc123", result_text, 1000.0);
    expect(output_id).not.toBeNull();
    const loaded = load_mcp_result(output_id!);
    expect(loaded).toBe(result_text);
  });

  it("test_oversized_result_returns_none", () => {
    const big = "x".repeat(MCP_MAX_CACHE_BYTES + 1);
    const result = store_mcp_result("sess-1", "hash1", big);
    expect(result).toBeNull();
  });

  it("test_missing_output_id_returns_none", () => {
    const result = load_mcp_result("nonexistent-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SessionCache.lookup_mcp_output_id / record_mcp_result
// ---------------------------------------------------------------------------

describe("TestSessionMcpMethods", () => {
  // PORT: deferred to Layer 3 (depends on token_goat.session — not yet ported)
  it.skip("test_lookup_unknown_hash_returns_none", () => {});
  // PORT: deferred to Layer 3 (depends on token_goat.session — not yet ported)
  it.skip("test_record_then_lookup", () => {});
  // PORT: deferred to Layer 3 (depends on token_goat.session — not yet ported)
  it.skip("test_fifo_eviction_at_cap", () => {});
  // PORT: deferred to Layer 3 (depends on token_goat.session — not yet ported)
  it.skip("test_serialization_roundtrip", () => {});
  // PORT: deferred to Layer 3 (depends on token_goat.session — not yet ported)
  it.skip("test_from_dict_missing_field_defaults_empty", () => {});
});

// ---------------------------------------------------------------------------
// _handle_mcp_dedup hint selection
// ---------------------------------------------------------------------------

describe("TestHandleMcpDedup", () => {
  // PORT: deferred to Layer 4 (depends on token_goat.hooks_fetch — not yet ported)
  it.skip("test_no_cached_result_returns_none", () => {});
  // PORT: deferred to Layer 4 (depends on token_goat.hooks_fetch — not yet ported)
  it.skip("test_inline_small_result", () => {});
  // PORT: deferred to Layer 4 (depends on token_goat.hooks_fetch — not yet ported)
  it.skip("test_pointer_hint_for_large_result", () => {});
  // PORT: deferred to Layer 4 (depends on token_goat.hooks_fetch — not yet ported)
  it.skip("test_missing_blob_returns_none", () => {});
});
