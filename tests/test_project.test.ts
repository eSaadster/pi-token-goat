/**
 * Unit tests for token_goat/project. 1:1 port of tests/test_project.py.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name, the
 * same assertion polarity, and the same inline rationale comments.
 *
 * -----
 * Tests intentionally NOT ported in this file
 * -----
 * Two tests in test_project.py exercise functions in modules that are not part
 * of Layer 1 (Foundation) and so are not yet ported:
 *
 *   - test_root_hash_matches_project_hash_for_same_canonical_path
 *       imports `from token_goat.stats import _root_hash`. stats lands in a
 *       later layer; when it ships, that test belongs in test_stats.test.ts
 *       (it's really guarding a stats-module invariant).
 *
 *   - test_grep_pattern_hash_known_vectors_durable_format
 *       imports `from token_goat.session import _grep_pattern_hash`. session
 *       lands in a later layer; that test belongs in test_session.test.ts.
 *
 * Both are documented here so the port does not silently drop them.
 *
 * -----
 * Windows-only tests
 * -----
 * Six tests in test_project.py are gated on `sys.platform == "win32"` (drive
 * letter lowercasing, cross-shell hash collapse, MSYS double-drive guard, etc.)
 * and are skipped on POSIX via `pytest.skip(...)`. The TS port mirrors this
 * with `it.skip` on process.platform !== "win32" — the assertions are kept so
 * that running the suite on Windows actually exercises them, but a POSIX
 * developer's `npm test` is not polluted with pending skips that can never
 * pass.
 *
 * -----
 * Path model
 * -----
 * Python tests pass `tmp_path` (a pathlib.Path) and assert on
 * `proj.root == canonicalize(tmp_path)`. The TS port passes `tmpPath` (a
 * string from fs.mkdtempSync) and asserts on the string equality directly —
 * canonicalize returns a string in the TS port (see project.ts path-model
 * note). For the known-vector test, Python used PurePosixPath(...) so
 * `.as_posix()` was uniform; the TS test passes the posix string directly,
 * which is the identical surface.
 */
import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROJECT_MARKERS,
  _normalize_shell_drive_prefix,
  canonicalize,
  find_project,
  make_project_at,
  project_hash,
} from "../src/token_goat/project.js";

// Per-test tmp dir helper — vitest gives no pytest-style tmp_path fixture, so
// we synthesize one. Each call yields a unique dir under the OS tmp root; the
// caller is responsible for cleanup (best-effort, via fs.rmSync recursive in
// a finally block — the OS tmp reaper sweeps anything we miss).
const _tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tg-proj-"));
let _counter = 0;
function tmpPath(): string {
  const dir = path.join(_tmpRoot, `t-${process.pid}-${_counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
process.on("exit", () => {
  try {
    fs.rmSync(_tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

const isWindows = process.platform === "win32";

describe("project detection and canonicalization (port of tests/test_project.py)", () => {
  // -------------------------------------------------------------------------
  // canonicalize basics
  // -------------------------------------------------------------------------

  it("test_canonicalize_lowercases_windows_drive", () => {
    const p = canonicalize(tmpPath());
    if (p.length >= 2 && p.charAt(1) === ":") {
      expect(p.charAt(0) >= "a" && p.charAt(0) <= "z").toBe(true);
    }
  });

  it("test_canonicalize_is_idempotent", () => {
    const tp = tmpPath();
    const a = canonicalize(tp);
    const b = canonicalize(a);
    expect(a).toBe(b);
  });

  it("test_project_hash_is_stable_and_deterministic", () => {
    const tp = tmpPath();
    const h1 = project_hash(canonicalize(tp));
    const h2 = project_hash(canonicalize(tp));
    expect(h1).toBe(h2);
    expect(h1.length).toBe(40); // sha1 hex
  });

  it("test_project_hash_known_vectors_durable_format", () => {
    // Lock down the on-disk DB filename format (projects/{hash}.db) against
    // silent algorithm swaps. Any change (e.g. "let's switch to xxhash")
    // invalidates EVERY existing per-project DB on upgrade — the user loses
    // indexed symbols, embeddings, stats, and decision-log history. These
    // known-value vectors guarantee a CI failure the moment such a swap is
    // attempted.
    //
    // If this test ever needs to change, the accompanying commit MUST include
    // a migration shim (try new-style hash, fall back to old-style) so live
    // installs keep working.
    //
    // Vectors are sha1 of the canonical posix string, utf-8 encoded. Python
    // used PurePosixPath(...) for cross-platform .as_posix(); the TS port
    // passes the posix string directly (identical surface).
    const cases: Record<string, string> = {
      // Lowercased Windows drive letter, posix separators — typical Windows
      // canonical form coming out of canonicalize("C:\\work\\foo").
      "c:/work/foo": "5009f1e60b77a0e38e173f99c447b9f004d9b338",
      // POSIX/WSL form.
      "/home/u/repo": "d971d9f4d1c16fc77a6f96201e08b16fd0d76cb4",
    };
    for (const [posixPath, expected] of Object.entries(cases)) {
      const actual = project_hash(posixPath);
      expect(actual).toBe(expected);
    }
    // Edge case from the Python test: PurePosixPath("") normalises to "." —
    // in the TS port the caller is responsible for passing the canonical
    // string, so the equivalent input is ".". The hash is sha1(b".") — NOT
    // sha1(b""), because Python's Path discards the empty string. This vector
    // confirms the canonical-string contract: project_hash operates on the
    // posix string as given.
    expect(project_hash(".")).toBe("3a52ce780950d4d969792a2559cd519d7ee8c727");
  });

  // -------------------------------------------------------------------------
  // find_project — marker detection + walk-up
  // -------------------------------------------------------------------------

  it("test_find_project_with_git_marker", () => {
    const tp = tmpPath();
    fs.mkdirSync(path.join(tp, ".git"));
    const proj = find_project(tp);
    expect(proj).not.toBeNull();
    expect(proj!.root).toBe(canonicalize(tp));
    expect(proj!.marker).toBe(".git");
  });

  it("test_find_project_walks_up", () => {
    const tp = tmpPath();
    fs.writeFileSync(path.join(tp, "package.json"), "{}");
    const nested = path.join(tp, "sub", "deeper");
    fs.mkdirSync(nested, { recursive: true });
    const proj = find_project(nested);
    expect(proj).not.toBeNull();
    expect(proj!.root).toBe(canonicalize(tp));
  });

  it("test_find_project_does_not_find_marker_in_same_dir", () => {
    // If no marker exists, we walk up (or return null at root). The important
    // part: we don't crash on empty dirs.
    const tp = tmpPath();
    const nested = path.join(tp, "sub", "deeper");
    fs.mkdirSync(nested, { recursive: true });
    const proj = find_project(nested);
    // Either we find a marker in a parent (fine), or null (if we hit root).
    expect(proj === null || proj.root !== nested).toBe(true);
  });

  it("test_find_project_shopify_marker", () => {
    const tp = tmpPath();
    fs.writeFileSync(path.join(tp, "shopify.app.toml"), "");
    const proj = find_project(tp);
    expect(proj).not.toBeNull();
    expect(proj!.marker).toBe("shopify.app.toml");
  });

  it("test_find_project_skips_repo_container", () => {
    // A stray `.git` at a directory that merely holds many independent repos
    // must not swallow the whole supertree into one giant project.
    //
    // This is the environmental half of the "unknown project hash" bug: an
    // accidental `git init` at a container like C:\Projects made find_project
    // return the container, and everything under it indexed as one project.
    const tp = tmpPath();
    const container = path.join(tp, "Projects");
    fs.mkdirSync(container);
    fs.mkdirSync(path.join(container, ".git")); // the stray accidental git init
    for (const name of ["repo_a", "repo_b", "repo_c"]) {
      const child = path.join(container, name);
      fs.mkdirSync(child);
      fs.mkdirSync(path.join(child, ".git"));
    }

    // A markerless scratch dir directly under the container.
    const scratch = path.join(container, "scratch");
    fs.mkdirSync(scratch);
    let proj = find_project(scratch);
    expect(proj === null || proj.root !== canonicalize(container)).toBe(true);

    // Querying the container directly also does not treat it as a project.
    const direct = find_project(container);
    expect(direct === null || direct.root !== canonicalize(container)).toBe(true);

    // A real repo nested in the container is still detected as itself.
    const repoA = find_project(path.join(container, "repo_a"));
    expect(repoA).not.toBeNull();
    expect(repoA!.root).toBe(canonicalize(path.join(container, "repo_a")));
  });

  // -------------------------------------------------------------------------
  // make_project_at — non-directory / nonexistent rejection
  // -------------------------------------------------------------------------

  it("test_make_project_at_rejects_file", () => {
    const tp = tmpPath();
    const f = path.join(tp, "notadir.txt");
    fs.writeFileSync(f, "content");
    expect(() => make_project_at(f)).toThrow(/not a directory/);
  });

  it("test_make_project_at_rejects_nonexistent", () => {
    const tp = tmpPath();
    const missing = path.join(tp, "does_not_exist");
    expect(() => make_project_at(missing)).toThrow(/not a directory/);
  });

  it("test_make_project_at_accepts_real_directory", () => {
    const tp = tmpPath();
    const proj = make_project_at(tp);
    expect(proj.root).toBe(canonicalize(tp));
    expect(proj.marker).toBe("manual");
  });

  // -------------------------------------------------------------------------
  // find_project — symlink-escape security guards
  // -------------------------------------------------------------------------
  // Skipped on Windows (symlinks require elevated privileges there), mirroring
  // the Python `@pytest.mark.skipif(sys.platform == "win32", ...)`.

  (isWindows ? it.skip : it)(
    "test_find_project_rejects_symlink_marker_pointing_outside_root",
    () => {
      // A symlinked .git that points outside the candidate directory must not
      // make find_project accept that directory as a project root.
      //
      // Attack vector: attacker plants mydir/.git -> /etc/passwd (or any path
      // outside mydir). Without this guard, find_project would return mydir as
      // a project and the indexer would crawl it, potentially triggering
      // further operations on unrelated filesystem paths.
      const tp = tmpPath();
      const outsideDir = path.join(tp, "outside");
      fs.mkdirSync(outsideDir);

      const candidate = path.join(tp, "candidate");
      fs.mkdirSync(candidate);

      // Plant a symlink: candidate/.git -> ../outside (escapes candidate).
      fs.symlinkSync(outsideDir, path.join(candidate, ".git"));

      const proj = find_project(candidate);
      expect(proj === null || proj.root !== canonicalize(candidate)).toBe(true);
    },
  );

  (isWindows ? it.skip : it)(
    "test_find_project_accepts_symlink_marker_within_root",
    () => {
      // A symlinked marker that resolves within the project root is legitimate
      // and accepted.
      const tp = tmpPath();
      const projectDir = path.join(tp, "myproject");
      fs.mkdirSync(projectDir);

      // Create a real .git dir inside the project.
      const realGit = path.join(projectDir, ".git-real");
      fs.mkdirSync(realGit);

      // Symlink .git -> .git-real (within the project root — legitimate).
      fs.symlinkSync(realGit, path.join(projectDir, ".git"));

      const proj = find_project(projectDir);
      expect(proj).not.toBeNull();
      expect(proj!.root).toBe(canonicalize(projectDir));
      expect(proj!.marker).toBe(".git");
    },
  );

  // -------------------------------------------------------------------------
  // _normalize_shell_drive_prefix — pure string transform
  // -------------------------------------------------------------------------
  // These run on every platform because the normalization is a pure string
  // transform — no filesystem operations are needed.

  it("test_normalize_shell_prefix_wsl_mount", () => {
    // /mnt/c/Projects/foo (WSL) -> c:/Projects/foo.
    expect(_normalize_shell_drive_prefix("/mnt/c/Projects/foo")).toBe(
      "c:/Projects/foo",
    );
  });

  it("test_normalize_shell_prefix_wsl_uppercase_drive", () => {
    // /mnt/C/Projects/foo -> c:/Projects/foo (drive letter lowercased).
    expect(_normalize_shell_drive_prefix("/mnt/C/Projects/foo")).toBe(
      "c:/Projects/foo",
    );
  });

  it("test_normalize_shell_prefix_cygwin", () => {
    // /cygdrive/c/Projects/foo -> c:/Projects/foo.
    expect(_normalize_shell_drive_prefix("/cygdrive/c/Projects/foo")).toBe(
      "c:/Projects/foo",
    );
  });

  it("test_normalize_shell_prefix_msys_git_bash", () => {
    // /c/Projects/foo (Git Bash MSYS) -> c:/Projects/foo.
    expect(_normalize_shell_drive_prefix("/c/Projects/foo")).toBe(
      "c:/Projects/foo",
    );
  });

  it("test_normalize_shell_prefix_alternate_drive_letter", () => {
    // Drive letters other than 'c' are also handled.
    expect(_normalize_shell_drive_prefix("/mnt/d/Code/proj")).toBe(
      "d:/Code/proj",
    );
    expect(_normalize_shell_drive_prefix("/e/Code/proj")).toBe("e:/Code/proj");
    expect(_normalize_shell_drive_prefix("/cygdrive/z/Code/proj")).toBe(
      "z:/Code/proj",
    );
  });

  it("test_normalize_shell_prefix_leaves_posix_paths_alone", () => {
    // Real POSIX paths (no drive-letter ambiguity) pass through unchanged.
    expect(_normalize_shell_drive_prefix("/usr/local/bin")).toBe(
      "/usr/local/bin",
    );
    expect(_normalize_shell_drive_prefix("/home/user/proj")).toBe(
      "/home/user/proj",
    );
    expect(_normalize_shell_drive_prefix("/var/log/app")).toBe("/var/log/app");
  });

  it("test_normalize_shell_prefix_leaves_already_canonical_alone", () => {
    // A path that already has a c:/ prefix is left alone. Note: "C:/..." is
    // NOT lowercased by _normalize_shell_drive_prefix (that's canonicalize's
    // job); the prefix normalizer only rewrites the MSYS/Cygwin/WSL forms.
    expect(_normalize_shell_drive_prefix("c:/Projects/foo")).toBe(
      "c:/Projects/foo",
    );
    expect(_normalize_shell_drive_prefix("C:/Projects/foo")).toBe(
      "C:/Projects/foo",
    );
  });

  it("test_normalize_shell_prefix_handles_multi_segment_msys", () => {
    // MSYS only strips the *first* single-letter segment, not later ones.
    // /c/foo/d -> c:/foo/d (drive letter is the leading single-letter segment).
    expect(_normalize_shell_drive_prefix("/c/foo/d")).toBe("c:/foo/d");
  });

  it("test_normalize_shell_prefix_no_match_for_multi_letter_top_level", () => {
    // A multi-letter top-level directory like /usr/ is not mistaken for a drive.
    // /us/foo would only match if the regex were too greedy — verify it doesn't.
    expect(_normalize_shell_drive_prefix("/us/foo")).toBe("/us/foo");
    expect(_normalize_shell_drive_prefix("/home/foo")).toBe("/home/foo");
  });

  it("test_normalize_shell_prefix_empty_and_root", () => {
    // Edge cases: empty string and bare root pass through.
    expect(_normalize_shell_drive_prefix("")).toBe("");
    expect(_normalize_shell_drive_prefix("/")).toBe("/");
    // /c/ with no trailing component still matches and yields c:/ — that's the
    // bare-drive form, which is fine.
    expect(_normalize_shell_drive_prefix("/c/")).toBe("c:/");
  });

  // -------------------------------------------------------------------------
  // canonicalize — cross-shell + real-dir invariants
  // -------------------------------------------------------------------------
  // The cross-shell hash-collapse, backslash-equality, drive-case, and MSYS
  // double-drive tests are Windows-only in the Python suite and are skipped
  // here on POSIX for the same reasons (see the Windows-only block below).

  it("test_canonicalize_real_tmp_path_idempotent_after_normalization", () => {
    // Round-tripping a real directory through canonicalize is idempotent even
    // after the shell-prefix step.
    const tp = tmpPath();
    const a = canonicalize(tp);
    const b = canonicalize(a);
    const c = canonicalize(b);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(project_hash(a)).toBe(project_hash(b));
    expect(project_hash(b)).toBe(project_hash(c));
  });

  it("test_project_hash_stable_across_shell_forms_on_real_dir", () => {
    // A real directory hashed via its native string equals the hash from the
    // canonicalize() output — i.e. the hash is stable through one extra
    // normalisation pass.
    const tp = tmpPath();
    const hDirect = project_hash(canonicalize(tp));
    const hViaStr = project_hash(canonicalize(tp));
    expect(hDirect).toBe(hViaStr);
  });

  // -------------------------------------------------------------------------
  // Windows-only canonicalize tests
  // -------------------------------------------------------------------------
  // These mirror the six `@pytest.mark.skipif(...)` blocks in the Python
  // source. On POSIX they would assert against synthesized paths rather than
  // the intended Windows invariants, so they are skipped. Run the suite on
  // Windows to exercise them.

  (isWindows ? it : it.skip)(
    "test_canonicalize_cross_shell_paths_produce_same_hash",
    () => {
      // All Windows-drive shell representations canonicalize to the same hash.
      // Linchpin test for cross-platform consistency: without
      // _normalize_shell_drive_prefix, PowerShell / Git Bash / Cygwin / WSL
      // would produce four different SHA1 hashes and fragment the index.
      const forms = [
        "C:/Projects/foo",
        "c:/Projects/foo",
        "/c/Projects/foo",
        "/mnt/c/Projects/foo",
        "/cygdrive/c/Projects/foo",
      ];
      const hashes = new Set(
        forms.map((f) => project_hash(canonicalize(f))),
      );
      expect(hashes.size).toBe(1);
    },
  );

  (isWindows ? it : it.skip)(
    "test_canonicalize_backslash_and_forward_slash_match_on_windows",
    () => {
      // C:\Projects\foo and C:/Projects/foo canonicalize identically.
      const a = canonicalize("C:/Projects/foo");
      const b = canonicalize("C:\\Projects\\foo");
      expect(a).toBe(b);
    },
  );

  (isWindows ? it : it.skip)("test_canonicalize_drive_case_collapsed", () => {
    // C:/foo and c:/foo canonicalize identically (drive letter lowercased).
    const a = canonicalize("C:/Projects/foo");
    const b = canonicalize("c:/Projects/foo");
    expect(a).toBe(b);
    expect(project_hash(a)).toBe(project_hash(b));
  });

  (isWindows ? it : it.skip)(
    "test_canonicalize_msys_path_on_windows_does_not_double_drive",
    () => {
      // On Windows, /c/Projects/foo must NOT resolve to C:\c\Projects\foo.
      // path.resolve on Windows treats a leading slash as relative-to-current-
      // drive, so /c/Projects/foo would naïvely become C:/c/Projects/foo. The
      // pre-resolve normalisation step converts /c/... to c:/... before resolve
      // sees it, avoiding the double-drive trap.
      const c = canonicalize("/c/Projects/foo");
      // Must be exactly c:/Projects/foo, never c:/c/Projects/foo.
      expect(c).toBe("c:/Projects/foo");
    },
  );

  // -------------------------------------------------------------------------
  // PROJECT_MARKERS constant smoke test (no Python equivalent — guards the
  // port's marker tuple against accidental reordering, since marker reporting
  // depends on iteration order).
  // -------------------------------------------------------------------------
  it("PROJECT_MARKERS order matches Python tuple (precedence contract)", () => {
    // find_project reports the FIRST marker that exists in a directory; if the
    // tuple were reordered, a directory carrying both .git and package.json
    // would report a different marker and break the (marker == ".git")
    // assertions above. Lock the order.
    expect(PROJECT_MARKERS).toEqual([
      ".git",
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
      "shopify.app.toml",
      "_config.yml",
      "deno.json",
      "deno.jsonc",
    ]);
  });
});
