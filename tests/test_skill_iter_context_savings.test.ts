/**
 * Tests for context savings improvements (iterations 39-48).
 *
 * 1:1 port of tests/test_skill_iter_context_savings.py (same class->describe,
 * def->it names + assertion polarity).
 *
 * Sub-areas:
 *   D  — web-output --list flag            [DEFERRED: cli/app not ported]
 *   E  — map --filter GLOB / --since-minutes [DEFERRED: cli/app not ported]
 *   F  — grep dedup hint quality           [ported via session + hooks_read]
 *   G  — ruff / mypy filter compression     [ported via bash_compress]
 *   H  — pre-read binary/large-file skip    [ported via hooks_read]
 *   I  — web-fetch HTML stripping           [DEFERRED: webfetch not ported]
 *   J  — stats --since DAYS flag            [DEFERRED: cli/cli_stats not ported]
 *   A+B — extra bash_compress filter tests  [ported via bash_compress]
 *
 * Port notes:
 *  - tmp_data_dir: setup.ts applies a per-test data dir + cache reset, so no
 *    fixture is needed here.
 *  - bash_compress filters: `f.apply(stdout, stderr, exit_code, argv)` returns a
 *    CompressedOutput whose `.text` is the compressed body. `_filter_text` is
 *    the local CompressedOutput->text extractor (Python `compressed_output.text`).
 *  - hooks_read.pre_read is ASYNC in the TS port (returns Promise) — every call
 *    is awaited. Its CONTINUE response is `{ continue: true }` (no
 *    hookSpecificOutput), so "hint should not fire" asserts hso is undefined
 *    (Python `result.get("hookSpecificOutput") is None`).
 *  - session.mark_grep keyword args (path=, result_count=) map to positionals:
 *    mark_grep(sid, pattern, path, result_count).
 *  - H's monkeypatch of hooks_read._is_binary_or_large_file -> vi.spyOn on the
 *    namespace import; pre_read calls it via `self._is_binary_or_large_file`, so
 *    the spy is observed.
 *  - DEFERRED sub-areas (D/E/I/J + Manifest-cli) depend on modules not yet
 *    ported (cli/app, webfetch, cli_stats); each case is it.skip with a reason.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as bash_compress from "../src/token_goat/bash_compress.js";
import type { CompressedOutput } from "../src/token_goat/bash_compress.js";
import * as session from "../src/token_goat/session.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";
import type { HookPayload } from "../src/token_goat/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Extract text from a CompressedOutput object. */
function _filter_text(compressed_output: CompressedOutput): string {
  return compressed_output.text;
}

/** Realpath a fresh tmp dir (macOS /var symlink vs realpath-normalised paths). */
function realTmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-iter-")));
}

/** Read result.hookSpecificOutput, matching Python `result.get("hookSpecificOutput")`. */
function hso(result: Record<string, unknown>): Record<string, unknown> | undefined {
  return result["hookSpecificOutput"] as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Sub-area D — web-output --list flag   [DEFERRED]
// ---------------------------------------------------------------------------

describe("TestWebOutputList", () => {
  it.skip("test_list_shows_all_cached_entries — DEFERRED: cli/app (typer CLI) not ported", () => {});
  it.skip("test_list_empty_cache_shows_message — DEFERRED: cli/app (typer CLI) not ported", () => {});
  it.skip("test_list_json_output_is_parseable — DEFERRED: cli/app (typer CLI) not ported", () => {});
  it.skip("test_list_does_not_require_output_id — DEFERRED: cli/app (typer CLI) not ported", () => {});
  it.skip("test_list_shows_size_info — DEFERRED: cli/app (typer CLI) not ported", () => {});
});

// ---------------------------------------------------------------------------
// Sub-area E — map --filter GLOB and --since-minutes N   [DEFERRED]
// ---------------------------------------------------------------------------

describe("TestMapFilter", () => {
  it.skip("test_filter_limits_to_py_files — DEFERRED: cli/app + repomap not ported", () => {});
  it.skip("test_filter_keeps_header_lines — DEFERRED: cli/app + repomap not ported", () => {});
  it.skip("test_filter_ts_pattern — DEFERRED: cli/app + repomap not ported", () => {});
  it.skip("test_filter_subdir_pattern — DEFERRED: cli/app + repomap not ported", () => {});
});

describe("TestMapSinceMinutes", () => {
  it.skip("test_since_minutes_returns_recent_files — DEFERRED: cli/app + repomap not ported", () => {});
  it.skip("test_since_minutes_no_matches_says_no_files — DEFERRED: cli/app + repomap not ported", () => {});
  it.skip("test_since_minutes_header_shows_count — DEFERRED: cli/app + repomap not ported", () => {});
});

// ---------------------------------------------------------------------------
// Sub-area F — grep dedup hint quality
// ---------------------------------------------------------------------------

describe("TestGrepDedupHintQuality", () => {
  it("test_hint_includes_pattern", async () => {
    session.mark_grep("gq-1", "def authenticate", "src/", 42);
    const payload: HookPayload = {
      session_id: "gq-1",
      tool_name: "Grep",
      tool_input: { pattern: "def authenticate", path: "src/" },
    };
    const result = await hooks_read.pre_read(payload);
    const h = hso(result);
    expect(h).not.toBeUndefined();
    const ctx = (h?.["additionalContext"] as string) ?? "";
    expect(ctx).toContain("authenticate");
  });

  it("test_hint_includes_result_count", async () => {
    session.mark_grep("gq-2", "import React", "src/", 87);
    const payload: HookPayload = {
      session_id: "gq-2",
      tool_name: "Grep",
      tool_input: { pattern: "import React", path: "src/" },
    };
    const result = await hooks_read.pre_read(payload);
    const h = hso(result);
    expect(h).not.toBeUndefined();
    const ctx = (h?.["additionalContext"] as string) ?? "";
    expect(ctx).toContain("87");
  });

  it("test_same_pattern_different_path_no_dedup", async () => {
    session.mark_grep("gq-3", "TODO", "src/", 200);
    // Now search in a different path.
    const payload: HookPayload = {
      session_id: "gq-3",
      tool_name: "Grep",
      tool_input: { pattern: "TODO", path: "tests/" },
    };
    const result = await hooks_read.pre_read(payload);
    expect(hso(result)).toBeUndefined();
  });

  it("test_same_pattern_same_path_triggers_dedup", async () => {
    session.mark_grep("gq-4", "class Foo", "src/models/", 15);
    const payload: HookPayload = {
      session_id: "gq-4",
      tool_name: "Grep",
      tool_input: { pattern: "class Foo", path: "src/models/" },
    };
    const result = await hooks_read.pre_read(payload);
    expect(hso(result)).not.toBeUndefined();
  });

  it("test_hint_includes_age_indication", async () => {
    session.mark_grep("gq-5", "raise ValueError", null, 50);
    const payload: HookPayload = {
      session_id: "gq-5",
      tool_name: "Grep",
      tool_input: { pattern: "raise ValueError" },
    };
    const result = await hooks_read.pre_read(payload);
    const h = hso(result);
    expect(h).not.toBeUndefined();
    const ctx = (h?.["additionalContext"] as string) ?? "";
    // Hint should contain some age indicator (s suffix, or "ago").
    const markers = ["s", "ago", "sec", "min"];
    expect(markers.some((m) => ctx.includes(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area G — ruff / mypy filter compression quality
// ---------------------------------------------------------------------------

describe("TestRuffFilterCompression", () => {
  function _filter(): bash_compress.RuffFilter {
    return new bash_compress.RuffFilter();
  }

  it("test_keeps_error_lines", () => {
    const stdout =
      "src/main.py:10:1: E501 Line too long (120 > 79 characters)\n" +
      "src/main.py:20:1: F401 'os' imported but unused\n" +
      "Found 2 errors.\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["ruff", "check", "."]));
    expect(result).toContain("E501");
    expect(result).toContain("F401");
  });

  it("test_keeps_found_N_errors_footer", () => {
    const stdout = "src/a.py:1:1: E501 Line too long\nFound 1 error.\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["ruff", "check", "."]));
    expect(result).toContain("Found 1 error");
  });

  it("test_collapses_repeated_rule_across_files", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const fn = i <= 3 ? "a.py" : "b.py";
      lines.push(`src/${fn}:${i}:1: E501 Line too long`);
    }
    lines.push("Found 5 errors.");
    const stdout = lines.join("\n") + "\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["ruff", "check", "."]));
    expect(result).toContain("E501");
    expect(result).toContain("occurrences");
  });

  it("test_clean_exit_returns_empty", () => {
    const f = _filter();
    const result = _filter_text(f.apply("All checks passed!\n", "", 0, ["ruff", "check", "."]));
    expect(result).toBe("");
  });

  it("test_ruff_format_collapses_reformatted_lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`Reformatted src/file${i}.py`);
    }
    lines.push("10 files reformatted, 0 files left unchanged.");
    const stdout = lines.join("\n") + "\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 0, ["ruff", "format", "."]));
    expect(result).not.toContain("Reformatted src/file0.py");
    expect(result).toContain("10 files reformatted");
  });

  it("test_single_file_single_rule_kept_verbatim", () => {
    const stdout =
      "src/main.py:5:1: F841 Local variable `x` is assigned but never used\nFound 1 error.\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["ruff", "check", "."]));
    expect(result).toContain("src/main.py:5:1");
    expect(result).toContain("F841");
  });

  it("test_empty_output_no_crash", () => {
    const f = _filter();
    const result = _filter_text(f.apply("", "", 0, ["ruff", "check", "."]));
    expect(typeof result).toBe("string");
  });
});

describe("TestMypyFilterCompression", () => {
  function _filter(): bash_compress.MypyFilter {
    return new bash_compress.MypyFilter();
  }

  it("test_keeps_error_lines", () => {
    const stdout =
      "src/auth.py:10: error: Incompatible return value type\n" +
      "src/models.py:25: error: Argument 1 has incompatible type\n" +
      "Found 2 errors in 2 files (checked 10 source files)\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]));
    expect(result).toContain("src/auth.py:10");
    expect(result).toContain("src/models.py:25");
  });

  it("test_keeps_found_N_errors_summary", () => {
    const stdout =
      "src/x.py:1: error: Incompatible type\n" +
      "Found 1 error in 1 file (checked 5 source files)\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]));
    expect(result).toContain("Found 1 error");
  });

  it("test_dedupes_repeated_error_message", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`src/file${i}.py:${i + 1}: error: Incompatible return value type`);
    }
    lines.push("Found 10 errors in 10 files (checked 10 source files)");
    const stdout = lines.join("\n") + "\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]));
    expect(result.includes("token-goat") || result.toLowerCase().includes("suppressed")).toBe(true);
    expect(result).toContain("Found 10 errors");
  });

  it("test_drops_see_also_notes", () => {
    const stdout =
      "src/x.py:5: error: Name 'foo' is not defined\n" +
      "src/x.py:5: note: See https://mypy.readthedocs.io/en/stable/error_codes.html\n" +
      "Found 1 error in 1 file\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]));
    expect(result).not.toContain("mypy.readthedocs.io");
    expect(result).toContain("Found 1 error");
  });

  it("test_empty_input_no_crash", () => {
    const f = _filter();
    const result = _filter_text(f.apply("", "", 0, ["mypy", "src"]));
    expect(typeof result).toBe("string");
  });

  it("test_keeps_first_three_occurrences_of_same_error", () => {
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      lines.push(`src/f${i}.py:1: error: Incompatible return value type`);
    }
    lines.push("Found 6 errors in 6 files");
    const stdout = lines.join("\n") + "\n";
    const f = _filter();
    const result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]));
    const result_lines = result.split("\n").filter((ln) => ln.includes("error: Incompatible"));
    expect(result_lines.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Sub-area H — pre-read hook skips hints for binary / large files
// ---------------------------------------------------------------------------

describe("TestPreReadBinaryLargeFileSkip", () => {
  it("test_binary_extension_skips_hints", async () => {
    const tmp = realTmpDir();
    const so_file = path.join(tmp, "libfoo.so");
    fs.writeFileSync(so_file, Buffer.concat([Buffer.from("\x7fELF"), Buffer.alloc(100)]));
    const payload: HookPayload = {
      session_id: "bin-skip-1",
      tool_name: "Read",
      tool_input: { file_path: so_file },
    };
    const result = await hooks_read.pre_read(payload);
    expect(hso(result)).toBeUndefined();
  });

  it("test_pyc_extension_skips_hints", async () => {
    const tmp = realTmpDir();
    const pyc_file = path.join(tmp, "module.pyc");
    fs.writeFileSync(pyc_file, Buffer.concat([Buffer.from("\x6f\r\r\n"), Buffer.alloc(50)]));
    const payload: HookPayload = {
      session_id: "bin-skip-2",
      tool_name: "Read",
      tool_input: { file_path: pyc_file },
    };
    const result = await hooks_read.pre_read(payload);
    expect(hso(result)).toBeUndefined();
  });

  it("test_zip_extension_skips_hints", async () => {
    const tmp = realTmpDir();
    const zip_file = path.join(tmp, "dist.zip");
    fs.writeFileSync(zip_file, Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(50)]));
    const payload: HookPayload = {
      session_id: "bin-skip-3",
      tool_name: "Read",
      tool_input: { file_path: zip_file },
    };
    const result = await hooks_read.pre_read(payload);
    expect(hso(result)).toBeUndefined();
  });

  it("test_large_file_skips_hints", async () => {
    const tmp = realTmpDir();
    const large_file = path.join(tmp, "bigdata.log");
    fs.writeFileSync(large_file, Buffer.alloc(100, 0x78));

    // Monkeypatch _is_binary_or_large_file to report this file as large.
    const original_fn = hooks_read._is_binary_or_large_file;
    vi.spyOn(hooks_read, "_is_binary_or_large_file").mockImplementation((p: string) => {
      if (path.basename(p) === "bigdata.log") {
        return true;
      }
      return original_fn(p);
    });

    const payload: HookPayload = {
      session_id: "large-skip-1",
      tool_name: "Read",
      tool_input: { file_path: large_file },
    };
    const result = await hooks_read.pre_read(payload);
    expect(hso(result)).toBeUndefined();
  });

  it("test_is_binary_or_large_file_function_binary_ext", () => {
    const tmp = realTmpDir();
    const binary_files = [
      path.join(tmp, "lib.so"),
      path.join(tmp, "code.pyc"),
      path.join(tmp, "archive.zip"),
      path.join(tmp, "model.db"),
      path.join(tmp, "font.ttf"),
      path.join(tmp, "doc.pdf"),
    ];
    for (const bf of binary_files) {
      fs.writeFileSync(bf, Buffer.alloc(10));
      expect(hooks_read._is_binary_or_large_file(bf)).toBe(true);
    }
  });

  it("test_is_binary_or_large_file_returns_false_for_source", () => {
    const tmp = realTmpDir();
    const source_files = [
      path.join(tmp, "main.py"),
      path.join(tmp, "index.ts"),
      path.join(tmp, "config.toml"),
      path.join(tmp, "README.md"),
      path.join(tmp, "app.js"),
    ];
    for (const sf of source_files) {
      fs.writeFileSync(sf, "content");
      expect(hooks_read._is_binary_or_large_file(sf)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Sub-area I — web-fetch HTML stripping   [DEFERRED]
// ---------------------------------------------------------------------------

describe("TestWebFetchHtmlStripping", () => {
  it.skip("test_script_blocks_stripped — DEFERRED: webfetch module not ported", () => {});
  it.skip("test_style_blocks_stripped — DEFERRED: webfetch module not ported", () => {});
  it.skip("test_json_body_passes_through_unchanged — DEFERRED: webfetch module not ported", () => {});
  it.skip("test_html_strip_reduces_size_by_20_percent — DEFERRED: webfetch module not ported", () => {});
  it.skip("test_html_entities_decoded — DEFERRED: webfetch module not ported", () => {});
});

// ---------------------------------------------------------------------------
// Sub-area J — stats --since DAYS flag   [DEFERRED]
// ---------------------------------------------------------------------------

describe("TestStatsSinceFlag", () => {
  it.skip("test_since_flag_calls_correct_window — DEFERRED: cli/cli_stats not ported", () => {});
  it.skip("test_since_overrides_window — DEFERRED: cli/cli_stats not ported", () => {});
  it.skip("test_since_one_is_today — DEFERRED: cli/cli_stats not ported", () => {});
  it.skip("test_without_since_uses_default_window — DEFERRED: cli/cli_stats not ported", () => {});
});

// ---------------------------------------------------------------------------
// Sub-area A+B — extra bash_compress filter tests
// ---------------------------------------------------------------------------

describe("TestMakeFilterExtended", () => {
  it("test_keeps_error_lines", () => {
    const f = new bash_compress.MakeFilter();
    const stdout =
      "make[1]: Entering directory '/build'\n" +
      "cc -c src/main.c\n" +
      "src/main.c:10: error: 'foo' undeclared\n" +
      "make[1]: *** [Makefile:5: main.o] Error 1\n" +
      "make[1]: Leaving directory '/build'\n";
    const result = _filter_text(f.apply(stdout, "", 1, ["make"]));
    expect(result).toContain("error: 'foo' undeclared");
    expect(result).toContain("Error 1");
  });

  it("test_drops_entering_leaving_lines", () => {
    const f = new bash_compress.MakeFilter();
    const stdout =
      "make[1]: Entering directory '/build'\n" +
      "src/app.c:5: error: syntax error\n" +
      "make[1]: Leaving directory '/build'\n";
    const result = _filter_text(f.apply(stdout, "", 1, ["make"]));
    expect(result).not.toContain("make[1]: Entering directory");
    expect(result).not.toContain("make[1]: Leaving directory");
    expect(result).toContain("syntax error");
  });

  it("test_cmake_percent_progress_dropped", () => {
    const f = new bash_compress.MakeFilter();
    const lines: string[] = [];
    for (let i = 10; i <= 100; i += 10) {
      lines.push(`[ ${i}%] Building C object src/CMakeFiles/app.dir/main.c.o`);
    }
    const stdout = lines.join("\n") + "\n";
    const result = _filter_text(f.apply(stdout, "", 0, ["make"]));
    expect(!result.includes("Building C object") || result.includes("token-goat")).toBe(true);
  });
});

describe("TestTerraformFilterExtended", () => {
  it("test_plan_drops_refresh_lines", () => {
    const f = new bash_compress.TerraformFilter();
    const stdout =
      "aws_instance.web: Refreshing state... [id=i-1234]\n" +
      "aws_security_group.sg: Refreshing state... [id=sg-5678]\n" +
      "Plan: 1 to add, 0 to change, 0 to destroy.\n";
    const result = _filter_text(f.apply(stdout, "", 0, ["terraform", "plan"]));
    expect(result).not.toContain("Refreshing state");
    expect(result).toContain("Plan: 1 to add");
  });

  it("test_apply_keeps_completion_summary", () => {
    const f = new bash_compress.TerraformFilter();
    const stdout =
      "aws_instance.web: Creating...\n" +
      "aws_instance.web: Still creating... [10s elapsed]\n" +
      "aws_instance.web: Creation complete after 30s [id=i-abc]\n" +
      "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.\n";
    const result = _filter_text(f.apply(stdout, "", 0, ["terraform", "apply"]));
    expect(result).toContain("Apply complete!");
  });

  it("test_error_exit_preserves_all_stderr", () => {
    const f = new bash_compress.TerraformFilter();
    const stderr = "Error: Invalid argument 'foo'\n\nThe given value is not valid.\n";
    const result = _filter_text(f.apply("", stderr, 1, ["terraform", "plan"]));
    expect(result).toContain("Invalid argument");
  });
});

describe("TestAnsibleFilterExtended", () => {
  it("test_collapses_ok_lines", () => {
    const f = new bash_compress.AnsibleFilter();
    const oks: string[] = [];
    for (let i = 0; i < 20; i++) {
      oks.push(`ok: [host${i}]`);
    }
    const lines = ["PLAY [Deploy]", "TASK [Check service]", ...oks, "", "PLAY RECAP", "host0 : ok=1", ""];
    const stdout = lines.join("\n") + "\n";
    const result = _filter_text(f.apply(stdout, "", 0, ["ansible-playbook", "deploy.yml"]));
    const ok_line_count = (result.match(/ok: \[host/g) ?? []).length;
    expect(ok_line_count).toBeLessThan(20);
  });

  it("test_keeps_failed_lines", () => {
    const f = new bash_compress.AnsibleFilter();
    const stdout =
      "PLAY [Deploy]\n" +
      "TASK [Start service]\n" +
      'fatal: [web01]: FAILED! => {"msg": "Service not found"}\n' +
      "\n" +
      "PLAY RECAP\n" +
      "web01 : ok=0 changed=0 unreachable=0 failed=1\n";
    const result = _filter_text(f.apply(stdout, "", 2, ["ansible-playbook", "deploy.yml"]));
    expect(result.includes("FAILED") || result.includes("fatal")).toBe(true);
    expect(result).toContain("PLAY RECAP");
  });

  it("test_keeps_play_recap_section", () => {
    const f = new bash_compress.AnsibleFilter();
    const stdout =
      "PLAY [webservers]\n" +
      "TASK [Update packages]\n" +
      "ok: [web01]\n" +
      "ok: [web02]\n" +
      "\n" +
      "PLAY RECAP *************\n" +
      "web01 : ok=5 changed=2 unreachable=0 failed=0\n" +
      "web02 : ok=5 changed=1 unreachable=0 failed=0\n";
    const result = _filter_text(f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"]));
    expect(result).toContain("PLAY RECAP");
    expect(result).toContain("web01");
    expect(result).toContain("web02");
  });
});

describe("TestKubectlFilterExtended", () => {
  it("test_get_pods_preserves_header", () => {
    const f = new bash_compress.KubectlFilter();
    const rows = ["NAME                    READY   STATUS    RESTARTS   AGE"];
    for (let i = 0; i < 40; i++) {
      rows.push(`pod-${i}   1/1   Running   0   1h`);
    }
    const stdout = rows.join("\n") + "\n";
    const result = _filter_text(f.apply(stdout, "", 0, ["kubectl", "get", "pods"]));
    expect(result).toContain("NAME");
    expect(result).toContain("READY");
  });

  it("test_logs_compressed_to_head_tail", () => {
    const f = new bash_compress.KubectlLogsFilter();
    // Use 250 unique lines to trigger the >200 head+tail cap.
    const log_lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      const sec = String(i % 60).padStart(2, "0");
      log_lines.push(`2024-01-01 00:00:${sec} INFO unique-message-${i}`);
    }
    const stdout = log_lines.join("\n") + "\n";
    const result = _filter_text(f.apply(stdout, "", 0, ["kubectl", "logs", "my-pod"]));
    const result_lines = result
      .split("\n")
      .filter((ln) => ln.trim() && !ln.includes("token-goat"));
    expect(result_lines.length).toBeLessThan(250);
  });

  it("test_error_exit_preserves_stderr", () => {
    const f = new bash_compress.KubectlFilter();
    const stderr = 'Error from server (NotFound): pods "no-pod" not found\n';
    const result = _filter_text(f.apply("", stderr, 1, ["kubectl", "get", "pod", "no-pod"]));
    expect(result.includes("NotFound") || result.toLowerCase().includes("not found")).toBe(true);
  });
});
