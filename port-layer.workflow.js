// token-goat-ts-port-layer — the repeatable execution engine for the Python->TS port.
// Ports ONE layer test-first, with adversarial parity verification per module.
// Invoke: Workflow({ scriptPath: "<repo>/ts/port-layer.workflow.js", args: { layer: 1 } })
// Returns structured file contents + parity verdicts. The main loop writes files,
// runs `tsc` + `vitest` + the parity harness, and reports. One layer per turn.

export const meta = {
  name: 'token-goat-ts-port-layer',
  description: 'Port one layer of token-goat Python->TS test-first, with adversarial parity verification per module',
  phases: [
    { title: 'Port', detail: 'per module: read py + its tests, produce faithful TS port + ported tests' },
    { title: 'Verify', detail: 'per module: adversarial parity review (off-by-one, float/regex/encoding, missing branches, un-reset globals)' },
  ],
}

const REPO = '/Users/saadfarooq/Documents/Projects/skills/token-goat'

// Layer -> modules (basenames relative to src/token_goat/). MEGA modules are split
// at the agent level (framework first; the agent notes what remains).
const LAYERS = {
  1: { name: 'Foundation', note: 'Every other module imports these. paths/util/project are the zero-dep root. Port the tmp_data_dir fixture as a vitest beforeEach. db uses better-sqlite3 sync API; sqlite-vec via loadExtension try/catch->embeddings_disabled.', modules: ['paths', 'util', 'project', 'config', 'db', 'render/ansi', 'render/types', '__init__', '__main__'] },
  2: { name: 'Caches + session + snapshots', note: 'Persistence core. cache_common is the shared spine — truncate_tail_preserve MUST slice on UTF-8 bytes via Buffer, not string indices. session CAS merge ports verbatim (NaN needs a JSON reviver).', modules: ['cache_common', 'web_cache', 'mcp_cache', 'doc_compact', 'notebook_compact', 'session', 'snapshots', 'project_memory'] },
  3: { name: 'Hook registry + common + dispatch + bridges', note: 'hook_registry is pure data (the root table). hooks_cli.dispatch runs each handler in a worker_thread with terminate-on-timeout (abandon semantics). The pi session-id sanitizer /[^A-Za-z0-9_-]/ EXCLUDES dot — load-bearing. Promote the 3 bridge TS string-literals to real .ts files.', modules: ['hook_registry', 'hooks_common', 'hooks_cli', 'bridges', 'overflow_guard'] },
  4: { name: 'Surgical read + hints + compact + resume + bash_compress', note: 'Highest logic density, pure-string. read_replacement is THE contract (AmbiguousFileMatch.code/candidates). bash_compress MEGA: port framework (Filter base, FILTERS registry, first-match dispatch, ~30 shared helpers, CompressedOutput) FIRST, then filters category-by-category using the ~74 test files as golden outputs.', modules: ['read_replacement', 'read_commands', 'hints', 'compact', 'resume', 'bash_compress', 'memory_prune', 'git_history', 'render/stats_renderer', 'render/common', 'render/stats_messages.json'] },
  5: { name: 'Hook handlers (13-event bodies)', note: 'hooks_read is MEGA (~40 _handle_* strategies) — port LAST. Port hook_helpers (make_large_jpeg via sharp, run_hook_subprocess via node spawn, assert_well_formed_unified_diff) first.', modules: ['hooks_session', 'hooks_edit', 'hooks_skill', 'hooks_fetch', 'hooks_read'] },
  6: { name: 'Image shrink + skill_cache + worker + install + autostart', note: 'OS-coupled / native. image_shrink uses sharp (format thresholds, content-addressed cache, vision_tokens formula). install: per-OS autostart — Windows needs a silent-launcher shim (.vbs) to avoid console flash at login; mac/linux are child_process spawns.', modules: ['image_shrink', 'skill_cache', 'worker', 'worker_daemon', 'install', 'baseline'] },
  7: { name: 'Tree-sitter index + repomap + embeddings + parser/languages + cli + stats + webfetch + gdrive', note: 'Hardest, most-isolated. PARALLEL: (a) 17 flat/regex language adapters FIRST to de-risk, then 9 grammar adapters (re-implement StructureKind taxonomy on web-tree-sitter); (b) embeddings verified within float-epsilon vs the SAME bge-small ONNX; (c) cli MEGA (73-command commander fan-out); (d) webfetch SSRF guard. Can ship disabled without blocking core.', modules: ['parser', 'languages/common', 'languages', 'repomap', 'embeddings', 'stats', 'cli_doctor', 'cli', 'cli_stats', 'cli_context_stats', 'webfetch', 'gdrive', 'read_commands'] },
}

const PORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    py_module: { type: 'string' },
    ts_path: { type: 'string', description: 'primary ts source path, e.g. ts/src/token_goat/paths.ts' },
    files: { type: 'array', description: 'COMPLETE file contents (src + ported tests), paths relative to repo root', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    test_files_ported: { type: 'array', items: { type: 'string' } },
    parity_notes: { type: 'string' },
    known_gaps: { type: 'string', description: 'behaviors NOT yet ported, with reason (esp. for MEGA modules)' },
  },
  required: ['py_module', 'ts_path', 'files', 'test_files_ported', 'parity_notes', 'known_gaps'],
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    py_module: { type: 'string' },
    critical_parity_issues: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, where: { type: 'string' }, description: { type: 'string' } }, required: ['severity', 'description'] } },
    verdict: { type: 'string', enum: ['pass', 'fix-needed'] },
    blocking_gaps: { type: 'string' },
  },
  required: ['py_module', 'critical_parity_issues', 'verdict', 'blocking_gaps'],
}

const PORT_PROMPT = (mod, layerNote) => `You are porting ONE Python module of token-goat to TypeScript, TEST-FIRST, as part of Layer: ${layerNote}

REPO: ${REPO}
1. Read the Python module IN FULL: ${REPO}/src/token_goat/${mod}.py
2. Find its tests: glob ${REPO}/tests/ for files covering this module (test_${mod.replace('/', '_')}*.py and related), read the most important ones.
3. Port the module FAITHFULLY to TypeScript at ts/src/token_goat/${mod}.ts (kebab-case the filename if it has underscores, e.g. cache_common -> cache-common.ts; preserve every behavior, threshold constant, regex, and branch). Match the existing seed style (see ${REPO}/ts/src/token_goat/entropy.ts): strict TS, ESM (.js import specifiers), sync-by-default.
4. Port its tests to vitest at ts/tests/ (test_${mod.replace('/', '_')}.test.ts), preserving every assertion's polarity and inline rationale. Use it.test.each for parametrize.
5. For MEGA modules (bash_compress ~26k LOC, cli ~8.6k, hooks_read ~7.9k): port the FRAMEWORK + shared machinery + a representative starter set ONLY, and list exactly what remains in known_gaps.

OUTPUT: ONLY a JSON object per schema. Every file content must be COMPLETE and valid (no "..." placeholders). ts_path = the primary source path. List covering tests actually read in test_files_ported.`

const VERIFY_PROMPT = (mod, portJson) => `You are an ADVERSARIAL PARITY REVIEWER. A module was just ported Python->TS. Hunt for behavioral drift that tests might miss. Default to skepticism.

REPO: ${REPO}
1. Read the Python: ${REPO}/src/token_goat/${mod}.py
2. Read the proposed TS port + its tests from this JSON: ${JSON.stringify(portJson).slice(0, 60000)}

Specifically hunt for: off-by-one in loops/slicing; float-summation or Math.log2 ULP drift where Python asserts exact; regex differences (Python verbose/inline-flags, named groups, Unicode classes); UTF-8 byte vs UTF-16 code-unit slicing (Buffer vs string index); missing branches/early-returns; module-global mutable state not registered in a reset seam; sync->async mis-conversion; NaN/Infinity JSON handling; Map-vs-dict ordering for FIFO/LRU; platform/OS branches dropped. Mark severity critical/major/minor. verdict=fix-needed if any critical/major issue exists.

OUTPUT: ONLY a JSON object per schema.`

const layerNum = (args && typeof args.layer === 'number') ? args.layer : 1
const layer = LAYERS[layerNum]
if (!layer) { log(`No layer ${layerNum} (1-7).`); return { error: `unknown layer ${layerNum}` } }

phase('Port')
log(`Layer ${layerNum} — ${layer.name}: porting ${layer.modules.length} modules test-first...`)
const results = await pipeline(
  layer.modules,
  (mod) => agent(PORT_PROMPT(mod, `${layerNum}: ${layer.name} — ${layer.note}`), { label: `port:${mod}`, phase: 'Port', schema: PORT_SCHEMA }),
  (port, mod) => agent(VERIFY_PROMPT(mod, port), { label: `verify:${mod}`, phase: 'Verify', schema: VERIFY_SCHEMA }).then((v) => ({ module: mod, port, verify: v })),
)

const ok = results.filter(Boolean)
log(`Layer ${layerNum} done: ${ok.length}/${layer.modules.length} modules ported+verified. fix-needed: ${ok.filter((r) => r.verify?.verdict === 'fix-needed').length}`)
return { layer: layerNum, name: layer.name, results: ok }
