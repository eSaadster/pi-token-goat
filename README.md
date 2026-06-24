# Token-Goat · TypeScript Port

> **85%** smaller reads · **97.4%** image compression · **130+** bash output filters · **94–99%** skill overhead cut · compaction memory

**A line-for-line faithful TypeScript port of [token-goat](https://github.com/DFKHelper/token-goat) — the AI token optimizer that cuts LLM costs 40–90% — designed to run natively in Node.js + the [pi coding agent](https://github.com/earendil-works/pi-mono) ecosystem.**

[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-lightgrey)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-5.7-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Built with esbuild](https://img.shields.io/badge/built%20with-esbuild-FFCF00?logo=esbuild&logoColor=black)](package.json)
[![Tests](https://img.shields.io/badge/tests-280%2B%20(vitest)-6B9FA8)](#tests)

---

## Why a TypeScript Port?

The original [token-goat](https://pypi.org/project/token-goat/) is a Python CLI tool that sits between AI coding agents and their tool executions to dramatically reduce token waste. It:

- **Blocks redundant file re-reads** with a one-line hint instead of re-sending the whole file
- **Surgically extracts** one function/class instead of reading the entire file
- **Compresses bash output** by stripping progress bars, passing tests, and noise — keeping only errors and meaningful output
- **Shrinks screenshots 97%** before they reach the context window
- **Compacts long sessions** into a structured manifest of edited files and key symbols
- **Applies skill compaction** to cut skill/instruction overhead by 94–99%

This TypeScript port exists because:

### 🎯 Native pi Integration

[pi](https://github.com/earendil-works/pi-mono) is a TypeScript/Node.js coding agent. Running a Python CLI from pi requires a subprocess hop — every tool call forks a Python process, which adds latency and complexity. This port embeds token-goat **directly as a TypeScript extension** (`token-goat.ts`) that hooks into pi's native event system (`tool_call`, `tool_result`, `session_before_compact`, …) — zero subprocess overhead, zero Python dependency. The extension is a thin bridge: pi events → token-goat hook engine → transformed outputs.

### 🚀 Performance

- **No subprocess hop** — every tool call stays in-process. The Python version requires `uv run token-goat ...` for each hook invocation.
- **Single runtime** — install Node.js and you're done. No Python, no uv, no venv.
- **Lower baseline memory** — the TS runtime is already loaded by pi; the Python runtime is an additional ~30–50 MB resident per invocation.
- **Async-native** — the CLI and hook dispatch are `async` throughout, using Node's event loop instead of `asyncio`.

### 🔧 Type Safety

- The Python version relies on runtime type hints (`TypedDict`, `dataclass`) with mypy for static analysis. The TS version gets **compile-time type checking** for every module — no `Any` leak, no `# type: ignore`, no runtime surprises.
- `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `strict: true` — the tsconfig is locked down so field access is always narrowed.

### 📦 Distribution

- **Single-file bundle** via esbuild (`dist/token-goat.mjs`, ~1.5 MB with all dependencies). Install with `npm install -g` or just drop the `.mjs` anywhere.
- The Python version requires `uv tool install token-goat` and the Python toolchain.

---

## How It Works

### Architecture

```
pi agent → extension hook (token-goat.ts)
              ↓
         hook_registry.ts  →  dispatches to the right hook handler
              ↓
    ╔═══════════════════════════════════════════╗
    ║           Hook Handlers                    ║
    ╠═══════════════════════════════════════════╣
    ║ pre_tool_use      →  deny re-reads,       ║
    ║                      inject surgical hints ║
    ║ post_tool_use     →  compress bash output, ║
    ║                      shrink screenshots    ║
    ║ pre_index         →  skip unchanged files  ║
    ║ pre_compact       →  attach session        ║
    ║                      manifest              ║
    ║ pre_skill_load    →  trim skill headers    ║
    ╚═══════════════════════════════════════════╝
              ↓
         Output transformation
              ↓
    ╔═══════════════════════════════════════════╗
    ║           Compression Engines              ║
    ╠═══════════════════════════════════════════╣
    ║ bash_compress.ts   →  130+ output filters ║
    ║ code_compress.ts   →  symbol extraction    ║
    ║ doc_compact.ts     →  document compaction  ║
    ║ image_shrink.ts    →  PNG/JPEG 97% shrink ║
    ║ compact.ts         →  session compression ║
    ╚═══════════════════════════════════════════╝
```

### Pipeline

1. **Tool call interceptor** — When the AI invokes a tool (e.g., `read`, `bash`, `screenshot`), pi fires a `pre_tool_use` event. The token-goat extension catches it and applies the relevant hook.

2. **Read optimization** — If the AI tries to re-read a file it already has in context, the hook returns a **deny** with a one-line hint (`"already read — here's line N"`) instead of letting the full file through. If the AI needs a specific symbol, the hook intercepts the read and returns **just that function/class**.

3. **Bash output compression** — After a `bash` command runs, `post_tool_use` fires. The hook passes the raw output through bash_compress.ts which runs 130+ regex/semantic filters:
   - Strips `npm install` progress bars and tree-print chains
   - Collapses `pytest` test-run output to only failures
   - Removes `cargo build` progress lines
   - Keeps errors, warnings, and meaningful output
   - **Typical reduction: 60–90%**

4. **Image shrinking** — Screenshots and images are compressed lossily (PNG → JPEG at 15% quality, or resized) before reaching the model. **Typical reduction: 97%** (10 MB → 300 KB).

5. **Session compaction** — Before compaction, token-goat builds a structured manifest: files edited, key symbols defined, remaining issues. This replaces free-form chat context loss with a precise summary.

6. **Skill compaction** — When loading skill/instruction files, token-goat strips boilerplate, examples, and redundancy. **Typical reduction: 94–99%** on multi-page skill docs.

### CLI

The port exposes the same command-line interface as the Python original:

```bash
token-goat install        # Install hooks into pi / Claude Code / etc.
token-goat stats          # Show token savings
token-goat doctor         # Diagnose installation issues
token-goat compact        # Compact a session
token-goat config         # View/edit configuration
token-goat index          # Manage file index
token-goat history        # Browse hook event history
# ... and 80+ more commands
```

CLI framework: **commander.js** (port of Python's `typer`/`click`).

---

## Comparison: Python vs TypeScript

| Feature | Python (upstream) | TypeScript (this port) |
|---|---|---|
| **Runtime** | Python 3.12+ + uv | Node.js 20+ |
| **Install** | `uv tool install token-goat` | `npm install -g token-goat` (or local) |
| **CLI framework** | typer (on click) | commander |
| **Config** | TOML via tomli/tomli-w | TOML via smol-toml |
| **Database** | sqlite3 (stdlib) | better-sqlite3 |
| **Entry point** | `python -m token_goat` | `node dist/token-goat.mjs` |
| **Bundle** | Python package (pip/uv) | Single .mjs file (~1.5 MB) |
| **Type checking** | mypy (optional, separate) | tsc (compile-time, always on) |
| **Async model** | asyncio | native Promise/async-await |
| **pi integration** | Subprocess via `uv run` | Native extension (in-process) |
| **Testing** | pytest | vitest |
| **Code coverage** | 2,800+ Python tests | 280+ TS tests (growing) |
| **Language parsers** | tree-sitter (native) | tree-sitter (wasm) |
| **Config env vars** | `TOKEN_GOAT_*` | `TOKEN_GOAT_*` (identical) |
| **Hook protocol** | stdin/stdout JSON | Node event emit (pi) + stdin/stdout (standalone) |
| **License** | PolyForm Noncommercial | PolyForm Noncommercial |

### Feature Parity

The TS port aims for **full feature parity** with the Python original. Currently ported:

- ✅ **Bash output compression** — 130+ filters, all categories (build, test, git, search, cloud, containers, security, …)
- ✅ **Code compression** — surgical symbol extraction for 25+ languages
- ✅ **Read optimization** — re-read denial + surgical slicing
- ✅ **Image shrinking** — lossy JPEG/PNG compression
- ✅ **Document compaction** — markdown/rST compression
- ✅ **Session compaction** — structured manifests
- ✅ **Skill compaction** — header trimming
- ✅ **Configuration** — TOML + env var overrides, same defaults
- ✅ **Database** — SQLite-backed caching, history, stats
- ✅ **CLI** — all 80+ commands ported
- ✅ **pi extension** — native event hooks
- ✅ **Indexer** — file index with symbol extraction
- ✅ **Web fetch** — URL content fetching
- ✅ **Memory pruning** — configurable context management
- ⏳ **Tree-sitter WASM parsers** — planned (Python uses native tree-sitter)
- ⏳ **Full test parity** — 280+ of ~2,800 tests ported

---

## Quick Start

### Prerequisites

- Node.js 20+
- npm

### Install from npm (once published)

```bash
npm install -g token-goat
token-goat install
```

### Install from source

```bash
git clone https://github.com/eSaadster/pi-token-goat.git
cd pi-token-goat
npm install
npm run build
npm link   # or: node dist/token-goat.mjs <command>
```

### For pi users

If you're using [pi](https://github.com/earendil-works/pi-mono), token-goat hooks are loaded automatically when the extension is installed:

```bash
token-goat install
# Restart pi — token savings are active immediately
```

---

## Tests

```bash
npm test            # Run all tests (vitest)
npm run test:watch  # Watch mode
npm run typecheck   # TypeScript type checking
```

The test suite mirrors the Python original's test structure:

- `tests/test_bash_compress_*.test.ts` — per-category bash filter tests
- `tests/test_parser_*.test.ts` — language parser tests
- `tests/test_cli_*.test.ts` — CLI command tests
- `tests/test_hooks_*.test.ts` — hook handler tests
- `tests/test_compact*.test.ts` — compaction tests
- `tests/test_session*.test.ts` — session management tests

---

## Project Structure

```
ts/
├── src/token_goat/          # Source code
│   ├── cli.ts               # CLI app (commander) — 80+ commands
│   ├── main.ts              # Entry point
│   ├── index.ts             # Public API surface
│   ├── config.ts            # TOML config loader
│   ├── types.ts             # Consolidated type definitions
│   ├── bash_compress/       # 130+ bash output filters
│   ├── languages/           # Language parsers (25+ languages)
│   ├── hooks_*.ts           # Hook handlers
│   ├── hook_registry.ts     # Event dispatch
│   └── render/              # Stats renderer
├── tests/                   # Test suite (280+ tests)
├── .pi/extensions/          # pi extension bridge
│   └── token-goat.ts        # Native pi integration
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## License

PolyForm Noncommercial — see [LICENSE](LICENSE).

---

## Acknowledgments

- **[DFKHelper](https://github.com/DFKHelper/token-goat)** — the original Python token-goat. All compression logic, filter patterns, and hook semantics originate from this project.
- **[pi-coding-agent](https://github.com/earendil-works/pi-mono)** — the TypeScript agent ecosystem that motivated this port.
