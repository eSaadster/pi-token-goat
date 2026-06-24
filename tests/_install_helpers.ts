/**
 * Shared helpers for the install test port.
 *
 * The Python tests monkeypatch sys.platform / Path.home() / winreg /
 * subprocess.run freely. In the TS port:
 *
 *  - install.ts captures `_PLATFORM = process.platform` at module load and
 *    `_isWin32()/_isDarwin()` read that frozen constant. To exercise a different
 *    platform we redefine `process.platform`, `vi.resetModules()`, and
 *    dynamic-import a FRESH install module graph (install + paths + worker from
 *    the same reset graph). `loadInstall(platform)` returns that bundle.
 *  - `Path.home()` -> `os.homedir()`, which on POSIX/Win reads `$HOME` /
 *    `%USERPROFILE%`. `withFakeHome()` points it at a tmp dir.
 *  - `subprocess.run` -> the injectable `setSubprocessRunner` seam.
 *  - `winreg` -> the injectable `setWinregBackend` seam.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { vi } from "vitest";

import * as installStatic from "../src/token_goat/install.js";
import * as pathsStatic from "../src/token_goat/paths.js";

export type InstallModule = typeof installStatic;
export type PathsModule = typeof pathsStatic;

export interface InstallBundle {
  install: InstallModule;
  paths: PathsModule;
  worker: typeof import("../src/token_goat/worker.js");
  reset: typeof import("../src/token_goat/reset.js");
}

const _origPlatform = process.platform;

/** Redefine process.platform for the rest of the current test. */
export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Restore the real platform (call in afterEach). */
export function restorePlatform(): void {
  Object.defineProperty(process, "platform", { value: _origPlatform, configurable: true });
}

/**
 * Load a FRESH install module graph pinned to *platform*.
 *
 * Sets process.platform, resets the module registry, then dynamic-imports
 * install/paths/worker/reset so they all share one fresh graph (so spying on
 * the returned `paths`/`worker` affects the returned `install`). The caller is
 * responsible for restoring platform + data-dir override afterwards.
 */
export async function loadInstall(
  platform: NodeJS.Platform,
  dataDir?: string,
): Promise<InstallBundle> {
  setPlatform(platform);
  vi.resetModules();
  const reset = await import("../src/token_goat/reset.js");
  const paths = await import("../src/token_goat/paths.js");
  const worker = await import("../src/token_goat/worker.js");
  const install = await import("../src/token_goat/install.js");
  if (dataDir) {
    reset.setDataDirOverride(dataDir);
  }
  return { install, paths, worker, reset };
}

/** Create a fresh fake home dir under tmp and point os.homedir() at it. */
export function withFakeHome(): { home: string; restore: () => void } {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-home-"));
  const realHome = fs.realpathSync(home);
  const prevHome = process.env["HOME"];
  const prevUserProfile = process.env["USERPROFILE"];
  process.env["HOME"] = realHome;
  process.env["USERPROFILE"] = realHome;
  return {
    home: realHome,
    restore: () => {
      if (prevHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = prevHome;
      }
      if (prevUserProfile === undefined) {
        delete process.env["USERPROFILE"];
      } else {
        process.env["USERPROFILE"] = prevUserProfile;
      }
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/** Make a throwaway tmp dir; returns its realpath. */
export function mkTmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-tmp-")));
}

/** Build a fake winreg backend backed by an in-memory map. */
export function makeFakeWinreg(initial: Record<string, string> = {}): {
  backend: installStatic.WinregBackend;
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  const backend: installStatic.WinregBackend = {
    readRunValue(name: string): string | null {
      return store.has(name) ? store.get(name)! : null;
    },
    setRunValue(name: string, value: string): void {
      store.set(name, value);
    },
    deleteRunValue(name: string): void {
      if (!store.has(name)) {
        const err = new Error("not found") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      store.delete(name);
    },
  };
  return { backend, store };
}
