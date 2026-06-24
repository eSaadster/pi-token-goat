/**
 * bash_compress INFRASTRUCTURE / IaC-ADJACENT FILTERS — TypeScript port of the
 * VaultFilter, PackerFilter, NixFilter, HaskellFilter, and RCmdFilter Filter
 * subclasses from src/token_goat/bash_compress.py (plus their module-private
 * _VAULT_*, _PACKER_*, _NIX_*, _HASKELL_*, _R_* regex constants).
 *
 * Five filters subclass the concrete Filter base from ./framework.js. All five
 * set `error_passthrough = true` and override `_compress_body` (NOT `compress`)
 * — the framework's compress() template method short-circuits to raw stderr on a
 * non-zero exit via _preserve_stderr_on_error, then delegates the happy path to
 * _compress_body. RCmdFilter additionally overrides matches() (it must fire for
 * `R CMD ...` and `Rscript`, both behind the `r` / `rscript` stems); the others
 * rely on the default binaries-based matches().
 *
 * These filters have NO dedicated test files; they are validated only by the
 * dispatch test (matches() / detect_from_command() routing). Ported with extra
 * care for compress() parity (the _compress_body line-classification order is
 * load-bearing — the Python comments mark "always keep" checks first).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, _compress_body) and snake_case module-private
 *    regex constants (_VAULT_*, _PACKER_*, _NIX_*, _HASKELL_*, _R_*).
 *  - re.compile(...) -> top-level RegExp compiled once at module load.
 *    re.IGNORECASE -> the "i" flag. re.MULTILINE is NOT used by any of these
 *    patterns (all .match / .search are per-line).
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored); emulated
 *    via _reMatch (non-global clone + index===0). .search() -> _reSearch
 *    (non-global clone, .exec anywhere). None of these filters read capture
 *    groups, so no _reMatchObj is needed.
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it is
 *    re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel `export *` chain.
 *  - Python `Path(argv[0]).stem.lower()` (RCmdFilter.matches) -> local
 *    _pathStemLower (final path component, last suffix stripped, lowercased),
 *    matching the framework's _pathStem semantics used elsewhere.
 *  - Python `positionals[0].upper() == "CMD"` -> `positionals[0]!.toUpperCase()
 *    === "CMD"` (R CMD is case-insensitive in the Python stem check, but the
 *    subcommand gate is an explicit .upper() compare — mirrored exactly).
 *  - Python `argv[0].lower() in ("vault",)` / `argv[1].lower() == "list"` in
 *    VaultFilter's is_list_cmd -> toLowerCase() compares.
 *  - _maybe_note / _positional_args are framework-PUBLIC and imported.
 *    _combine_output is an INSTANCE method; _finalize / _emit_notes are STATIC
 *    methods on Filter. The Python `self._emit_notes` / `self._finalize` calls
 *    become `Filter._emit_notes` / `Filter._finalize` (the TS port made them
 *    static; existing sibling modules call them statically).
 *  - error_passthrough is a class field defaulting to false on Filter; each of
 *    these five subclasses sets `override error_passthrough = true`.
 *  - Module-global mutable state: NONE. Every counter/dict/list is a local inside
 *    _compress_body; no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - vault    : binaries {vault}; any subcommand. (is_list_cmd branches on
 *               `vault list` or `vault kv list` for the item-collapse path.)
 *  - packer   : binaries {packer}; any subcommand.
 *  - nix      : binaries {nix, nix-build, nix-shell, nix-env, nix-store,
 *               nixos-rebuild}; any subcommand.
 *  - haskell  : binaries {cabal, stack, ghc, runghc, runhaskell}; any subcommand.
 *  - r-cmd    : stem `r` gated to `R CMD ...` (overridden matches); stem
 *               `rscript` always matches (overridden matches).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import { Filter, _maybe_note, _positional_args } from "./framework.js";

// ===========================================================================
// Internal Python-builtin shims local to this module.
// ===========================================================================

/** Return a clone of re without the global/sticky flags (one-shot .exec/.test). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Python re.Pattern.match(line) — anchored at the START (NOT end-anchored). JS
 * has no anchored-match primitive; emulate via a non-global clone and an
 * index===0 check.
 */
function _reMatch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * pathlib.Path(s.replace("\\","/")).stem.lower() — the lowercased final path
 * component with its LAST suffix removed. Matches framework._pathStem semantics
 * (a leading-dot dotfile keeps its name; a trailing dot is not a suffix).
 */
function _pathStemLower(s: string): string {
  const norm = s.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return name.toLowerCase();
  }
  return name.slice(0, dot).toLowerCase();
}

// ===========================================================================
// Module-private framework regexes re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// Vault regexes (Python ~20158-20199).
// ===========================================================================

/** Vault "Key Value" / "--- -----" table header / divider lines. */
const _VAULT_TABLE_DIVIDER_RE: RegExp = /^\s*-{3,}\s+-{3,}\s*$/;
/** Vault lease / token metadata lines emitted after every operation. */
const _VAULT_LEASE_META_RE: RegExp =
  /^\s*(?:lease_(?:id|renewable|duration|accessor)|token_(?:policies|accessor|type|ttl|issue_time|expire_time|explicit_max_ttl|num_uses|renewable)|renewable|request_id)\s/i;
/** Vault "Success! Data written to ..." / "Success! Enabled ...". */
const _VAULT_SUCCESS_RE: RegExp = /^\s*Success!\s+/i;
/** Vault "WARNING:" / "==> Vault server configuration:" / "Key Value" headers. */
const _VAULT_HEADER_RE: RegExp = /^\s*(?:WARNING|==>|Key\s+Value\s*$)/i;
/** Vault auth-login output headers / `vault <subcommand>` prompts. */
const _VAULT_AUTH_HEADER_RE: RegExp =
  /^\s*(?:Token\s+information:|The\s+token\s+information|Complete\s+the\s+following|vault\s+(?:kv|secrets|auth|policy|lease|token)\s)/i;
/** Vault list item lines: "  foo/" or "  bar" — plain indented paths. */
const _VAULT_LIST_ITEM_RE: RegExp = /^\s{1,6}[a-zA-Z0-9_./-]+\/?$/;
/** Vault "vault kv list" header: "Keys". */
const _VAULT_LIST_HEADER_RE: RegExp = /^\s*Keys\s*$/i;

// ===========================================================================
// VaultFilter (Python ~20202-20296)
// ===========================================================================

/**
 * Compress HashiCorp Vault CLI (`vault`) output.
 *
 * The Vault CLI emits verbose token/lease metadata after every operation, table
 * dividers that consume a line each, and listing output that can be hundreds of
 * lines for large secret trees. Lease/token metadata and table dividers are
 * collapsed/dropped; `vault kv list` / `vault list` output is collapsed to a
 * count with the first 5 shown when there are more than 10 items; Success /
 * WARNING / ==> header and error lines are always kept. error_passthrough = true
 * preserves raw stderr on a non-zero exit.
 */
export class VaultFilter extends Filter {
  override error_passthrough = true;

  override name = "vault";
  override binaries: ReadonlySet<string> = new Set(["vault"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let meta_count = 0;
    let divider_count = 0;

    // Detect kv-list mode: `vault kv list` or `vault list`.
    const is_list_cmd =
      argv.length >= 2 &&
      argv[0]!.toLowerCase() === "vault" &&
      (argv[1]!.toLowerCase() === "list" ||
        (argv.length >= 3 &&
          argv[1]!.toLowerCase() === "kv" &&
          argv[2]!.toLowerCase() === "list"));
    const list_items: string[] = [];
    let in_list_body = false;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Success / header / auth header — always keep.
      if (
        _reMatch(_VAULT_SUCCESS_RE, line) ||
        _reMatch(_VAULT_HEADER_RE, line) ||
        _reMatch(_VAULT_AUTH_HEADER_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Table divider — drop.
      if (_reMatch(_VAULT_TABLE_DIVIDER_RE, line)) {
        divider_count += 1;
        continue;
      }
      // Lease / token metadata — count.
      if (_reMatch(_VAULT_LEASE_META_RE, line)) {
        meta_count += 1;
        continue;
      }
      // List mode: collect items for potential collapsing.
      if (is_list_cmd) {
        if (_reMatch(_VAULT_LIST_HEADER_RE, line)) {
          kept.push(line);
          in_list_body = true;
          continue;
        }
        if (in_list_body && _reMatch(_VAULT_LIST_ITEM_RE, line)) {
          list_items.push(line);
          continue;
        }
        in_list_body = false;
      }
      kept.push(line);
    }

    // Collapse list items when there are more than 10.
    const _LIST_COLLAPSE_THRESHOLD = 10;
    if (list_items.length > 0) {
      if (list_items.length <= _LIST_COLLAPSE_THRESHOLD) {
        kept.push(...list_items);
      } else {
        kept.push(...list_items.slice(0, 5));
        kept.push(
          `[token-goat: ${list_items.length - 5} more secret path(s) omitted; ` +
            `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
        );
      }
    }

    const notes: string[] = [];
    _maybe_note(notes, meta_count, `collapsed ${meta_count} Vault lease/token metadata line(s)`);
    _maybe_note(notes, divider_count, `dropped ${divider_count} table divider line(s)`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Packer regexes (Python ~20303-20345).
// ===========================================================================

/** Packer "Waiting for SSH/WinRM" / "Polling for" / "Retrying in N" poll lines. */
const _PACKER_WAITING_RE: RegExp =
  /^\s*(?:==>|)\s*[\w.-]+:\s+(?:Waiting\s+for\s+(?:SSH|WinRM|instance|AMI|connection)|Polling\s+for\s+|Retrying\s+in\s+\d+)/i;
/** Packer provisioner step announcements: "==> <builder>: Running provisioner:". */
const _PACKER_PROVISIONER_RE: RegExp =
  /^\s*==>?\s*[\w.-]+:\s+(?:Running\s+provisioner:|Provisioning\s+with\s+|Executing\s+script:|Running\s+local\s+shell\s+script:|Uploading\s+\S+\s+=>)/i;
/** Packer "==> <builder>: Pausing N seconds before next provisioner". */
const _PACKER_PAUSE_RE: RegExp = /^\s*==>?\s*[\w.-]+:\s+Pausing\s+\d+\s+seconds/i;
/** Packer network heartbeat noise: "[c] Received disconnect / Net tcp / SSH / channel close". */
const _PACKER_NETWORK_NOISE_RE: RegExp =
  /^\s*(?:==>?|)?\s*[\w.-]+:\s+\[c\]\s+(?:Received\s+disconnect|Net\s+tcp|SSH|channel\s+close)/i;
/** Packer build-step headers: "==> <builder>: Creating/Starting/Stopping/...". */
const _PACKER_BUILD_STEP_RE: RegExp =
  /^\s*==>?\s*[\w.-]+:\s+(?:Creating|Starting|Stopping|Destroying|Terminating|Registering|Deregistering|Tagging|Setting\s+up|Cleaning\s+up|Deleting|Adding)\s+/i;
/** Packer final artifact / builds-finished summary lines. */
const _PACKER_ARTIFACT_RE: RegExp = /^\s*(?:==>?\s*Builds\s+finished|-->\s*[\w.-]+:)/i;
/** Packer "Build '<name>' finished." summary line. */
const _PACKER_BUILD_FINISHED_RE: RegExp =
  /^\s*(?:==>?\s*[\w.-]+:\s+Build\s+'\S+'\s+finished|Build\s+'\S+'\s+finished)/i;

// ===========================================================================
// PackerFilter (Python ~20348-20432)
// ===========================================================================

/**
 * Compress HashiCorp Packer (`packer build`) image-build output.
 *
 * A Packer build run can produce thousands of lines: SSH connection polling,
 * per-provisioner step announcements, heartbeat/keepalive noise, and verbose
 * network-layer messages. "Waiting for SSH/WinRM" polls and provisioner-step
 * announcements are collapsed to counts; network/heartbeat/pause noise is
 * dropped; build-step headers (Creating/Tagging/Stopping — each a meaningful
 * API call) and artifact/build-finished summary lines plus errors are always
 * kept. error_passthrough = true preserves raw stderr on a non-zero exit.
 */
export class PackerFilter extends Filter {
  override error_passthrough = true;

  override name = "packer";
  override binaries: ReadonlySet<string> = new Set(["packer"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let waiting_count = 0;
    let provisioner_count = 0;
    let noise_count = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Artifact / build-finished summary — always keep.
      if (_reMatch(_PACKER_ARTIFACT_RE, line) || _reMatch(_PACKER_BUILD_FINISHED_RE, line)) {
        kept.push(line);
        continue;
      }
      // Build step lines (Creating/Tagging/etc) — always keep (each is a
      // meaningful API call with potential for failure).
      if (_reMatch(_PACKER_BUILD_STEP_RE, line)) {
        kept.push(line);
        continue;
      }
      // SSH/WinRM wait polling — count.
      if (_reMatch(_PACKER_WAITING_RE, line)) {
        waiting_count += 1;
        continue;
      }
      // Provisioner step announcements — count.
      if (_reMatch(_PACKER_PROVISIONER_RE, line)) {
        provisioner_count += 1;
        continue;
      }
      // Network heartbeat / keepalive — drop.
      if (_reMatch(_PACKER_NETWORK_NOISE_RE, line)) {
        noise_count += 1;
        continue;
      }
      // Pause lines — drop.
      if (_reMatch(_PACKER_PAUSE_RE, line)) {
        noise_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (waiting_count) {
      out.push(
        `[token-goat: ${waiting_count} SSH/WinRM connection-wait poll line(s) collapsed; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }
    if (provisioner_count) {
      out.push(
        `[token-goat: collapsed ${provisioner_count} provisioner step announcement(s)]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, noise_count, `dropped ${noise_count} network/heartbeat/pause noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Nix regexes (Python ~20439-20489).
// ===========================================================================

/** Nix "building '/nix/store/...'" / "building path(s):" lines. */
const _NIX_BUILDING_RE: RegExp =
  /^\s*(?:building\s+['"]?\/nix\/store\/|building\s+path\(s\):)/i;
/** Nix fetching/downloading/copying/substituting store-path lines. */
const _NIX_FETCHING_RE: RegExp =
  /^\s*(?:fetching\s+path\s+['"]?\/nix\/store\/|downloading\s+['"]?https?:\/\/|copying\s+path\s+['"]?\/nix\/store\/|querying\s+['"]?https?:\/\/|substituting\s+['"]?\/nix\/store\/)/i;
/** Nix "these N paths/derivations will be fetched/built" summary preambles. */
const _NIX_PATHS_SUMMARY_RE: RegExp =
  /^\s*(?:these\s+\d+\s+paths\s+will\s+be|this\s+path\s+will\s+be|these\s+derivations\s+will\s+be)/i;
/** Nix binary-cache substitution progress: "[x/y (N MiB DL)]". */
const _NIX_PROGRESS_RE: RegExp =
  /^\s*\[\d+\/\d+(?:\s+\(\d+(?:\.\d+)?\s+(?:MiB|KiB|GiB)\s+DL\))?\]/;
/** Nix flake lock update verbosity (Updated/Resolving/Locked input, lock-file writes). */
const _NIX_FLAKE_UPDATE_RE: RegExp =
  /^\s*(?:Updated\s+input\s+'|Resolving\s+flake\s+input\s+'|inputs\.\S+\.follows\s*=|warning:\s+Git\s+tree|trace:\s+|Added\s+input\s+'|Removed\s+input\s+'|Locked\s+input\s+'|writing\s+modified\s+lock\s+file|Updating\s+lock\s+file)/i;
/** Nix "error:" / "note:" / "warning:" / "nix error:" headers — always keep. */
const _NIX_ERROR_RE: RegExp =
  /^\s*(?:error:|note:|warning:|nix\s+(?:error|warning):)/i;
/** Nix final store-path result line (last line of a successful nix-build). */
const _NIX_SUCCESS_STORE_RE: RegExp = /^\s*\/nix\/store\/\S+$/;
/** Nix nix-shell sandbox / phase boilerplate lines. */
const _NIX_SANDBOX_NOISE_RE: RegExp =
  /^\s*(?:sandbox\s+path\s*:|sandboxed\s+build|setting\s+up\s+build\s+environment|running\s+phase\s+'[a-zA-Z]+'|source\s+\$stdenv\/setup)/i;

// ===========================================================================
// NixFilter (Python ~20492-20586)
// ===========================================================================

/**
 * Compress Nix build / nix-shell / nix flake output.
 *
 * Nix is one of the most verbose build tools: even a small package build
 * produces hundreds of lines of per-derivation fetching, substituting, sandbox
 * setup, and build-phase announcements. Fetching/downloading/substituting,
 * building, and flake-lock update lines are collapsed to counts; progress
 * `[x/y ...]` and sandbox boilerplate noise is dropped; "these N paths will be
 * ..." summary preambles, final `/nix/store/...` result lines, and error /
 * warning lines are always kept. error_passthrough = true preserves raw stderr
 * on a non-zero exit.
 */
export class NixFilter extends Filter {
  override error_passthrough = true;

  override name = "nix";
  override binaries: ReadonlySet<string> = new Set([
    "nix",
    "nix-build",
    "nix-shell",
    "nix-env",
    "nix-store",
    "nixos-rebuild",
  ]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let fetch_count = 0;
    let build_count = 0;
    let flake_update_count = 0;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error/warning signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_NIX_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // Final result store paths — always keep.
      if (_reMatch(_NIX_SUCCESS_STORE_RE, line)) {
        kept.push(line);
        continue;
      }
      // "these N paths will be ..." summary preambles — keep.
      if (_reMatch(_NIX_PATHS_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Progress [x/y ...] lines — drop.
      if (_reMatch(_NIX_PROGRESS_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Fetching/downloading/substituting store paths — count.
      if (_reMatch(_NIX_FETCHING_RE, line)) {
        fetch_count += 1;
        continue;
      }
      // Building derivations — count.
      if (_reMatch(_NIX_BUILDING_RE, line)) {
        build_count += 1;
        continue;
      }
      // Flake update verbosity — count.
      if (_reMatch(_NIX_FLAKE_UPDATE_RE, line)) {
        flake_update_count += 1;
        continue;
      }
      // Sandbox boilerplate — drop.
      if (_reMatch(_NIX_SANDBOX_NOISE_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (fetch_count) {
      out.push(
        `[token-goat: fetched/substituted ${fetch_count} store path(s) from binary cache; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    if (build_count) {
      out.push(`[token-goat: built ${build_count} Nix derivation(s)]`);
    }
    if (flake_update_count) {
      out.push(
        `[token-goat: collapsed ${flake_update_count} flake lock update line(s)]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} Nix scheduler/sandbox noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Haskell regexes (Python ~20593-20647).
// ===========================================================================

/** cabal/stack "Resolving dependencies" / "Downloading ... from Hackage" lines. */
const _HASKELL_RESOLVING_RE: RegExp =
  /^\s*(?:Resolving\s+dependencies|Downloading\s+\S+\s+from\s+Hackage|Downloading\s+\S+\s+\.\.\.|Fetching\s+package|Configuring\s+\S+\.\.\.|Preprocessing\s+\S+\s+for|Starting\s+to\s+install)/i;
/** cabal/stack per-module "Compiling ..." progress: "[N of M] Compiling Foo.Bar ...". */
const _HASKELL_COMPILING_RE: RegExp =
  /^\s*(?:\[\s*\d+\s+of\s+\d+\]\s+Compiling\s+\S+|Compiling\s+\S+(?:\s+\(\s*\S+,\s*\S+\))?\.\.\.?)/;
/** stack/cabal "Linking ..."/"Building all executables ..."/"Installed ..." lines. */
const _HASKELL_LINKING_RE: RegExp =
  /^\s*(?:Linking\s+\S+|Building\s+all\s+executables|Building\s+library\s+for\s+|Building\s+executable|Installed\s+\S+(?:\s+\d+\.\d+)?)/i;
/** cabal "Installing library/executable in ..."/"Registering library" lines. */
const _HASKELL_INSTALLING_RE: RegExp =
  /^\s*(?:Installing\s+(?:library|executable)\s+in|Registering\s+library|Updating\s+package\s+list|Reading\s+available\s+packages)/i;
/** stack/cabal build success: "Completed N action(s)." / "Build completed" / "Test suite ... PASS". */
const _HASKELL_SUCCESS_RE: RegExp =
  /^\s*(?:Completed\s+\d+\s+action|Build\s+completed|Finished\s+building\s+package|All\s+\d+\s+tests\s+passed|Test\s+suite\s+\S+:\s+PASS|\d+\s+out\s+of\s+\d+\s+test\s+suites\s+\(|Tests\s+complete\b)/i;
/** cabal/stack test failure: "FAIL" / "failures:" / "N test cases failed". */
const _HASKELL_TEST_FAIL_RE: RegExp =
  /^\s*(?:Test\s+suite\s+\S+:\s+FAIL|FAILURES:|failures:|\d+\s+test\s+(?:case[s]?\s+)?(?:failed|FAILED))/i;
/** cabal/stack "Warning:" / unused-module / defined-but-not-used lines. */
const _HASKELL_WARNING_RE: RegExp =
  /^\s*(?:Warning:\s+|Module\s+'?\S+'?\s+does\s+not\s+export|Defined\s+but\s+not\s+used:)/;
/** cabal/stack/ghc error prefix lines: "cabal: " / "stack: " / "ghc: " / "error: ". */
const _HASKELL_ERROR_PREFIX_RE: RegExp = /^\s*(?:cabal:|stack:|ghc:|error:|Error:)\s+/i;

// ===========================================================================
// HaskellFilter (Python ~20650-20747)
// ===========================================================================

/**
 * Compress Haskell `cabal build` / `stack build` / `cabal test` output.
 *
 * A Haskell build produces hundreds of `[N of M] Compiling Module.Name`
 * progress lines plus dependency-resolution noise, even for small packages.
 * Per-module compilation, dependency resolution/download, and
 * linking/installing/registering lines are collapsed to counts; `Warning:` lines
 * are deduplicated to at most 3 per 40-char category key; success summary
 * (`Completed N actions`, `Test suite ... PASS`), test failure (`FAIL`,
 * `failures:`), and error (`cabal:`/`error:`/GHC) lines are always kept.
 * error_passthrough = true preserves raw stderr on a non-zero exit.
 */
export class HaskellFilter extends Filter {
  override error_passthrough = true;

  override name = "haskell";
  override binaries: ReadonlySet<string> = new Set([
    "cabal",
    "stack",
    "ghc",
    "runghc",
    "runhaskell",
  ]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let compiling_count = 0;
    let resolving_count = 0;
    let linking_count = 0;
    // Deduplicate warnings: keep at most 3 per unique warning category.
    const warning_seen = new Map<string, number>();
    let dropped_warnings = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_HASKELL_ERROR_PREFIX_RE, line)) {
        kept.push(line);
        continue;
      }
      // cabal/stack explicit error prefixes — keep.
      if (_reMatch(_HASKELL_TEST_FAIL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Success summary — always keep.
      if (_reMatch(_HASKELL_SUCCESS_RE, line)) {
        kept.push(line);
        continue;
      }
      // Per-module compilation progress — count.
      if (_reMatch(_HASKELL_COMPILING_RE, line)) {
        compiling_count += 1;
        continue;
      }
      // Dependency resolution / download noise — count.
      if (_reMatch(_HASKELL_RESOLVING_RE, line)) {
        resolving_count += 1;
        continue;
      }
      // Linking / installing / registering lines — count.
      if (_reMatch(_HASKELL_LINKING_RE, line) || _reMatch(_HASKELL_INSTALLING_RE, line)) {
        linking_count += 1;
        continue;
      }
      // Warnings — keep at most 3 per category key (first 40 chars).
      if (_reMatch(_HASKELL_WARNING_RE, line)) {
        // Use first 40 chars as a dedup key to group same-cause warnings.
        const key = line.trim().slice(0, 40);
        const count = warning_seen.get(key) ?? 0;
        if (count < 3) {
          warning_seen.set(key, count + 1);
          kept.push(line);
        } else {
          dropped_warnings += 1;
        }
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (resolving_count) {
      out.push(
        `[token-goat: ${resolving_count} dependency resolution/download line(s) collapsed; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    if (compiling_count) {
      out.push(`[token-goat: compiled ${compiling_count} Haskell module(s)]`);
    }
    if (linking_count) {
      out.push(
        `[token-goat: ${linking_count} linking/installing/registering step(s) collapsed]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, dropped_warnings, `deduplicated ${dropped_warnings} repeated warning(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// R CMD check regexes (Python ~20754-20806).
// ===========================================================================

/** R CMD check section headers: "* checking ...". */
const _R_CHECKING_RE: RegExp = /^\s*\*\s+checking\s+\S/i;
/** R CMD check passing result: "* checking ... OK" or "... SKIPPED". */
const _R_CHECKING_OK_RE: RegExp = /^\s*\*\s+checking\s+.*\s+(?:OK|SKIPPED)\s*$/i;
/** R CMD check "* DONE (PackageName)" summary — always keep. */
const _R_DONE_RE: RegExp = /^\s*\*\s+DONE\s*\(/i;
/** R CMD check result summary lines: "Status: OK" / "N errors | M warnings | K notes". */
const _R_STATUS_RE: RegExp =
  /^\s*(?:Status:\s+|R\s+CMD\s+check\s+results?|0\s+errors\s+\||\d+\s+errors?\s+\||\d+\s+warning[s]?\s+\||\d+\s+note[s]?\s+\|)/i;
/** R CMD check NOTE/WARNING/ERROR detail headers — always keep. */
const _R_ISSUE_RE: RegExp = /^\s*(?:\*\s+)?(?:ERROR|WARNING|NOTE)[\s:]/i;
/** R CMD check namespace loading / installing / attaching boilerplate (noise). */
const _R_LOADING_RE: RegExp =
  /^\s*(?:\*\s+(?:using\s+R|installing\s+the\s+package|loading\s+the\s+package|preparing\s+'|running\s+'DESCRIPTION'|running\s+'configure')|Loading\s+required\s+(?:package|namespace):\s+\S+|Attaching\s+package:\s+\S+)/i;
/** R CMD check "running examples/tests/vignettes" progress lines. */
const _R_RUNNING_RE: RegExp =
  /^\s*(?:\*\s+(?:running\s+(?:examples|tests|vignettes?|R\s+code|docstest)|checking\s+(?:examples?|test\s+files)))/i;
/** R CMD check "*" / "**" build/prepare/test/install section headers. */
const _R_SECTION_HEADER_RE: RegExp =
  /^\s*\*{1,2}\s+(?:building\s+|preparing\s+|testing\s+|installing\s+|byte.compiling|creating\s+)\S/i;

// ===========================================================================
// RCmdFilter (Python ~20809-20902)
// ===========================================================================

/**
 * Compress `R CMD check` / `R CMD INSTALL` / `Rscript` package output.
 *
 * R CMD check produces a highly structured output with many `* checking ...`
 * lines that all end in `OK` on a passing run; the actual failures (ERROR /
 * WARNING / NOTE) are what matter. `* checking ... OK/SKIPPED` lines are
 * collapsed to a count; `* checking ...` headers without a result suffix are
 * kept (they may precede an error block); loading/attaching namespace
 * boilerplate is dropped; `** building ...` install section headers are counted;
 * `* running examples/tests` progress, `* DONE` / `Status:` summaries, and
 * NOTE/WARNING/ERROR lines are always kept. error_passthrough = true preserves
 * raw stderr on a non-zero exit. Overrides matches() — `R CMD ...` (any case)
 * and bare `Rscript` both fire.
 */
export class RCmdFilter extends Filter {
  override error_passthrough = true;

  override name = "r-cmd";
  override binaries: ReadonlySet<string> = new Set(["r", "rscript"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    // Match `R CMD check`, `R CMD INSTALL`, `Rscript -e 'devtools::check()'`.
    if (stem === "r") {
      const positionals = _positional_args(argv.slice(1));
      return positionals.length > 0 && positionals[0]!.toUpperCase() === "CMD";
    }
    return stem === "rscript";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let ok_count = 0;
    let loading_count = 0;
    let install_section_count = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_R_ISSUE_RE, line)) {
        kept.push(line);
        continue;
      }
      // DONE / Status summary — always keep.
      if (_reMatch(_R_DONE_RE, line) || _reMatch(_R_STATUS_RE, line)) {
        kept.push(line);
        continue;
      }
      // "* checking ... OK" or "... SKIPPED" — count (pure noise on passing runs).
      if (_reMatch(_R_CHECKING_OK_RE, line)) {
        ok_count += 1;
        continue;
      }
      // "* checking ..." without OK suffix — keep (may precede an error block).
      if (_reMatch(_R_CHECKING_RE, line)) {
        kept.push(line);
        continue;
      }
      // Running examples/tests progress — keep.
      if (_reMatch(_R_RUNNING_RE, line)) {
        kept.push(line);
        continue;
      }
      // Loading/attaching namespace boilerplate — drop.
      if (_reMatch(_R_LOADING_RE, line)) {
        loading_count += 1;
        continue;
      }
      // "** building ..." install section headers — count.
      if (_reMatch(_R_SECTION_HEADER_RE, line)) {
        install_section_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (ok_count) {
      out.push(
        `[token-goat: ${ok_count} 'checking ... OK/SKIPPED' line(s) collapsed; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }
    if (install_section_count) {
      out.push(
        `[token-goat: ${install_section_count} R installation section header(s) collapsed]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, loading_count, `dropped ${loading_count} namespace loading/attaching line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}
