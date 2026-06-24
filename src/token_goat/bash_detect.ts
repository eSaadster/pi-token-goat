/**
 * Lightweight bash-filter detection module — no regex compilation.
 *
 * Provides a single function, {@link detect}, that answers "does bash_compress
 * have a filter for this command?" using a static binary->filter_name lookup
 * table. This module imports in <1 ms (vs ~75 ms for bash_compress which
 * compiles 737+ regexes at module load time).
 *
 * The hook layer imports this module on every Bash pre-hook invocation to decide
 * whether to proceed with compression. Only when a filter IS found does the hook
 * import the full bash_compress module; unrecognised commands pay zero regex cost.
 *
 * The table is generated from bash_compress.FILTERS at development time. Update
 * it when filters are added or removed from that list.
 */

import { SeverityLogFilter } from "./bash_compress.js";

/**
 * pathlib.PurePath(p).name — the final path component.
 */
function _pathName(p: string): string {
  // Strip trailing slashes (Path("a/b/") -> name "b"), then take the last
  // component after the final "/".
  let s = p;
  while (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  const slash = s.lastIndexOf("/");
  return slash === -1 ? s : s.slice(slash + 1);
}

/**
 * pathlib.PurePath(p).stem — the final component with its LAST suffix removed.
 * Path.stem strips only the final extension (".tar.gz" -> stem "archive.tar"),
 * and a leading-dot dotfile with no other dot has an empty suffix (".bashrc"
 * -> stem ".bashrc"). A trailing dot is not a suffix.
 */
function _pathStem(p: string): string {
  const name = _pathName(p);
  const dot = name.lastIndexOf(".");
  // A dot at index 0 is not a suffix separator (".bashrc" -> ".bashrc").
  if (dot <= 0) {
    return name;
  }
  // A trailing dot is not a suffix ("foo." -> stem "foo.").
  if (dot === name.length - 1) {
    return name;
  }
  return name.slice(0, dot);
}

/**
 * Maps binary stem (lowercased) to the name of the first-matching filter in
 * bash_compress.FILTERS. First-match semantics mirror select_filter() so the
 * detection result is consistent with what full compression would use.
 * Generated from bash_compress.FILTERS (134 filters, 229 binaries).
 */
export const _BINARY_TO_FILTER: Record<string, string> = {
  "./mvnw": "maven",
  "@biomejs/biome": "biome",
  "ack": "grep",
  "ack-grep": "grep",
  "act": "act",
  "ag": "grep",
  "aider": "aider",
  "ansible": "ansible",
  "ansible-console": "ansible",
  "ansible-galaxy": "ansible",
  "ansible-lint": "ansible",
  "ansible-playbook": "ansible",
  "ansible-pull": "ansible",
  "ant": "ant",
  "apk": "sys-pkg",
  "apt": "sys-pkg",
  "apt-cache": "sys-pkg",
  "apt-get": "sys-pkg",
  "ava": "jest",
  "aws": "aws-cli",
  "aws2": "aws-cli",
  "az": "azure-cli",
  "bandit": "bandit",
  "bat": "bat",
  "batcat": "bat",
  "bazel": "bazel",
  "bazelisk": "bazel",
  "biome": "biome",
  "black": "black-isort",
  "brew": "sys-pkg",
  "buck": "make",
  "buf": "protoc",
  "buildah": "docker",
  "bun": "bun",
  "bundle": "bundler",
  "bundler": "bundler",
  "bunx": "bun",
  "cabal": "haskell",
  "cargo": "cargo",
  "ccmake": "cmake",
  "cdk": "cdk",
  "clang-tidy": "clang-tidy",
  "claude": "claude-cli",
  "claude-dev": "cline",
  "cline": "cline",
  "cmake": "cmake",
  "cypress": "cypress",
  "colordiff": "diff",
  "composer": "composer",
  "composer.phar": "composer",
  "conan": "conan",
  "conan2": "conan",
  "codex": "codex-exec",
  "conda": "conda",
  "continue": "continue",
  "copilot": "copilot",
  "cpack": "cmake",
  "cppcheck": "cppcheck",
  "crystal": "crystal",
  "ctest": "cmake",
  "curl": "curl",
  "cursor": "cursor",
  "dart": "dart",
  "delta": "delta",
  "deno": "deno",
  "diff": "diff",
  "diff3": "diff",
  "dir": "ls",
  "dmypy": "mypy",
  "docker": "docker-compose",
  "docker-compose": "docker-compose",
  "dotenv": "dotenv",
  "dotnet": "dotnet",
  "egrep": "grep",
  "elm": "elm",
  "env": "env",
  "esbuild": "webpack",
  "eslint": "eslint",
  "exa": "eza",
  "eza": "ls",
  "fd": "fd",
  "fdfind": "fd",
  "ffmpeg": "ffmpeg",
  "ffplay": "ffmpeg",
  "ffprobe": "ffmpeg",
  "fgrep": "grep",
  "find": "fd", // plain-path output matches fd; -ls/-printf formats truncated at line boundaries
  "flutter": "flutter",
  "fly": "fly",
  "flyctl": "fly",
  "forge": "forge",
  "fzf": "fzf",
  "gcloud": "gcloud",
  "gem": "gem",
  "gemini": "gemini-cli",
  "gh": "gh-copilot",
  "ghc": "haskell",
  "git": "git-log",
  "gmake": "make",
  "go": "go-test",
  "goimports": "make",
  "golangci-lint": "golangci-lint",
  "gradle": "gradle",
  "gradlew": "gradle",
  "grep": "rg",
  "hardhat": "hardhat",
  "helm": "helm",
  "isort": "black-isort",
  "javac": "javac",
  "jest": "jest",
  "jq": "jq",
  "json": "json_array",
  "julia": "julia",
  "k": "kubectl-logs",
  "k9s": "kubectl",
  "ktlint": "ktlint",
  "kubectl": "kubectl-logs",
  "lazygit": "lazygit",
  "lerna": "lerna",
  "lessc": "sass",
  "ll": "ls",
  "ls": "ls",
  "make": "make",
  "mamba": "conda",
  "maven": "make",
  "meson": "meson",
  "micromamba": "conda",
  "minitest": "ruby",
  "mix": "mix",
  "mocha": "jest",
  "msbuild": "msbuild",
  "msbuild.exe": "msbuild",
  "mvn": "maven",
  "mvnw": "maven",
  "mypy": "mypy",
  "mysql": "mysql",
  "mysqldump": "mysql",
  "nerdctl": "docker",
  "ninja": "make",
  "nix": "nix",
  "nix-build": "nix",
  "nix-env": "nix",
  "nix-shell": "nix",
  "nix-store": "nix",
  "nixos-rebuild": "nix",
  "node": "node",
  "node-sass": "sass",
  "ng": "ng",
  "nodejs": "node",
  "nox": "nox",
  "npm": "npm_install",
  "npx": "nx",
  "nuget": "nuget",
  "nuget.exe": "nuget",
  "nx": "nx",
  "oc": "kubectl",
  "opencode": "opencode",
  "oxc_linter": "oxlint",
  "oxlint": "oxlint",
  "packer": "packer",
  "phpstan": "phpstan",
  "phpstan.phar": "phpstan",
  "pip": "dep-list",
  "pip3": "dep-list",
  "pipx": "pip",
  "playwright": "playwright",
  "poetry": "dep-list",
  "pnpm": "pnpm",
  "pnpx": "nx",
  "podman": "docker",
  "powershell": "powershell",
  "powershell.exe": "powershell",
  "pre-commit": "pre-commit",
  "prettier": "prettier",
  "printenv": "env",
  "protoc": "protoc",
  "protoc-gen-go": "protoc",
  "protoc-gen-grpc": "protoc",
  "ps": "ps",
  "psalm": "phpstan",
  "psalm.phar": "phpstan",
  "psql": "psql",
  "pstree": "ps",
  "pub": "pub",
  "pulumi": "pulumi",
  "pwsh": "powershell",
  "py.test": "pytest",
  "pylint": "pylint",
  "pyright": "linter",
  "pytest": "pytest",
  "python": "python",
  "python3": "python",
  "python3.11": "python",
  "python3.12": "python",
  "python3.13": "python",
  "r": "r-cmd",
  "rake": "ruby",
  "rebar": "rebar3",
  "rebar3": "rebar3",
  "redis-cli": "redis-cli",
  "rg": "rg",
  "rome": "linter",
  "rscript": "r-cmd",
  "rspec": "ruby",
  "rspec2": "ruby",
  "rsync": "rsync",
  "ruby": "ruby",
  "ruff": "ruff",
  "run-clang-tidy": "clang-tidy",
  "run-clang-tidy.py": "clang-tidy",
  "runghc": "haskell",
  "runhaskell": "haskell",
  "sass": "sass",
  "sbt": "sbt",
  "scss": "sass",
  "sdiff": "diff",
  "semgrep": "semgrep",
  "serverless": "serverless",
  "shards": "crystal",
  "sls": "serverless",
  "snyk": "snyk",
  "sqlite3": "sqlite3",
  "stack": "haskell",
  "stylelint": "linter",
  "swift": "swift",
  "swiftlint": "swiftlint",
  "tap": "jest",
  "tasklist": "ps",
  "terraform": "terraform",
  "terragrunt": "terraform",
  "tofu": "terraform",
  "top": "ps",
  "tox": "tox",
  "tree": "tree",
  "trivy": "trivy",
  "tsc": "tsc",
  "turbo": "turbo",
  "uv": "dep-list",
  "vault": "vault",
  "vcpkg": "vcpkg",
  "vite": "webpack",
  "vitest": "vitest",
  "wasm-pack": "wasm-pack",
  "wc": "wc",
  "wdiff": "diff",
  "wget": "curl",
  "windsurf": "windsurf",
  "webpack": "webpack",
  "webpack-cli": "webpack",
  "wrangler": "wrangler",
  "wrangler2": "wrangler",
  "xcodebuild": "xcode",
  "xxd": "xxd",
  "yarn": "yarn",
  "yq": "yq",
  "zig": "zig",
  // Binary inspection
  "file": "file",
  "hd": "xxd",
  "hexdump": "xxd",
  "od": "xxd",
};

/**
 * Return the filter name for *argv*, or `null` if no filter matches.
 *
 * Checks the binary stem (`Path(argv[0]).stem.lower()`) against the static
 * lookup table. Returns the filter name string (e.g. `"pytest"`) when a
 * match is found, `null` otherwise.
 *
 * When no binary-level match is found and *stdout* is provided, a content-
 * based fallback routes JSON array output (stripped stdout starts with `[`)
 * to the `"json_array"` filter regardless of the command name.
 *
 * This function intentionally does NOT check subcommands — that finer
 * discrimination is left to bash_compress.select_filter() which is only
 * called when this function confirms a filter exists for the binary.
 */
export function detect(argv: string[], opts?: { stdout?: string }): string | null {
  const stdout = opts?.stdout ?? "";
  if (argv.length === 0) {
    return null;
  }
  const stem = _pathStem(argv[0]!.replace(/\\/g, "/")).toLowerCase();
  const result = _BINARY_TO_FILTER[stem];
  if (result !== undefined) {
    return result;
  }
  // Content-based fallback: JSON array output from any unknown command.
  if (stdout && stdout.trim().startsWith("[")) {
    return "json_array";
  }
  // Content-based fallback: structured log stream detection.
  if (stdout) {
    if (new SeverityLogFilter().detect(stdout)) {
      return "severity_log";
    }
  }
  return null;
}
