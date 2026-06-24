/**
 * Tests for the in-session re-read deny-redirect (T2).
 *
 * 1:1 port of tests/test_hooks_reread_deny.py.
 *
 * Subject: hooks_read._handle_reread_deny via hooks_read.pre_read (the Read
 * pre_tool_use path). Covers:
 *   - A file read once then re-read with the same window is denied.
 *   - The full-file sentinel case (read_count past collapse threshold).
 *   - A file edited since its last read passes through (diff-hint path).
 *   - The anti-loop second-identical-attempt pass-through.
 *   - Files below the size threshold are never denied.
 *   - Disabled config / first-read / window-beyond-range pass-throughs.
 *   - Subagent shared-cache: same session_id -> denial fires.
 *   - SHA-snapshot freshness gate + on-disk (mtime_ns, size) fingerprint gate.
 *
 * Test-seam mapping (Python -> TS):
 *   - tmp_data_dir fixture        -> setup.ts's per-test setDataDirOverride.
 *   - tmp_path fixture            -> fs.mkdtempSync under os.tmpdir(), wrapped in
 *                                    fs.realpathSync (macOS /var -> /private/var)
 *                                    so find_project's canonicalisation matches.
 *   - hook_helpers.assert_continue / assert_deny -> _assert_continue / _assert_deny.
 *   - patch.object(cfg_mod, "load", return_value=_cfg()) ->
 *     vi.spyOn(config, "load").mockReturnValue(_cfg(...)). _handle_reread_deny
 *     calls config.load() through the static `import * as config` namespace, so
 *     the spy on the same module object intercepts (ESM live-binding = Python's
 *     mock.patch). pre_read itself reads config through the same namespace.
 *   - dataclasses.replace(base, hints=replace(base.hints, ...)) -> a shallow
 *     clone of the loaded ConfigSchema with an overridden `hints` sub-object.
 *   - os.utime(f, ns=(t, t))      -> fs.utimesSync with seconds (mtime moved
 *     far enough that ns granularity is irrelevant).
 *
 * No Layer-6/7 dependency is reached on this path: the handlers ahead of
 * _handle_reread_deny in pre_read (task-output, image-shrink, notebook,
 * indexed-cat, recovery, skill-file, index-only, content-dedup, doc-compact,
 * structured-file, unchanged-file-hint) all return null for a plain unedited
 * .py file with no snapshots / no _tg_from_bash_cat marker, and _getContextPressure
 * is null-gated. So every case below ports without an it.skip deferral.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as config from "../src/token_goat/config.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as session from "../src/token_goat/session.js";
import type { ConfigSchema, HookPayload } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verbatim port of hook_helpers.assert_continue. */
function _assert_continue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

/** Verbatim port of hook_helpers.assert_deny. */
function _assert_deny(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
  const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
  expect(hso["permissionDecision"]).toBe("deny");
}

/**
 * Port of the module-level `_cfg`: load the base config and return a clone with
 * the reread-deny knobs overridden. dataclasses.replace -> shallow object clone.
 */
function _cfg(opts: { reread_deny?: boolean; min_bytes?: number } = {}): ConfigSchema {
  const reread_deny = opts.reread_deny ?? true;
  const min_bytes = opts.min_bytes ?? 0;
  const base = config.load();
  return {
    ...base,
    hints: { ...base.hints, reread_deny, reread_deny_min_bytes: min_bytes },
  };
}

/** Port of `_read_payload`. */
function _read_payload(
  filePath: string,
  sid: string,
  tmpDir: string,
  ti: Record<string, unknown> = {},
): HookPayload {
  const tool_input: Record<string, unknown> = { file_path: filePath, ...ti };
  return { session_id: sid, tool_name: "Read", tool_input, cwd: tmpDir } as unknown as HookPayload;
}

/** Port of `_write`: create a file with `n_bytes` of "x". */
function _write(filePath: string, n_bytes = 4096): string {
  fs.writeFileSync(filePath, Buffer.alloc(n_bytes, "x"));
  return filePath;
}

/** Port of `_decision`. */
function _decision(result: Record<string, unknown>): string | null {
  const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
  return (hso["permissionDecision"] as string | undefined) ?? null;
}

/** Port of `_ctx`. */
function _ctx(result: Record<string, unknown>): string {
  const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
  return (hso["additionalContext"] as string | undefined) ?? "";
}

/** Port of `_record_read`. */
function _record_read(sid: string, filePath: string, offset: number | null = null, limit: number | null = null): void {
  session.mark_file_read(sid, filePath, offset, limit);
}

/** Throwaway tmp dir (pytest tmp_path analogue), realpath-resolved. */
function tmpPath(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-reread-")));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Core deny behaviour
// ---------------------------------------------------------------------------

describe("TestRereaDenyCore (port of tests/test_hooks_reread_deny.py)", () => {
  it("test_second_full_read_denied", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "source.py"));
    const sid = "rrd-full";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
  });

  it("test_deny_message_mentions_file_and_prior_range", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "target.py"));
    const sid = "rrd-msg";
    _record_read(sid, f, 0, 100);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path, { offset: 0, limit: 100 }));
    _assert_deny(result);
    const ctx = _ctx(result);
    expect(ctx).toContain("target.py");
    // Should mention surgical alternatives.
    expect(ctx.toLowerCase().includes("token-goat") || ctx.includes("offset")).toBe(true);
  });

  it("test_deny_message_mentions_antiloop_escape", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "escape.py"));
    const sid = "rrd-escape";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
    const ctx = _ctx(result).toLowerCase();
    expect(ctx.includes("second") || ctx.includes("again") || ctx.includes("pass")).toBe(true);
  });

  it("test_windowed_contained_read_denied", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "windowed.py"));
    const sid = "rrd-wind";
    _record_read(sid, f, 0, 200);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path, { offset: 49, limit: 100 }));
    _assert_deny(result);
  });

  it("test_full_file_sentinel_denied", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "sentinel.py"));
    const sid = "rrd-sentinel";
    for (let i = 0; i < session._READ_COUNT_FULL_FILE_THRESHOLD + 1; i++) {
      _record_read(sid, f, i * 10, 10);
    }
    const entry = session.get_file_entry(sid, f);
    expect(entry).not.toBeNull();
    const hasSentinel = entry!.line_ranges.some(([a, b]) => a === 0 && b === 0);
    expect(hasSentinel).toBe(true);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
  });
});

// ---------------------------------------------------------------------------
// Anti-loop guard: second identical attempt passes through
// ---------------------------------------------------------------------------

describe("TestRereaDenyAntiLoop (port of tests/test_hooks_reread_deny.py)", () => {
  it("test_second_attempt_passes_through", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "antiloop.py"));
    const sid = "rrd-antiloop";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const first = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    const second = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(first);
    _assert_continue(second);
  });

  it("test_different_window_after_deny_still_denied", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "diff_window.py"));
    const sid = "rrd-diffwin";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const first = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    const second = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(first);
    // second is the anti-loop pass-through for the SAME window.
    _assert_continue(second);
  });
});

// ---------------------------------------------------------------------------
// Pass-through cases
// ---------------------------------------------------------------------------

describe("TestRereaDenyPassThrough (port of tests/test_hooks_reread_deny.py)", () => {
  it("test_first_read_passes_through", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "first.py"));
    const sid = "rrd-first";
    // No _record_read — no session history.
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_continue(result);
  });

  it("test_edited_file_passes_through", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "edited.py"));
    const sid = "rrd-edited";
    _record_read(sid, f);
    session.mark_file_edited(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    // If it's a deny, it must NOT be the reread message.
    if (hso["permissionDecision"] === "deny") {
      expect(_ctx(result)).not.toContain("already in context");
    }
  });

  it("test_window_extends_beyond_recorded_range_passes_through", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "partial.py"));
    const sid = "rrd-partial";
    _record_read(sid, f, 0, 50); // records lines 1–50
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path, { offset: 39, limit: 60 }));
    _assert_continue(result);
  });

  it("test_later_start_unbounded_read_denied", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "laterstart.py"));
    const sid = "rrd-laterstart";
    _record_read(sid, f); // full file
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path, { offset: 99 }));
    _assert_deny(result);
  });

  it("test_config_disabled_passes_through", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "disabled.py"));
    const sid = "rrd-disabled";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg({ reread_deny: false }));
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_continue(result);
  });

  it("test_small_file_exempt", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "tiny.py"), 500);
    const sid = "rrd-small";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg({ min_bytes: 2048 }));
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_continue(result);
  });

  it("test_min_bytes_zero_denies_small_file", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "tiny_deny.py"), 100);
    const sid = "rrd-tiny-deny";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg({ min_bytes: 0 }));
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
  });
});

// ---------------------------------------------------------------------------
// Subagent shared cache
// ---------------------------------------------------------------------------

describe("TestRereaDenySubagent (port of tests/test_hooks_reread_deny.py)", () => {
  it("test_shared_session_id_triggers_deny", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "shared.py"));
    const sid = "rrd-shared-parent";
    _record_read(sid, f); // "parent" read
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
  });
});

// ---------------------------------------------------------------------------
// SHA verification
// ---------------------------------------------------------------------------

describe("TestRereaDenyShaVerification (port of tests/test_hooks_reread_deny.py)", () => {
  function _store_snapshot(sid: string, filePath: string): void {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    session.set_snapshot_sha(sid, filePath, sha);
  }

  it("test_deny_fires_when_sha_matches", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "sha_match.py"));
    const sid = "rrd-sha-match";
    _record_read(sid, f);
    _store_snapshot(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
  });

  it("test_pass_through_when_sha_differs", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "sha_diff.py"));
    const sid = "rrd-sha-diff";
    _record_read(sid, f);
    _store_snapshot(sid, f);
    // Modify file externally — SHA now differs from snapshot. Keep size the
    // same so the (mtime_ns, size) fingerprint gate cannot pre-empt the SHA
    // gate; the on-disk SHA divergence is what must drive the pass-through.
    fs.writeFileSync(f, Buffer.alloc(4096, "y"));
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_continue(result);
  });

  it("test_no_snapshot_still_denies", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "no_snap.py"));
    const sid = "rrd-no-snap";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
  });

  it("test_sha_mismatch_overrides_unedited_timestamp", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "ext_change.py"));
    const sid = "rrd-ext";
    _record_read(sid, f);
    _store_snapshot(sid, f);
    fs.writeFileSync(f, Buffer.alloc(4096, "z"));
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_continue(result);
  });
});

// ---------------------------------------------------------------------------
// On-disk fingerprint (mtime_ns + size): cross-session freshness gate
// ---------------------------------------------------------------------------

describe("TestRereaDenyOnDiskFingerprint (port of tests/test_hooks_reread_deny.py)", () => {
  it("test_fingerprint_recorded_at_read", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "fp_record.py"));
    const sid = "rrd-fp-record";
    _record_read(sid, f);
    const entry = session.get_file_entry(sid, f); // loads from disk -> exercises (de)serialization
    expect(entry).not.toBeNull();
    const st = fs.statSync(f);
    const stMtimeNs = Number((st as fs.Stats & { mtimeNs?: bigint }).mtimeNs ?? Math.round(st.mtimeMs * 1_000_000));
    expect(entry!.read_mtime_ns).toBe(stMtimeNs);
    expect(entry!.read_size).toBe(st.size);
  });

  it("test_unchanged_file_still_denied", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "fp_same.py"));
    const sid = "rrd-fp-same";
    _record_read(sid, f);
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
  });

  it("test_size_changed_passes_through", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "fp_grow.py"), 4096);
    const sid = "rrd-fp-grow";
    _record_read(sid, f);
    fs.writeFileSync(f, Buffer.alloc(8192, "x")); // size 4096 -> 8192
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_continue(result);
  });

  it("test_mtime_changed_same_size_passes_through", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "fp_mtime.py"), 4096);
    const sid = "rrd-fp-mtime";
    _record_read(sid, f);
    const entry = session.get_file_entry(sid, f);
    expect(entry).not.toBeNull();
    // +5s, beyond any fs mtime resolution. utimesSync takes seconds.
    const futureSec = entry!.read_mtime_ns! / 1e9 + 5;
    fs.utimesSync(f, futureSec, futureSec);
    expect(fs.statSync(f).size).toBe(entry!.read_size); // size unchanged
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_continue(result);
  });

  it("test_subagent_edit_under_different_session_passes_through", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "subagent_edit.py"), 4096);
    const parent = "rrd-parent-sess";
    const subagent = "rrd-subagent-sess";
    _record_read(parent, f); // parent reads — fingerprint captured

    // Sub-agent edit: content lands on disk AND post_edit records under the *sub* session.
    fs.writeFileSync(f, Buffer.alloc(9000, "y"));
    session.mark_file_edited(subagent, f);

    // Parent's own entry never saw the edit — timestamp guard would still deny.
    const parentEntry = session.get_file_entry(parent, f);
    expect(parentEntry).not.toBeNull();
    expect(parentEntry!.last_edit_ts).toBe(0.0);

    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, parent, tmp_path));
    _assert_continue(result);
  });

  it("test_zero_fingerprint_round_trips_distinct_from_none", async () => {
    // A recorded 0 must be serialized, not dropped.
    const e0 = new session.FileEntry({
      rel_or_abs: "f.py",
      last_read_ts: 1.0,
      read_count: 1,
      line_ranges: [],
      symbols_read: [],
      read_mtime_ns: 0,
      read_size: 0,
    });
    const d0 = session._serialize_file_entry(e0);
    expect(d0["read_mtime_ns"]).toBe(0);
    expect(d0["read_size"]).toBe(0);
    // Parsing that wire dict back preserves 0 (a real value, not null).
    const back = session._parse_file_entry("f.py", { ...d0 }, 1.0);
    expect(back).not.toBeNull();
    expect(back!.read_mtime_ns).toBe(0);
    expect(back!.read_size).toBe(0);
    // An unrecorded fingerprint (keys absent — legacy session JSON) parses to null, not 0.
    const legacy = session._parse_file_entry(
      "f.py",
      { rel_or_abs: "f.py", last_read_ts: 1.0, read_count: 1 },
      1.0,
    );
    expect(legacy).not.toBeNull();
    expect(legacy!.read_mtime_ns).toBeNull();
    expect(legacy!.read_size).toBeNull();
  });

  it("test_zero_fingerprint_freshness_gate_detects_change", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "epoch_fp.py"), 4096);
    const sid = "rrd-epoch-fp";
    _record_read(sid, f);
    // Force the recorded fingerprint to the epoch sentinel value (mtime_ns=0, size=0).
    const cache = session.load(sid);
    for (const entry of Object.values(cache.files)) {
      entry.read_mtime_ns = 0;
      entry.read_size = 0;
    }
    session.save(cache);
    // Live (mtime_ns, size) differs from the recorded (0, 0): must NOT be denied.
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    expect(_decision(result)).not.toBe("deny");
  });

  it("test_legacy_entry_without_fingerprint_still_denied", async () => {
    const tmp_path = tmpPath();
    const f = _write(path.join(tmp_path, "legacy_fp.py"), 4096);
    const sid = "rrd-legacy-fp";
    _record_read(sid, f);
    // Simulate a legacy/unstattable entry: clear the on-disk fingerprint to null.
    const cache = session.load(sid);
    for (const entry of Object.values(cache.files)) {
      entry.read_mtime_ns = null;
      entry.read_size = null;
    }
    session.save(cache);
    // File is unchanged on disk -> deny must still fire.
    vi.spyOn(config, "load").mockReturnValue(_cfg());
    const result = await hooks_read.pre_read(_read_payload(f, sid, tmp_path));
    _assert_deny(result);
  });
});
