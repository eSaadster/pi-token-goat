/**
 * Tests for the config CLI commands — TS port of tests/test_config_cli.py.
 *
 * Uses the `invoke` harness from tests/_cli_runner.ts (the TS analogue of
 * typer.testing.CliRunner). Test isolation comes from tests/setup.ts, which
 * sets a per-test throwaway data dir via setDataDirOverride(); since
 * configPath() = dataDir/config.toml, each test starts with NO config file
 * (defaults). `config set` writes to that tmp path.
 *
 * Tests that need a pre-seeded config.toml with specific content use the
 * `writeConfig` helper (mirrors tmp_path/"config.toml" + monkeypatch) which
 * writes a tmp file and redirects configPath() to it via setConfigPathOverride.
 *
 * The confirm-prompt seam (config reset, no --yes): the Python test fed
 * `input="n\n"`/`"y\n"` to the CliRunner. The TS harness spies stdout/stderr
 * but not stdin (real stdin blocks under vitest), so cli_config.ts exposes
 * `_setConfirmInput(fn)` — the test injects `() => false` (n) / `() => true` (y).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse as tomlParse } from "smol-toml";

import { invoke } from "./_cli_runner.js";
import * as config from "../src/token_goat/config.js";
import {
  clearConfigCache,
  load,
  defaultConfig,
  _KNOWN_SECTIONS,
} from "../src/token_goat/config.js";
import {
  clearConfigPathOverride,
  configPath,
  setConfigPathOverride,
} from "../src/token_goat/paths.js";
import {
  _coerce_config_value,
  _setConfirmInput,
} from "../src/token_goat/cli_config.js";

// ---------------------------------------------------------------------------
// Per-test helpers (mirrors tests/test_config.test.ts).
// ---------------------------------------------------------------------------

/**
 * Write `body` to a tmp config file and redirect configPath() to it.
 * Returns the file path. Mirrors the Python `tmp_path/"config.toml"` +
 * monkeypatch pattern.
 */
function writeConfig(body: string, name = "config.toml"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfgcli-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf8");
  setConfigPathOverride(file);
  return file;
}

beforeEach(() => {
  // setup.ts already clears caches + sets a fresh data dir; re-assert a cold
  // cache + no override + no injected confirm resolver explicitly.
  clearConfigCache();
  clearConfigPathOverride();
  _setConfirmInput(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearConfigPathOverride();
  clearConfigCache();
  _setConfirmInput(undefined);
});

// ===========================================================================
// config get / set round-trip
// ===========================================================================

describe("config get/set round-trip (port of test_config_cli.py)", () => {
  it("test_config_get_and_set_round_trip", async () => {
    let result = await invoke(["config", "get", "compact_assist.enabled"]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(true);

    result = await invoke(["config", "set", "compact_assist.enabled", "false"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("compact_assist.enabled");
    clearConfigCache();
    expect(load().compact_assist?.enabled).toBe(false);

    result = await invoke(["config", "set", "compact_assist.min_events", "9"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("compact_assist.min_events");
    clearConfigCache();
    expect(load().compact_assist?.min_events).toBe(9);

    result = await invoke(["config", "set", "compact_assist.triggers", "manual,auto"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("compact_assist.triggers");
    clearConfigCache();
    expect(load().compact_assist?.triggers).toEqual(["manual", "auto"]);
  });

  it("test_config_get_unknown_key_exits_2", async () => {
    const result = await invoke(["config", "get", "compact_assist.does_not_exist"]);
    expect(result.exit_code).toBe(2);
    const combined = (result.stdout || "") + (result.stderr || "");
    expect(combined.toLowerCase()).toContain("config key");
  });

  it("test_config_set_unknown_key_exits_2", async () => {
    const result = await invoke(["config", "set", "compact_assist.no_such_field", "42"]);
    expect(result.exit_code).toBe(2);
  });

  it("test_config_set_invalid_bool_value_exits_2", async () => {
    const result = await invoke(["config", "set", "compact_assist.enabled", "maybe"]);
    expect(result.exit_code).toBe(2);
  });

  it("test_config_set_invalid_int_value_exits_2", async () => {
    const result = await invoke(["config", "set", "compact_assist.min_events", "not_a_number"]);
    expect(result.exit_code).toBe(2);
  });

  it("test_config_get_nested_int_key", async () => {
    const result = await invoke(["config", "get", "compact_assist.max_manifest_tokens"]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(400);
  });

  it("test_config_set_max_manifest_tokens_round_trip", async () => {
    let result = await invoke(["config", "set", "compact_assist.max_manifest_tokens", "250"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("compact_assist.max_manifest_tokens");
    expect(result.stdout).toContain("250");
    clearConfigCache();
    expect(load().compact_assist?.max_manifest_tokens).toBe(250);

    // Read it back via CLI to confirm persistence.
    result = await invoke(["config", "get", "compact_assist.max_manifest_tokens"]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(250);
  });

  it("test_config_get_section_returns_json_object", async () => {
    const result = await invoke(["config", "get", "compact_assist"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toBeTypeOf("object");
    expect(data).not.toBeNull();
    expect("enabled" in (data as object)).toBe(true);
    expect("triggers" in (data as object)).toBe(true);
    expect("min_events" in (data as object)).toBe(true);
    expect("max_manifest_tokens" in (data as object)).toBe(true);
  });

  it("test_config_set_triggers_json_list_syntax", async () => {
    const result = await invoke([
      "config",
      "set",
      "compact_assist.triggers",
      '["manual"]',
    ]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("compact_assist.triggers");
    clearConfigCache();
    expect(load().compact_assist?.triggers).toEqual(["manual"]);
  });

  it("test_config_set_enabled_truthy_variants", async () => {
    for (const truthy of ["yes", "on", "1", "true"]) {
      // First disable.
      await invoke(["config", "set", "compact_assist.enabled", "false"]);
      const result = await invoke(["config", "set", "compact_assist.enabled", truthy]);
      expect(result.exit_code).toBe(0);
      clearConfigCache();
      expect(load().compact_assist?.enabled).toBe(true);
    }
  });

  it("test_config_set_enabled_falsy_variants", async () => {
    for (const falsy of ["no", "off", "0", "false"]) {
      // First enable.
      await invoke(["config", "set", "compact_assist.enabled", "true"]);
      const result = await invoke(["config", "set", "compact_assist.enabled", falsy]);
      expect(result.exit_code).toBe(0);
      clearConfigCache();
      expect(load().compact_assist?.enabled).toBe(false);
    }
  });
});

// ===========================================================================
// _coerce_config_value unit tests (internal helper branches)
// ===========================================================================

describe("_coerce_config_value (port of test_config_cli.py unit tests)", () => {
  it("test_coerce_config_value_empty_string_becomes_empty_list", () => {
    const result = _coerce_config_value(["manual"], "");
    expect(result).toEqual([]);
  });

  it("test_coerce_config_value_comma_separated_list", () => {
    const result = _coerce_config_value(["manual"], "manual, auto");
    expect(result).toEqual(["manual", "auto"]);
  });

  it("test_coerce_config_value_json_list_strips_inner_quotes", () => {
    const result = _coerce_config_value(["manual"], '["manual", "auto"]');
    expect(result).toEqual(["manual", "auto"]);
  });
});

// ===========================================================================
// config list
// ===========================================================================

describe("config list (port of test_config_cli.py)", () => {
  it("test_config_list_shows_all_keys", async () => {
    const result = await invoke(["config", "list"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("compact_assist.enabled");
    expect(result.stdout).toContain("compact_assist.triggers");
    expect(result.stdout).toContain("compact_assist.min_events");
    expect(result.stdout).toContain("compact_assist.max_manifest_tokens");
  });

  it("test_config_list_shows_defaults", async () => {
    const result = await invoke(["config", "list"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("default:");
  });

  it("test_config_list_json_output", async () => {
    const result = await invoke(["config", "list", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toBeTypeOf("object");
    expect("compact_assist.enabled" in (data as object)).toBe(true);
    const entry = (data as Record<string, { value: unknown; default: unknown }>)[
      "compact_assist.enabled"
    ]!;
    expect("value" in entry).toBe(true);
    expect("default" in entry).toBe(true);
    expect(entry.value).toBe(true);
    expect(entry.default).toBe(true);
  });

  it("test_config_list_json_shows_changed_values", async () => {
    await invoke(["config", "set", "compact_assist.min_events", "99"]);
    const result = await invoke(["config", "list", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.stdout) as Record<string, { value: unknown; default: unknown }>;
    expect(data["compact_assist.min_events"]!.value).toBe(99);
    expect(data["compact_assist.min_events"]!.default).toBe(3);
  });

  it("test_config_list_marks_changed_keys", async () => {
    await invoke(["config", "set", "compact_assist.enabled", "false"]);
    const result = await invoke(["config", "list"]);
    expect(result.exit_code).toBe(0);
    const changedLine = result.stdout
      .split("\n")
      .find((ln) => ln.includes("compact_assist.enabled"));
    expect(changedLine).toBeDefined();
    expect(changedLine!.startsWith("*")).toBe(true);
  });
});

// ===========================================================================
// config validate
// ===========================================================================

describe("TestConfigValidate (port of test_config_cli.py)", () => {
  it("test_no_config_file_reports_ok", async () => {
    const result = await invoke(["config", "validate", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(true);
  });

  it("test_empty_config_reports_ok", async () => {
    writeConfig("");
    const result = await invoke(["config", "validate", "--json"]);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  it("test_all_known_section_keys_pass", async () => {
    // Build a TOML file that contains all 11 validated sections with their
    // default fields. Each section's fields come from defaultConfig().
    const defaults = defaultConfig();
    const sections = [
      "compact_assist",
      "bash_compress",
      "session_brief",
      "skill_preservation",
      "image_shrink",
      "curator",
      "hint_budget",
      "hints",
      "repomap",
      "stats",
      "webfetch",
    ] as const;

    const lines = ["schema_version = 1\n"];
    for (const section of sections) {
      lines.push(`[${section}]\n`);
      const sec = (defaults as unknown as Record<string, Record<string, unknown>>)[section]!;
      for (const [field, val] of Object.entries(sec)) {
        lines.push(_tomlLine(field, val));
      }
    }
    writeConfig(lines.join(""));
    const result = await invoke(["config", "validate", "--json"]);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(true);
  });

  it("test_unknown_top_level_key_flagged", async () => {
    writeConfig("[compac_assist]\nenabled = true\n");
    const result = await invoke(["config", "validate", "--json"]);
    expect(result.exit_code).toBe(1);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(false);
    expect(data.issues.some((i: { key: string }) => i.key.includes("compac_assist"))).toBe(true);
    expect(
      data.issues.some((i: { suggestion?: string }) =>
        (i.suggestion ?? "").includes("compact_assist"),
      ),
    ).toBe(true);
  });

  it("test_unknown_section_sub_key_flagged", async () => {
    writeConfig("[compact_assist]\nmin_eventss = 5\n");
    const result = await invoke(["config", "validate", "--json"]);
    expect(result.exit_code).toBe(1);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(false);
    expect(data.issues.some((i: { key: string }) => i.key.includes("min_eventss"))).toBe(true);
    expect(
      data.issues.some((i: { suggestion?: string }) =>
        (i.suggestion ?? "").includes("min_events"),
      ),
    ).toBe(true);
  });

  it("test_hints_and_webfetch_sections_accepted", async () => {
    writeConfig("[hints]\njson_sidecar = true\n\n[webfetch]\nmax_file_count = 1000\n");
    const result = await invoke(["config", "validate", "--json"]);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(true);
  });

  it("test_validate_known_top_level_matches_config_known_sections", async () => {
    // Build a TOML file containing every section in _KNOWN_SECTIONS (minus
    // schema_version) with its default fields, then validate. Guards against a
    // new section landing in _KNOWN_SECTIONS without the validate path accepting it.
    const defaults = defaultConfig();
    const knownNoSchema = [..._KNOWN_SECTIONS].filter((s) => s !== "schema_version");
    const lines = ["schema_version = 1\n"];
    for (const section of knownNoSchema) {
      lines.push(`[${section}]\n`);
      const sec = (defaults as unknown as Record<string, Record<string, unknown>>)[section];
      // Some _KNOWN_SECTIONS (e.g. those added in TS but not in the Python
      // defaults) may be absent from defaultConfig(); emit an empty section so
      // the top-level key is still accepted (no sub-keys to check).
      if (sec !== undefined) {
        for (const [field, val] of Object.entries(sec)) {
          lines.push(_tomlLine(field, val));
        }
      }
    }
    writeConfig(lines.join(""));
    const result = await invoke(["config", "validate", "--json"]);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(true);
  });
});

// ===========================================================================
// config get (no-arg — TOML dump)
// ===========================================================================

describe("config get no-arg (port of test_config_cli.py)", () => {
  it("test_config_get_no_arg_dumps_toml", async () => {
    const result = await invoke(["config", "get"]);
    expect(result.exit_code).toBe(0);
    const parsed = tomlParse(result.stdout) as Record<string, unknown>;
    expect("compact_assist" in parsed).toBe(true);
    expect("bash_compress" in parsed).toBe(true);
    expect("hints" in parsed).toBe(true);
  });

  it("test_config_get_no_arg_reflects_changed_value", async () => {
    await invoke(["config", "set", "compact_assist.min_events", "7"]);
    const result = await invoke(["config", "get"]);
    expect(result.exit_code).toBe(0);
    const parsed = tomlParse(result.stdout) as Record<string, Record<string, unknown>>;
    expect(parsed["compact_assist"]!["min_events"]).toBe(7);
  });
});

// ===========================================================================
// config set output format
// ===========================================================================

describe("config set output format (port of test_config_cli.py)", () => {
  it("test_config_set_output_format", async () => {
    const result = await invoke(["config", "set", "compact_assist.min_events", "11"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("Set compact_assist.min_events = 11");
  });

  it("test_config_set_bool_output_format", async () => {
    const result = await invoke(["config", "set", "compact_assist.enabled", "false"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("Set compact_assist.enabled = false");
  });
});

// ===========================================================================
// config path
// ===========================================================================

describe("config path (port of test_config_cli.py)", () => {
  it("test_config_path_prints_path", async () => {
    const result = await invoke(["config", "path"]);
    expect(result.exit_code).toBe(0);
    const output = result.stdout.trim();
    expect(output.length).toBeGreaterThan(0);
    const lower = output.toLowerCase();
    expect(
      lower.includes("config") || lower.includes("token") || lower.includes("goat"),
    ).toBe(true);
  });
});

// ===========================================================================
// config reset
// ===========================================================================

describe("config reset (port of test_config_cli.py)", () => {
  it("test_config_reset_single_key", async () => {
    await invoke(["config", "set", "compact_assist.min_events", "99"]);
    clearConfigCache();
    expect(load().compact_assist?.min_events).toBe(99);

    const result = await invoke(["config", "reset", "compact_assist.min_events"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("compact_assist.min_events");
    clearConfigCache();
    expect(load().compact_assist?.min_events).toBe(3); // default
  });

  it("test_config_reset_all_with_yes_flag", async () => {
    await invoke(["config", "set", "compact_assist.min_events", "99"]);
    expect(fs.existsSync(configPath())).toBe(true);

    const result = await invoke(["config", "reset", "--yes"]);
    expect(result.exit_code).toBe(0);
    expect(fs.existsSync(configPath())).toBe(false);
    clearConfigCache();
    expect(load().compact_assist?.min_events).toBe(3); // default restored
  });

  it("test_config_reset_all_prompts_confirmation", async () => {
    await invoke(["config", "set", "compact_assist.min_events", "55"]);
    expect(fs.existsSync(configPath())).toBe(true);

    // Simulate user typing 'n' at the prompt → injected confirm returns false.
    _setConfirmInput(() => false);
    const result = await invoke(["config", "reset"]);
    expect(result.exit_code).toBe(0);
    expect(fs.existsSync(configPath())).toBe(true); // file still there
    clearConfigCache();
    expect(load().compact_assist?.min_events).toBe(55); // unchanged
  });

  it("test_config_reset_all_no_file_is_noop", async () => {
    const result = await invoke(["config", "reset", "--yes"]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("default");
  });

  it("test_config_reset_unknown_key_exits_2", async () => {
    const result = await invoke(["config", "reset", "compact_assist.no_such_field"]);
    expect(result.exit_code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a `<field> = <value>` TOML line for a default config value.
 *
 * Mirrors the Python test's dataclass-field → TOML renderer: bool → true/false,
 * number → bare, array → `[.., ..]`, string → `"<val>"`.
 */
function _tomlLine(field: string, val: unknown): string {
  if (typeof val === "boolean") return `${field} = ${val ? "true" : "false"}\n`;
  if (typeof val === "number") return `${field} = ${val}\n`;
  if (Array.isArray(val)) {
    const items = val.map((x) => `"${x}"`).join(", ");
    return `${field} = [${items}]\n`;
  }
  if (typeof val === "string") return `${field} = "${val}"\n`;
  // Objects / null / undefined are not emitted by the Python test (no section
  // contains a nested object). Skip defensively.
  return "";
}

// Keep the `config` namespace import live (used by type reasoning in tests).
void config;
