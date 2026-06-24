/**
 * Direct unit tests for the `_run_history_listing_command` helper (DRY#6) — TS
 * port of tests/test_cli_history_listing.py. The helper is EXPORTED from
 * cli_skills.ts (batch D, for batch F reuse); these tests call it directly with
 * a fake cache module and capture stdout (Python capsys → process.stdout spy).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { _run_history_listing_command } from "../src/token_goat/cli_skills.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Capture process.stdout writes during *fn*. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8"));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

type Entry = { output_id: string; size_bytes: number; mtime: number };

function makeCacheModule(
  entries: Entry[] = [],
  sidecar: unknown = null,
): { list_outputs: () => Entry[]; read_sidecar: (oid: string) => unknown } {
  return {
    list_outputs: () => entries,
    read_sidecar: () => sidecar,
  };
}

function entry(output_id = "abc123", size_bytes = 1024, mtime = 0): Entry {
  return { output_id, size_bytes, mtime };
}

describe("TestHistoryListingEmptyState", () => {
  it("empty state prints message", () => {
    const cache = makeCacheModule([]);
    const out = captureStdout(() =>
      _run_history_listing_command(cache, {
        json_output: false,
        limit: 20,
        empty_msg: "(nothing here)",
        json_sidecar_fields: () => ({}),
        format_entry: (oid) => `${oid}`,
      }),
    );
    expect(out).toContain("(nothing here)");
  });

  it("empty state json returns empty list", () => {
    const cache = makeCacheModule([]);
    const out = captureStdout(() =>
      _run_history_listing_command(cache, {
        json_output: true,
        limit: 20,
        empty_msg: "(nothing here)",
        json_sidecar_fields: () => ({}),
        format_entry: () => "",
      }),
    );
    expect(JSON.parse(out)).toEqual([]);
  });
});

describe("TestHistoryListingLimit", () => {
  it("limit truncates entries", () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`id${i}`));
    const cache = makeCacheModule(entries);
    const out = captureStdout(() =>
      _run_history_listing_command(cache, {
        json_output: false,
        limit: 3,
        empty_msg: "",
        json_sidecar_fields: () => ({}),
        format_entry: (oid) => oid,
      }),
    );
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("id0");
  });

  it("limit 0 shows all", () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(`id${i}`));
    const cache = makeCacheModule(entries);
    const out = captureStdout(() =>
      _run_history_listing_command(cache, {
        json_output: false,
        limit: 0,
        empty_msg: "",
        json_sidecar_fields: () => ({}),
        format_entry: (oid) => oid,
      }),
    );
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
  });
});

describe("TestHistoryListingFormatEntry", () => {
  it("format_entry receives correct args", () => {
    const sidecar = { cmd_preview: "echo hi", exit_code: 0 };
    const cache = makeCacheModule([entry("myid", 512)], sidecar);
    const seen: Array<[string, number, unknown]> = [];
    const out = captureStdout(() =>
      _run_history_listing_command(cache, {
        json_output: false,
        limit: 20,
        empty_msg: "",
        json_sidecar_fields: () => ({}),
        format_entry: (oid, size, _age, s) => {
          seen.push([oid, size, s]);
          return `${oid}:${size}`;
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("myid");
    expect(seen[0]![1]).toBe(512);
    expect(seen[0]![2]).toBe(sidecar);
    expect(out).toContain("myid:512");
  });
});

describe("TestHistoryListingJson", () => {
  it("json merges sidecar fields", () => {
    const sidecar = { url_preview: "https://example.com", status_code: 200, truncated: false };
    const cache = makeCacheModule([entry("webid")], sidecar);
    const out = captureStdout(() =>
      _run_history_listing_command(cache, {
        json_output: true,
        limit: 20,
        empty_msg: "",
        json_sidecar_fields: (s) => {
          const sc = s as { url_preview: string; status_code: number };
          return { url_preview: sc.url_preview, status_code: sc.status_code };
        },
        format_entry: () => "",
      }),
    );
    const rows = JSON.parse(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].url_preview).toBe("https://example.com");
    expect(rows[0].status_code).toBe(200);
  });

  it("json with no sidecar omits extra fields", () => {
    const cache = makeCacheModule([entry("noid")], null);
    const out = captureStdout(() =>
      _run_history_listing_command(cache, {
        json_output: true,
        limit: 20,
        empty_msg: "",
        json_sidecar_fields: (s) => ({ url_preview: (s as { url_preview: string }).url_preview }),
        format_entry: () => "",
      }),
    );
    const rows = JSON.parse(out);
    expect(rows[0]).not.toHaveProperty("url_preview");
    expect(rows[0].output_id).toBe("noid");
  });
});
