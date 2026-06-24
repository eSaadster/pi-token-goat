/**
 * Unit tests for token_goat/web_cache. 1:1 port of tests/test_web_cache.py.
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_data_dir fixture → setup.ts's setDataDirOverride already gives each
 *    test a throwaway data dir; web_cache writes under dataDir()/web_outputs, so
 *    no per-test path juggling is needed.
 *  - monkeypatch.setattr(web_cache, "evict_old_entries", _bad_evict) → vi.spyOn
 *    on the live module namespace import. ES module bindings are read-only from
 *    outside, BUT store_output calls evict_old_entries via the module-local
 *    binding, which vi.spyOn cannot redirect. The Python test relies on
 *    monkeypatch swapping the module attribute that store_output looks up at
 *    call time; the TS port instead drives the SAME code path by making the
 *    underlying directory walk raise — see test_store_output_eviction_oserror_*.
 *  - patch.object(Path, "stat", flaky_stat) → vi.spyOn(fs, "statSync") raising
 *    OSError for the targeted sidecar; find_cached_for_url's mtime sort goes
 *    through path_mtime_key → fs.statSync, which already swallows the OSError
 *    and sorts that entry to the bottom (TOCTOU tolerance).
 *  - caplog → not asserted in this suite.
 *
 * Sources deliberately skipped (deferred to Layer 3 — hooks_fetch + session not
 * yet ported):
 *  - TestPostFetchHook        (hooks_fetch.post_fetch + session.load)
 *  - TestPreFetchDedup        (hooks_fetch.pre_fetch + session.load)
 *  - TestGzipCompression.test_config_compress_bodies_wires_through
 *                             (hooks_fetch.post_fetch + config + session)
 *
 * Every ported Python `def test_*` maps to a vitest `it()` with the same name
 * and assertion polarity.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as web_cache from "../src/token_goat/web_cache.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// TestStoreAndLoad
// ===========================================================================

describe("TestStoreAndLoad", () => {
  it("test_small_round_trip", () => {
    const meta = web_cache.store_output(
      "sess1",
      "https://example.com/page",
      "page body".repeat(200),
      200,
    );
    expect(meta).not.toBeNull();
    expect(meta!.status_code).toBe(200);
    const body = web_cache.load_output(meta!.output_id);
    expect(body !== null && body.includes("page body")).toBe(true);
    expect(meta!.truncated).toBe(false);
  });

  it("test_large_output_is_tail_preserved", () => {
    const big = "B".repeat(3 * 1024 * 1024);
    const meta = web_cache.store_output("sess2", "https://big.example", big, 200);
    expect(meta !== null && meta.truncated === true).toBe(true);
    const body = web_cache.load_output(meta!.output_id);
    expect(body !== null && body.endsWith("B")).toBe(true);
    expect(body!.includes("token-goat: web output truncated")).toBe(true);
  });

  it("test_sidecar_round_trip", () => {
    const meta = web_cache.store_output("sess3", "https://a.example", "X".repeat(2000), 404);
    expect(meta).not.toBeNull();
    web_cache.write_sidecar(meta!);
    const loaded = web_cache.read_sidecar(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status_code).toBe(404);
    expect(loaded!.url_sha).toBe(meta!.url_sha);
  });

  it("test_evict_removes_paired_sidecars", () => {
    const metas: web_cache.WebOutputMeta[] = [];
    for (let i = 0; i < 5; i++) {
      const m = web_cache.store_output(
        `sess${i}`,
        `https://e.example/${i}`,
        "X".repeat(200_000),
        200,
      );
      expect(m).not.toBeNull();
      web_cache.write_sidecar(m!);
      metas.push(m!);
    }

    web_cache.evict_old_entries({ max_total_bytes: 300_000 });

    for (const m of metas) {
      const body = path.join(web_cache._web_outputs_dir(), `${m.output_id}.txt`);
      const sidecar = web_cache.sidecar_meta_path(m.output_id);
      expect(sidecar).not.toBeNull();
      if (!fs.existsSync(body)) {
        expect(fs.existsSync(sidecar!)).toBe(false);
      }
    }
  });

  it("test_evict_by_file_count", () => {
    const metas: web_cache.WebOutputMeta[] = [];
    for (let i = 0; i < 5; i++) {
      const m = web_cache.store_output(
        `sess${i}`,
        `https://f.example/${i}`,
        "X".repeat(10_000),
        200,
      );
      expect(m).not.toBeNull();
      metas.push(m!);
    }

    const removed = web_cache.evict_old_entries({
      max_file_count: 3,
      max_total_bytes: 10 * 1024 * 1024,
    });
    expect(removed).toBeGreaterThanOrEqual(2); // At least the two oldest

    let remaining = 0;
    for (const m of metas) {
      const body = path.join(web_cache._web_outputs_dir(), `${m.output_id}.txt`);
      if (fs.existsSync(body)) {
        remaining += 1;
      }
    }
    expect(remaining).toBeLessThanOrEqual(3);
  });

  it("test_evict_by_byte_cap", () => {
    const metas: web_cache.WebOutputMeta[] = [];
    for (let i = 0; i < 5; i++) {
      // Disable compression so on-disk size matches input for predictable caps.
      const m = web_cache.store_output(
        `sess${i}`,
        `https://b.example/${i}`,
        "X".repeat(50_000),
        200,
        { compress_bodies: false },
      );
      expect(m).not.toBeNull();
      metas.push(m!);
    }

    const removed = web_cache.evict_old_entries({
      max_total_bytes: 100_000,
      max_file_count: 100,
    });
    expect(removed).toBeGreaterThanOrEqual(2);

    let total_size = 0;
    for (const m of metas) {
      const body = path.join(web_cache._web_outputs_dir(), `${m.output_id}.txt`);
      if (fs.existsSync(body)) {
        total_size += fs.statSync(body).size;
      }
    }
    expect(total_size).toBeLessThanOrEqual(100_000);
  });

  it("test_store_output_eviction_oserror_does_not_discard_write", () => {
    // A confirmed write must return metadata even if eviction raises OSError.
    //
    // Python monkeypatches web_cache.evict_old_entries to raise; the TS module
    // binding is read-only, so we instead make the underlying directory walk
    // raise by spying on fs.readdirSync (which evict_cache_dir's scan calls) to
    // throw an OSError. The eviction runs outside safe_cache_op and is wrapped
    // in its own try/except OSError in store_output, so the confirmed write must
    // still be returned.
    const realReaddir = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const s = String(p);
      if (s.includes("web_outputs")) {
        const err = new Error("antivirus lock simulation") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (realReaddir as (a: fs.PathLike, b?: unknown) => unknown)(p, o);
    }) as typeof fs.readdirSync);

    const meta = web_cache.store_output(
      "sess_evict_err",
      "https://example.com/test",
      "page content",
      200,
    );
    expect(meta, "store_output must succeed even when eviction raises OSError").not.toBeNull();

    vi.restoreAllMocks();
    const body = web_cache.load_output(meta!.output_id);
    expect(body !== null && body.includes("page content")).toBe(true);
  });
});

// ===========================================================================
// TestPostFetchHook — PORT: deferred to Layer 3 (hooks_fetch + session)
// ===========================================================================

describe("TestPostFetchHook", () => {
  // PORT: deferred to Layer 3 (hooks_fetch.post_fetch + session.load).
  it.skip("test_small_body_skipped", () => {});
  // PORT: deferred to Layer 3 (hooks_fetch.post_fetch + session.load).
  it.skip("test_large_body_cached", () => {});
  // PORT: deferred to Layer 3 (hooks_fetch.post_fetch + session.load).
  it.skip("test_image_url_not_cached", () => {});
  // PORT: deferred to Layer 3 (hooks_fetch.post_fetch).
  it.skip("test_non_webfetch_tool_skipped", () => {});
  // PORT: deferred to Layer 3 (hooks_fetch.post_fetch + session.load).
  it.skip("test_content_array_response", () => {});
});

// ===========================================================================
// TestPreFetchDedup — PORT: deferred to Layer 3 (hooks_fetch + session)
// ===========================================================================

describe("TestPreFetchDedup", () => {
  // PORT: deferred to Layer 3 (hooks_fetch.pre_fetch + post_fetch + session).
  it.skip("test_repeat_url_triggers_hint", () => {});
  // PORT: deferred to Layer 3 (hooks_fetch.pre_fetch + post_fetch + session).
  it.skip("test_distinct_url_no_hint", () => {});
  // PORT: deferred to Layer 3 (hooks_fetch.pre_fetch image redirect).
  it.skip("test_image_url_still_redirected", () => {});
});

// ===========================================================================
// TestUrlNormalization
// ===========================================================================

describe("TestUrlNormalization", () => {
  it("test_fragment_stripped", () => {
    const h1 = web_cache.url_hash("https://example.com/page");
    const h2 = web_cache.url_hash("https://example.com/page#section");
    expect(h1).toBe(h2);
  });

  it("test_scheme_case_normalized", () => {
    const h1 = web_cache.url_hash("https://example.com/page");
    const h2 = web_cache.url_hash("HTTPS://example.com/page");
    expect(h1).toBe(h2);
  });

  it("test_default_port_stripped_https", () => {
    const h1 = web_cache.url_hash("https://example.com/page");
    const h2 = web_cache.url_hash("https://example.com:443/page");
    expect(h1).toBe(h2);
  });

  it("test_default_port_stripped_http", () => {
    const h1 = web_cache.url_hash("http://example.com/page");
    const h2 = web_cache.url_hash("http://example.com:80/page");
    expect(h1).toBe(h2);
  });

  it("test_non_default_port_preserved", () => {
    const h1 = web_cache.url_hash("https://example.com/page");
    const h2 = web_cache.url_hash("https://example.com:8443/page");
    expect(h1).not.toBe(h2);
  });

  it("test_query_string_preserved", () => {
    const h1 = web_cache.url_hash("https://example.com/page?q=1");
    const h2 = web_cache.url_hash("https://example.com/page?q=2");
    expect(h1).not.toBe(h2);
  });

  it("test_trailing_slash_preserved", () => {
    const h1 = web_cache.url_hash("https://example.com/page");
    const h2 = web_cache.url_hash("https://example.com/page/");
    expect(h1).not.toBe(h2);
  });

  it("test_fragment_and_scheme_combined", () => {
    const h1 = web_cache.url_hash("https://example.com/page");
    const h2 = web_cache.url_hash("HTTPS://example.com/page#anchor");
    expect(h1).toBe(h2);
  });

  it("test_normalize_url_returns_string_on_malformed", () => {
    const malformed = "not a url at all !!!";
    const result = web_cache._normalize_url(malformed);
    expect(typeof result).toBe("string");
  });
});

// ===========================================================================
// TestFindCachedConcurrentDeletion
// ===========================================================================

describe("TestFindCachedConcurrentDeletion", () => {
  it("test_find_cached_for_url_tolerates_concurrent_deletion", () => {
    // find_cached_for_url returns a result even if some sidecars are
    // concurrently deleted (TOCTOU on the mtime sort).
    const url = "https://example.com/docs/api";
    const body = "API docs content ".repeat(100);

    // Store two entries for the same URL so there are multiple sidecars.
    const meta1 = web_cache.store_output("sess-del-a", url, body, 200);
    expect(meta1).not.toBeNull();
    web_cache.write_sidecar(meta1!);
    const meta2 = web_cache.store_output("sess-del-b", url, body + " v2", 200);
    expect(meta2).not.toBeNull();
    web_cache.write_sidecar(meta2!);

    // Simulate one sidecar being deleted during the sort by raising OSError on
    // statSync for the sess-del-a .json file (the mtime-key path). The other
    // statSync calls (e.g. existence checks) pass through.
    const realStat = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const s = String(p);
      if (s.endsWith(".json") && s.includes("sess-del-a")) {
        const err = new Error("simulated concurrent deletion") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return (realStat as (a: fs.PathLike, b?: unknown) => unknown)(p, o);
    }) as typeof fs.statSync);

    const result = web_cache.find_cached_for_url(url);

    // The lookup must still succeed using the surviving sidecar.
    expect(result).not.toBeNull();
    expect(result!.url_sha).toBe(web_cache.url_hash(url));
  });
});

// ===========================================================================
// TestGetOutputSize
// ===========================================================================

describe("TestGetOutputSize", () => {
  it("test_size_from_sidecar", () => {
    const body = "X".repeat(15_000);
    const meta = web_cache.store_output("sess-size-1", "https://example.com/doc", body, 200);
    expect(meta).not.toBeNull();
    web_cache.write_sidecar(meta!);

    const size = web_cache.get_output_size(meta!.output_id);
    expect(size).not.toBeNull();
    expect(size).toBe(15_000);
  });

  it("test_size_fallback_to_disk", () => {
    const body = "Y".repeat(12_000);
    const meta = web_cache.store_output("sess-size-2", "https://example.com/api", body, 200);
    expect(meta).not.toBeNull();
    // Deliberately do not write sidecar; should fall back to disk file size.

    const size = web_cache.get_output_size(meta!.output_id);
    expect(size).not.toBeNull();
    // File size may differ slightly due to encoding; check in range.
    expect(size! > 11_900 && size! < 12_100).toBe(true);
  });

  it("test_size_for_missing_output", () => {
    const size = web_cache.get_output_size("nonexistent-id-12345");
    expect(size).toBeNull();
  });

  it("test_size_for_truncated_output", () => {
    // Create a response larger than max_stored_bytes (3 MB → truncated to ~2 MB).
    const big_body = "Z".repeat(3 * 1024 * 1024);
    const meta = web_cache.store_output("sess-size-3", "https://example.com/large", big_body, 200);
    expect(meta).not.toBeNull();
    expect(meta!.truncated).toBe(true);
    web_cache.write_sidecar(meta!);

    // get_output_size should return the original body_bytes, not the truncated.
    const size = web_cache.get_output_size(meta!.output_id);
    expect(size).not.toBeNull();
    expect(size).toBe(3 * 1024 * 1024);
  });
});

// ===========================================================================
// TestGzipCompression
// ===========================================================================

describe("TestGzipCompression", () => {
  it("test_large_body_stored_compressed", () => {
    const body = "Large web page content. ".repeat(1000); // ~24 KB, above 16 KB
    const meta = web_cache.store_output(
      "sess-gz-1",
      "https://example.com/large-page",
      body,
      200,
      { compress_bodies: true, compress_min_bytes: 16 * 1024 },
    );
    expect(meta).not.toBeNull();

    const cache_dir = web_cache._web_outputs_dir();
    const gz_path = path.join(cache_dir, meta!.output_id + ".gz");
    const txt_path = path.join(cache_dir, meta!.output_id + ".txt");

    expect(fs.existsSync(gz_path)).toBe(true);
    expect(fs.existsSync(txt_path)).toBe(true);
    // Compressed file must be smaller than the raw body.
    expect(fs.statSync(gz_path).size).toBeLessThan(Buffer.from(body, "utf8").length);
  });

  it("test_compressed_body_transparent_read", () => {
    const body = "Readable page content with text. ".repeat(600); // ~20 KB
    const meta = web_cache.store_output(
      "sess-gz-2",
      "https://example.com/readable",
      body,
      200,
      { compress_bodies: true, compress_min_bytes: 8 * 1024 },
    );
    expect(meta).not.toBeNull();

    const loaded = web_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.includes("Readable page content")).toBe(true);
  });

  it("test_small_body_not_compressed", () => {
    const body = "Short page";
    const meta = web_cache.store_output(
      "sess-gz-3",
      "https://example.com/short",
      body,
      200,
      { compress_bodies: true, compress_min_bytes: 16 * 1024 },
    );
    expect(meta).not.toBeNull();

    const cache_dir = web_cache._web_outputs_dir();
    const gz_path = path.join(cache_dir, meta!.output_id + ".gz");
    const txt_path = path.join(cache_dir, meta!.output_id + ".txt");

    expect(fs.existsSync(txt_path)).toBe(true);
    expect(fs.existsSync(gz_path)).toBe(false);

    const loaded = web_cache.load_output(meta!.output_id);
    expect(loaded !== null && loaded.includes("Short page")).toBe(true);
  });

  it("test_compress_disabled_stores_plain_text", () => {
    const body = "Large page body for testing. ".repeat(2000); // ~60 KB
    const meta = web_cache.store_output(
      "sess-gz-4",
      "https://example.com/no-compress",
      body,
      200,
      { compress_bodies: false, compress_min_bytes: 16 * 1024 },
    );
    expect(meta).not.toBeNull();

    const cache_dir = web_cache._web_outputs_dir();
    const gz_path = path.join(cache_dir, meta!.output_id + ".gz");
    const txt_path = path.join(cache_dir, meta!.output_id + ".txt");

    expect(fs.existsSync(txt_path)).toBe(true);
    expect(fs.existsSync(gz_path)).toBe(false);

    const loaded = web_cache.load_output(meta!.output_id);
    expect(loaded !== null && loaded.includes("Large page body")).toBe(true);
  });

  it("test_load_output_falls_back_to_plain_when_no_gz", () => {
    // load_output still reads plain .txt files (backward compat).
    const body = "Old cache entry without compression. ".repeat(300);
    const meta = web_cache.store_output(
      "sess-gz-5",
      "https://example.com/old-entry",
      body,
      200,
      { compress_bodies: false },
    );
    expect(meta).not.toBeNull();

    const loaded = web_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.includes("Old cache entry")).toBe(true);
  });

  // PORT: deferred to Layer 3 (hooks_fetch.post_fetch + config + session).
  it.skip("test_config_compress_bodies_wires_through", () => {});
});

// ===========================================================================
// TestIsJsonResponse
// ===========================================================================

describe("TestIsJsonResponse", () => {
  it("test_json_content_type_returns_true", () => {
    expect(web_cache._is_json_response("{}", "application/json")).toBe(true);
  });

  it("test_json_content_type_with_charset", () => {
    expect(web_cache._is_json_response("{}", "application/json; charset=utf-8")).toBe(true);
  });

  it("test_object_body_without_content_type", () => {
    expect(web_cache._is_json_response('{"key": "val"}', null)).toBe(true);
  });

  it("test_array_body_without_content_type", () => {
    expect(web_cache._is_json_response('[{"a": 1}]', null)).toBe(true);
  });

  it("test_html_body_returns_false", () => {
    expect(web_cache._is_json_response("<html></html>", "text/html")).toBe(false);
  });

  it("test_plain_text_returns_false", () => {
    expect(web_cache._is_json_response("just text", null)).toBe(false);
  });

  it("test_whitespace_before_brace_detected", () => {
    expect(web_cache._is_json_response('   {"a": 1}', null)).toBe(true);
  });
});

// ===========================================================================
// TestCompressJsonBody
// ===========================================================================

describe("TestCompressJsonBody", () => {
  it("test_short_strings_are_preserved", () => {
    const body = JSON.stringify({ name: "Alice", age: 30 });
    const result = web_cache._compress_json_body(body, 200);
    const data = JSON.parse(result);
    expect(data.name).toBe("Alice");
    expect(data.age).toBe(30);
  });

  it("test_long_string_is_truncated", () => {
    const long_val = "X".repeat(500);
    const body = JSON.stringify({ data: long_val, name: "Bob" });
    const result = web_cache._compress_json_body(body, 200);
    const data = JSON.parse(result);
    expect("data" in data).toBe(true);
    expect(data.data.length).toBeLessThan(long_val.length);
    expect(data.data.includes("more chars")).toBe(true);
    expect(data.name).toBe("Bob");
  });

  it("test_nested_objects_have_strings_truncated", () => {
    const body = JSON.stringify({ outer: { inner: "A".repeat(300) } });
    const result = web_cache._compress_json_body(body, 50);
    const data = JSON.parse(result);
    expect(data.outer.inner.includes("more chars")).toBe(true);
  });

  it("test_list_values_truncated", () => {
    const body = JSON.stringify(["short", "B".repeat(300)]);
    const result = web_cache._compress_json_body(body, 100);
    const data = JSON.parse(result);
    expect(data[0]).toBe("short");
    expect(data[1].includes("more chars")).toBe(true);
  });

  it("test_invalid_json_returned_unchanged", () => {
    const not_json = "this is not json {broken}";
    const result = web_cache._compress_json_body(not_json);
    expect(result).toBe(not_json);
  });

  it("test_non_string_values_preserved", () => {
    const body = JSON.stringify({ count: 42, flag: true, nothing: null, pi: 3.14 });
    const result = web_cache._compress_json_body(body);
    const data = JSON.parse(result);
    expect(data.count).toBe(42);
    expect(data.flag).toBe(true);
    expect(data.nothing).toBe(null);
  });
});

// ===========================================================================
// TestStoreOutputJsonRouting
// ===========================================================================

describe("TestStoreOutputJsonRouting", () => {
  it("test_json_response_has_string_values_truncated", () => {
    const big_json = JSON.stringify({ key: "V".repeat(1000), short: "ok" });
    const meta = web_cache.store_output(
      "sess-json-1",
      "https://api.example.com/data",
      big_json,
      200,
      { content_type: "application/json" },
    );
    expect(meta).not.toBeNull();
    const body = web_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    const data = JSON.parse(body!);
    expect(data.key.includes("more chars")).toBe(true);
    expect(data.short).toBe("ok");
  });

  it("test_html_response_not_json_compressed", () => {
    const html = "<html><body>" + "X".repeat(500) + "</body></html>";
    const meta = web_cache.store_output(
      "sess-html-1",
      "https://example.com/page",
      html,
      200,
      { content_type: "text/html" },
    );
    expect(meta).not.toBeNull();
    const body = web_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    expect(body!.includes("more chars")).toBe(false);
    expect(body!.includes("X".repeat(100))).toBe(true);
  });
});

// ===========================================================================
// TestSidecarContentType
// ===========================================================================

describe("TestSidecarContentType", () => {
  it("test_content_type_preserved_in_sidecar_round_trip", () => {
    const meta = web_cache.store_output(
      "sess-ct-1",
      "https://api.example.com/data",
      '{"key": "value"}'.repeat(200),
      200,
      { content_type: "application/json" },
    );
    expect(meta).not.toBeNull();
    expect(meta!.content_type).toBe("application/json");
    web_cache.write_sidecar(meta!);
    const loaded = web_cache.read_sidecar(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.content_type).toBe("application/json");
  });

  it("test_content_type_html_round_trip", () => {
    const body = "<html><body>" + "X".repeat(2000) + "</body></html>";
    const meta = web_cache.store_output(
      "sess-ct-2",
      "https://example.com/page",
      body,
      200,
      { content_type: "text/html; charset=utf-8" },
    );
    expect(meta).not.toBeNull();
    expect(meta!.content_type).toBe("text/html; charset=utf-8");
    web_cache.write_sidecar(meta!);
    const loaded = web_cache.read_sidecar(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.content_type).toBe("text/html; charset=utf-8");
  });

  it("test_content_type_none_when_not_provided", () => {
    const meta = web_cache.store_output(
      "sess-ct-3",
      "https://example.com/unknown",
      "some body content ".repeat(200),
      200,
    );
    expect(meta).not.toBeNull();
    expect(meta!.content_type).toBeNull();
    web_cache.write_sidecar(meta!);
    const loaded = web_cache.read_sidecar(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.content_type).toBeNull();
  });

  it("test_content_type_absent_in_old_sidecar_returns_none", () => {
    // Older sidecars without a content_type field are tolerated (defaults null).
    const meta = web_cache.store_output(
      "sess-ct-4",
      "https://legacy.example.com/",
      "legacy body ".repeat(200),
      200,
      { content_type: "text/plain" },
    );
    expect(meta).not.toBeNull();
    web_cache.write_sidecar(meta!);
    const p = web_cache.sidecar_meta_path(meta!.output_id);
    expect(p !== null && fs.existsSync(p)).toBe(true);
    const data = JSON.parse(fs.readFileSync(p!, "utf8"));
    delete data.content_type;
    fs.writeFileSync(p!, JSON.stringify(data), "utf8");

    const loaded = web_cache.read_sidecar(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.content_type).toBeNull();
  });
});
