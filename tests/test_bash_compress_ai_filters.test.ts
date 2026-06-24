/**
 * Tests for AiderFilter, GhCopilotFilter, GeminiCliFilter, and ClaudeCliFilter.
 *
 * 1:1 port of tests/test_bash_compress_ai_filters.py. Every Python `def
 * test_*` maps to a vitest `it()` with the SAME name and assertion polarity.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports AiderFilter / GhCopilotFilter / GeminiCliFilter /
 *        ClaudeCliFilter + select_filter / detect_from_command + the FILTERS
 *        registry + the __all__ array).
 *  - `from tests.filter_test_helpers import apply_filter, savings_ratio`
 *      -> local `_apply(...)` / `_savings_ratio(...)` helpers below. `_apply`
 *        runs `filter_.apply(stdout, stderr, exit_code, argv).text`; when argv
 *        is omitted the filter's own `.name` is the sole argv element (matching
 *        filter_test_helpers.apply_filter exactly). `_savings_ratio` returns
 *        `filter_.apply(...).percent_saved / 100.0`.
 *
 * Byte-exactness: assertions are substring `in` / `not in` checks and
 * `percent_saved` ratio comparisons. The fixtures use box-drawing glyphs (✓ ◆ ◎)
 * and non-ASCII but each is a single BMP code point, so Python `len` (code
 * points) equals JS `.length`; no Buffer arithmetic is needed. U+2028 / U+2029
 * never appear in the fixtures (they are line terminators in TS source).
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  AiderFilter,
  ClaudeCliFilter,
  GeminiCliFilter,
  GhCopilotFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local helpers — port of tests/filter_test_helpers.py (apply_filter +
// savings_ratio). When argv is omitted the filter's own `.name` is the sole
// argv element (matching the Python helper's default exactly).
// ---------------------------------------------------------------------------
function _apply(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

function _savings_ratio(
  filter_: Filter,
  opts: { stdout: string; stderr?: string; argv?: string[] },
): number {
  const stdout = opts.stdout;
  const stderr = opts.stderr ?? "";
  const argv = opts.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, 0, argv).percent_saved / 100.0;
}

// ===========================================================================
// AiderFilter
// ===========================================================================

const _AIDER_VERBOSE = `aider v0.52.1
Aider v0.52.1
Add .aider* to .gitignore (recommended)? (Y)es/(N)o [Yes]:
Tokens: 12345 sent, 1234 received. Cost: $0.0456 message, $0.1234 session.
Repo-map: using 4096 tokens, auto refresh
Loading repo map
Added src/auth.py to the chat.
> Apply these edits to src/auth.py?
Applying edits...
Applying edits...
Applying edits...
Applying edits...
src/auth.py: Updated login() function
Use ctrl-c to interrupt
Tip: Use /ask to ask questions without editing code
Note: Run aider --help for usage
`;

const _AIDER_DIFF_OUTPUT = `aider v0.52.1
Tokens: 5000 sent, 500 received. Cost: $0.0200 message, $0.0500 session.
Repo-map: using 2048 tokens, auto refresh
Loading repo map
Added src/utils.py to the chat.

src/utils.py
<<<<<<< SEARCH
def old_function():
    pass
=======
def new_function():
    return "improved"
>>>>>>> REPLACE

Applying edits...
Applying edits...
Use ctrl-c to interrupt
`;

const _AIDER_ERROR = `aider v0.52.1
Tokens: 1000 sent, 100 received.
Error: File not found: missing.py
`;

describe("TestAiderFilter", () => {
  it("test_aider_filter_matches", () => {
    const f = new AiderFilter();
    expect(f.matches(["aider"])).toBe(true);
    expect(f.matches(["aider", "--model", "claude-3-5-sonnet"])).toBe(true);
    expect(f.matches(["npm", "run", "aider"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  it("test_aider_drops_noise", () => {
    const out = _apply(new AiderFilter(), { stdout: _AIDER_VERBOSE });
    // token/cost lines should be summarised, not dropped
    expect(out.includes("0.0456") || out.toLowerCase().includes("cost")).toBe(true);
    // noise dropped
    expect(out).not.toContain("Loading repo map");
    expect(out).not.toContain("Repo-map:");
    expect(out).not.toContain("aider v0.52");
    expect(out).not.toContain("ctrl-c");
    expect(out).not.toContain("Tip:");
    // edit kept
    expect(out).toContain("src/auth.py");
  });

  it("test_aider_collapses_applying_edits", () => {
    const out = _apply(new AiderFilter(), { stdout: _AIDER_VERBOSE });
    // 4 "Applying edits" lines -> single collapsed line
    expect(out.toLowerCase().includes("applying edits") || out.includes("token-goat")).toBe(true);
  });

  it("test_aider_preserves_diff_headers", () => {
    const out = _apply(new AiderFilter(), { stdout: _AIDER_DIFF_OUTPUT });
    expect(
      out.includes("SEARCH") || out.includes("REPLACE") || out.includes("src/utils.py"),
    ).toBe(true);
  });

  it("test_aider_preserves_error_on_failure", () => {
    const out = _apply(new AiderFilter(), { stdout: _AIDER_ERROR, exit_code: 1 });
    expect(out.includes("Error") || out.includes("missing.py")).toBe(true);
  });

  it("test_aider_savings", () => {
    const ratio = _savings_ratio(new AiderFilter(), { stdout: _AIDER_VERBOSE });
    expect(ratio).toBeGreaterThanOrEqual(0.25);
  });
});

// ===========================================================================
// GhCopilotFilter
// ===========================================================================

const _GH_COPILOT_EXPLAIN = `Welcome to GitHub Copilot in the CLI!
version 1.0.0 (2024-01-15)
Authenticated as octocat

Asking GitHub Copilot...
Generating...

Explanation:

  • git rebase rewrites commit history by moving commits to a new base.
  • Use it to maintain a linear project history.
  • Common usage: git rebase main

Disclaimer: This response was provided by an AI model and may be incorrect.
Always review generated content before applying it.
Note: Use /help to see all available commands.
`;

const _GH_COPILOT_SUGGEST = `Welcome to GitHub Copilot in the CLI!
Authenticated as octocat

Asking GitHub Copilot...
Thinking...

  grep -r "TODO" --include="*.py" .

Disclaimer: This response was provided by an AI model.
Please review the command before running it.
The commands above are suggestions. Always review.
`;

const _GH_COPILOT_NOT_COPILOT = `Usage:
  gh [command]

Available Commands:
  auth        Authenticate gh and git with GitHub
  pr          Manage pull requests
  issue       Manage issues
`;

describe("TestGhCopilotFilter", () => {
  it("test_gh_copilot_filter_matches", () => {
    const f = new GhCopilotFilter();
    expect(f.matches(["gh", "copilot", "explain", "git rebase"])).toBe(true);
    expect(f.matches(["gh", "copilot", "suggest", "list files"])).toBe(true);
    // Must NOT match plain gh commands
    expect(f.matches(["gh", "pr", "list"])).toBe(false);
    expect(f.matches(["gh"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  it("test_gh_copilot_drops_spinner_and_banner", () => {
    const out = _apply(new GhCopilotFilter(), {
      stdout: _GH_COPILOT_EXPLAIN,
      argv: ["gh", "copilot", "explain", "what is git rebase"],
    });
    expect(out).not.toContain("Welcome to GitHub Copilot");
    expect(out).not.toContain("Asking GitHub Copilot");
    expect(out).not.toContain("Authenticated as");
  });

  it("test_gh_copilot_drops_disclaimer", () => {
    const out = _apply(new GhCopilotFilter(), {
      stdout: _GH_COPILOT_EXPLAIN,
      argv: ["gh", "copilot", "explain", "git rebase"],
    });
    expect(out).not.toContain("Disclaimer");
    expect(out).not.toContain("Always review");
  });

  it("test_gh_copilot_keeps_body", () => {
    const out = _apply(new GhCopilotFilter(), {
      stdout: _GH_COPILOT_EXPLAIN,
      argv: ["gh", "copilot", "explain", "git rebase"],
    });
    expect(out).toContain("git rebase");
    expect(out).toContain("linear project history");
  });

  it("test_gh_copilot_suggest_keeps_command", () => {
    const out = _apply(new GhCopilotFilter(), {
      stdout: _GH_COPILOT_SUGGEST,
      argv: ["gh", "copilot", "suggest", "find TODOs"],
    });
    expect(out).toContain("grep");
  });

  it("test_gh_copilot_savings", () => {
    const ratio = _savings_ratio(new GhCopilotFilter(), {
      stdout: _GH_COPILOT_EXPLAIN,
      argv: ["gh", "copilot", "explain", "git rebase"],
    });
    expect(ratio).toBeGreaterThanOrEqual(0.3);
  });
});

// ===========================================================================
// GeminiCliFilter
// ===========================================================================

const _GEMINI_CLI_SESSION = `Gemini CLI v0.1.5
✓ Model: gemini-2.5-pro
✓ Theme: Default
✓ Tools: 8 tools enabled
✓ Sandbox: off
✓ Checkpointing: off
✓ Context limit: 1,048,576

Thinking...

The current directory contains 42 Python files.
The main entry point is src/main.py.

Token usage: 12345 / 1048576 (1%)
Type /help for commands. Press Ctrl-C to exit.
`;

const _GEMINI_CLI_WITH_TOOLS = `Gemini CLI v0.1.5
✓ Model: gemini-2.5-pro
✓ Context limit: 1,048,576

✓ Called read_file(path='src/main.py')
⠋ Calling run_shell_command(command='pytest')
⠙ Calling run_shell_command(command='ls -la')

The test suite passes with 98% coverage.

Token usage: 45678 / 1048576 (4%)
`;

const _GEMINI_CLI_ERROR = `Gemini CLI v0.1.5
✓ Model: gemini-2.5-pro
Error: Rate limit exceeded. Please retry after 60 seconds.
`;

describe("TestGeminiCliFilter", () => {
  it("test_gemini_cli_filter_matches", () => {
    const f = new GeminiCliFilter();
    expect(f.matches(["gemini"])).toBe(true);
    expect(f.matches(["gemini", "-p", "explain this code"])).toBe(true);
    expect(f.matches(["npm"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  it("test_gemini_cli_drops_startup_block", () => {
    const out = _apply(new GeminiCliFilter(), { stdout: _GEMINI_CLI_SESSION });
    expect(out).not.toContain("Gemini CLI v0.1.5");
    expect(out).not.toContain("✓ Model:");
    expect(out).not.toContain("✓ Theme:");
    expect(out).not.toContain("Thinking...");
    expect(out).not.toContain("Type /help");
  });

  it("test_gemini_cli_collapses_startup_to_summary", () => {
    const out = _apply(new GeminiCliFilter(), { stdout: _GEMINI_CLI_SESSION });
    expect(out.toLowerCase().includes("startup") || out.includes("token-goat")).toBe(true);
  });

  it("test_gemini_cli_keeps_context_meter", () => {
    const out = _apply(new GeminiCliFilter(), { stdout: _GEMINI_CLI_SESSION });
    // Last token-usage meter should be surfaced
    expect(out.includes("12345") || out.toLowerCase().includes("context")).toBe(true);
  });

  it("test_gemini_cli_collapses_tool_spinners", () => {
    const out = _apply(new GeminiCliFilter(), { stdout: _GEMINI_CLI_WITH_TOOLS });
    // Spinner lines collapsed
    expect(out).not.toContain("⠋ Calling");
    expect(out).not.toContain("⠙ Calling");
    // But the count or summary should appear
    expect(
      out.includes("token-goat") ||
        out.toLowerCase().includes("spinner") ||
        out.toLowerCase().includes("tool"),
    ).toBe(true);
  });

  it("test_gemini_cli_keeps_response_body", () => {
    const out = _apply(new GeminiCliFilter(), { stdout: _GEMINI_CLI_SESSION });
    expect(out).toContain("42 Python files");
    expect(out).toContain("src/main.py");
  });

  it("test_gemini_cli_preserves_error", () => {
    const out = _apply(new GeminiCliFilter(), { stdout: _GEMINI_CLI_ERROR, exit_code: 1 });
    expect(out.includes("Rate limit") || out.includes("Error")).toBe(true);
  });

  it("test_gemini_cli_savings", () => {
    const ratio = _savings_ratio(new GeminiCliFilter(), { stdout: _GEMINI_CLI_SESSION });
    expect(ratio).toBeGreaterThanOrEqual(0.15);
  });
});

// ===========================================================================
// ClaudeCliFilter
// ===========================================================================

const _CLAUDE_CLI_SESSION = `◆ claude-sonnet-4-5 (API)

Context: 45678 / 200000 (23%)
◎ Thinking...

The function \`process_data\` in src/pipeline.py handles the ETL pipeline.
It reads from S3, transforms using Pandas, and writes to PostgreSQL.

↑ 5432 ↓ 890 tokens · $0.0123
Press Ctrl-C to stop
Enter / to show menu
`;

const _CLAUDE_CLI_WITH_TOOLS = `◆ claude-sonnet-4-5 (API)

> Using tool: Read(file_path='src/pipeline.py')
✓ Tool result: [2847 chars]
> Using tool: Bash(command='pytest tests/test_pipeline.py -v')
✓ Tool result: [1234 chars]
◎ Tool: Write

All tests pass. The pipeline processes 10k records/second.

↑ 12000 ↓ 2500 tokens · $0.0456
Context: 89000 / 200000 (45%)
`;

const _CLAUDE_CLI_SKIP_SUBCMDS: string[][] = [
  ["claude", "install"],
  ["claude", "update"],
  ["claude", "doctor"],
  ["claude", "config"],
  ["claude", "login"],
  ["claude", "logout"],
];

describe("TestClaudeCliFilter", () => {
  it("test_claude_cli_filter_matches", () => {
    const f = new ClaudeCliFilter();
    expect(f.matches(["claude"])).toBe(true);
    expect(f.matches(["claude", "--print", "explain this"])).toBe(true);
    expect(f.matches(["claude", "-p", "explain this"])).toBe(true);
    expect(f.matches(["claude-code"])).toBe(false);
    expect(f.matches(["npm"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  it("test_claude_cli_filter_skips_subcommands", () => {
    const f = new ClaudeCliFilter();
    for (const argv of _CLAUDE_CLI_SKIP_SUBCMDS) {
      expect(f.matches(argv)).toBe(false);
    }
  });

  it("test_claude_cli_drops_session_header", () => {
    const out = _apply(new ClaudeCliFilter(), { stdout: _CLAUDE_CLI_SESSION });
    expect(out).not.toContain("◆ claude-sonnet");
  });

  it("test_claude_cli_drops_spinner", () => {
    const out = _apply(new ClaudeCliFilter(), { stdout: _CLAUDE_CLI_SESSION });
    expect(out).not.toContain("◎ Thinking");
  });

  it("test_claude_cli_drops_footer", () => {
    const out = _apply(new ClaudeCliFilter(), { stdout: _CLAUDE_CLI_SESSION });
    expect(out).not.toContain("Press Ctrl-C");
    expect(out).not.toContain("Enter / to show menu");
  });

  it("test_claude_cli_keeps_response_body", () => {
    const out = _apply(new ClaudeCliFilter(), { stdout: _CLAUDE_CLI_SESSION });
    expect(out).toContain("process_data");
    expect(out).toContain("ETL pipeline");
  });

  it("test_claude_cli_keeps_stats_and_context", () => {
    const out = _apply(new ClaudeCliFilter(), { stdout: _CLAUDE_CLI_SESSION });
    // Last stats/context should appear as notes
    expect(
      out.includes("5432") ||
        out.toLowerCase().includes("stats") ||
        out.toLowerCase().includes("token"),
    ).toBe(true);
  });

  it("test_claude_cli_collapses_tool_log", () => {
    const out = _apply(new ClaudeCliFilter(), { stdout: _CLAUDE_CLI_WITH_TOOLS });
    expect(out).not.toContain("> Using tool:");
    expect(out).not.toContain("✓ Tool result:");
    // Should have collapsed summary
    expect(out.toLowerCase()).toContain("tool");
  });

  it("test_claude_cli_savings", () => {
    const ratio = _savings_ratio(new ClaudeCliFilter(), { stdout: _CLAUDE_CLI_SESSION });
    expect(ratio).toBeGreaterThanOrEqual(0.08);
  });
});

// ===========================================================================
// FILTERS list registration + dispatch
// ===========================================================================

describe("TestAiFiltersRegistration", () => {
  it("test_ai_filters_registered", () => {
    // All AI tool filters appear in the FILTERS dispatch list.
    const names = new Set(bc.FILTERS.map((f) => f.name));
    expect(names.has("aider")).toBe(true);
    expect(names.has("gh-copilot")).toBe(true);
    expect(names.has("gemini-cli")).toBe(true);
    expect(names.has("claude-cli")).toBe(true);
  });

  it("test_ai_filters_in_all_exports", () => {
    // AI filter classes exported via __all__.
    expect(bc.__all__).toContain("AiderFilter");
    expect(bc.__all__).toContain("GhCopilotFilter");
    expect(bc.__all__).toContain("GeminiCliFilter");
    expect(bc.__all__).toContain("ClaudeCliFilter");
  });

  it("test_dispatch_routes_aider", () => {
    const result = bc.detect_from_command("aider --model gpt-4o");
    expect(result).not.toBeNull();
    const [filter_ /* , _argv */] = result!;
    expect(filter_.name).toBe("aider");
  });

  it("test_dispatch_routes_gemini_cli", () => {
    const result = bc.detect_from_command("gemini -p 'explain this code'");
    expect(result).not.toBeNull();
    const [filter_ /* , _argv */] = result!;
    expect(filter_.name).toBe("gemini-cli");
  });

  it("test_dispatch_routes_claude_cli", () => {
    const result = bc.detect_from_command("claude --print 'what does this do'");
    expect(result).not.toBeNull();
    const [filter_ /* , _argv */] = result!;
    expect(filter_.name).toBe("claude-cli");
  });

  it("test_dispatch_routes_gh_copilot_explain", () => {
    const result = bc.detect_from_command("gh copilot explain 'git rebase'");
    expect(result).not.toBeNull();
    const [filter_ /* , _argv */] = result!;
    expect(filter_.name).toBe("gh-copilot");
  });

  it("test_dispatch_does_not_route_gh_pr", () => {
    // gh pr list should NOT route to GhCopilotFilter
    const result = bc.detect_from_command("gh pr list");
    if (result !== null) {
      expect(result[0]!.name).not.toBe("gh-copilot");
    }
  });
});
