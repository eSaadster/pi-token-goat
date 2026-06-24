# Using token-goat/ts with the pi extension

A simple guide to building the TypeScript port of token-goat and using it with
**pi** only — without installing any Claude Code / Codex hooks.

> Key idea up front: installing the npm package (putting the `token-goat` binary
> on your PATH) is **completely separate** from `token-goat install` (which patches
> `~/.claude`, `~/.codex`, etc.). For pi you only need the former.

---

## 1. Build & run

```bash
cd token-goat/ts
npm install        # one-time: download dependencies
npm run build      # produces dist/token-goat.mjs (the runnable CLI)
```

Run it directly (no global install needed):

```bash
node dist/token-goat.mjs --version
node dist/token-goat.mjs doctor
```

To make it available everywhere as the `token-goat` command (so pi can call it):

```bash
npm link           # run from token-goat/ts  → creates a global `token-goat`
token-goat --version    # now works from any folder
```

*(`npm install -g .` does the same thing. Build first — the global command points
at `dist/`.)*

---

## 2. Does installing add the `.claude` / `.codex` hooks? Can I prevent it?

**These are two completely separate things** — this is the whole answer:

| Action | What it touches |
|--------|-----------------|
| `npm link` / `npm install -g` | **Only** puts the `token-goat` binary on your PATH. Touches **nothing** in `~/.claude`, `~/.codex`, launchd, or cron. (No `postinstall` script.) |
| `token-goat install` (a separate command you'd run by hand) | **This** is what writes the hooks: `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, the skill, scheduled tasks, etc. |

A gotcha worth knowing: **`token-goat install` *always* writes the Claude Code
hooks as its base** — even `token-goat install --target pi` or `--pi` still
patches `~/.claude`. So you can't use that command to get "pi-only, no Claude."

➡️ **To prevent the hooks: simply never run `token-goat install`.** For pi you
don't need it at all.

---

## 3. Global binary (no hooks) + pi extension in a project → full capability?

**Yes.** The pi extension is self-contained — it calls the `token-goat` binary
directly (`spawnSync("token-goat", …)`) and wires everything through pi's own
extension API. It does **not** depend on `token-goat install` or any `.claude`
file.

Steps:

1. Do step 1 above so `token-goat` is on PATH (do **not** run `token-goat install`).
2. Put the extension in your project: copy `.pi/extensions/token-goat.ts` →
   `<your-project>/.pi/extensions/` (project-local), or `~/.pi/agent/extensions/`
   for all pi projects.
3. Launch pi in that project. It probes `token-goat --version`, then you get the
   full set:
   - big-file `Read` → surgical reads (one function/section instead of the whole file)
   - noisy bash / command output compression
   - the `tg_map` / `tg_symbol` / `tg_read` / `tg_find` tools
   - compaction manifests
   - the indexing worker auto-spawns in the background (node-correct)

**One caveat on "full":** semantic (meaning-based) search is **disabled** in the
TS build — there's no Node embeddings backend. Everything else — keyword search,
symbol lookup, surgical reads, repo map, bash/output compression — works.

So: full token-goat capability in pi, zero Claude/Codex hooks, just by not
running `token-goat install`.
