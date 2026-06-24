/**
 * Tests for MSBuildFilter, NuGetFilter, and PowerShellFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_windows.py. Every Python `def test_*` maps
 * to a vitest `it()` with the SAME name and assertion polarity; the Python test
 * classes (TestMSBuildFilter*, TestNuGetFilter*, TestPowerShellFilter*) map to
 * `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" (re-exports
 *         MSBuildFilter / NuGetFilter / PowerShellFilter + select_filter).
 *  - `from filter_test_helpers import apply_filter as _apply`
 *      -> local `_apply(filter_, opts?)` helper below; runs
 *         `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *         to `[filter_.name]` (matching the Python helper exactly).
 *  - The Python module instantiates each filter ONCE at module scope
 *    (`_MSBUILD = bc.MSBuildFilter()`, `_NUGET = bc.NuGetFilter()`,
 *    `_PWSH = bc.PowerShellFilter()`) and reuses the instance across tests.
 *    Filter instances are stateless across `apply()` calls (all counters are
 *    locals inside compress()), so the port reuses a single module-scope
 *    instance per filter too — matching the Python exactly.
 *
 * Byte-exactness: the assertions here are substring `in` / `not in` checks. The
 * fixtures are pure ASCII (Windows paths use literal backslashes in JS string
 * literals, escaped as `\\`), so Python `len` (code points) equals JS `.length`
 * equals the UTF-8 byte count — no Buffer arithmetic is needed.
 *
 * NOTE on the `exit_code` arg: the Python `_apply` defaults exit_code to 0; the
 * few tests that pass `exit_code=1` do so via keyword, ported as `{ exit_code: 1 }`.
 */
import { describe, expect, it } from "vitest";

import {
  MSBuildFilter,
  NuGetFilter,
  PowerShellFilter,
  select_filter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_apply` at the Python import site). When argv is omitted the filter's own
// `.name` is used as the sole argv element.
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

// Module-scope filter instances — the Python module instantiates these once at
// import and reuses them; they are stateless across apply() calls.
const _MSBUILD = new MSBuildFilter();
const _NUGET = new NuGetFilter();
const _PWSH = new PowerShellFilter();

// ===========================================================================
// MSBuildFilter — fixtures
// ===========================================================================

const _MSBUILD_TYPICAL =
  'Build started 05/30/2026 10:00:00.\n' +
  'Project "C:\\src\\MyApp.sln" (targets) on node 1.\n' +
  'Project "C:\\src\\MyApp\\MyApp.csproj" (targets) on node 2.\n' +
  "  GenerateResource:\n" +
  "  Csc:\n" +
  "  Link:\n" +
  'Copying file from "obj\\Debug\\MyApp.dll" to "bin\\Debug\\MyApp.dll"\n' +
  'Copying file from "obj\\Debug\\MyApp.pdb" to "bin\\Debug\\MyApp.pdb"\n' +
  'Creating directory "bin\\Debug\\net8.0"\n' +
  'Done building project "MyApp.csproj".\n' +
  "Build succeeded.\n" +
  "    0 Warning(s)\n" +
  "    0 Error(s)\n" +
  "Time Elapsed 00:00:05.12\n";

// ===========================================================================
// MSBuildFilter — matches()
// ===========================================================================

describe("TestMSBuildFilterMatches", () => {
  it("test_msbuild_bare", () => {
    expect(_MSBUILD.matches(["msbuild"])).toBeTruthy();
  });

  it("test_msbuild_exe", () => {
    expect(_MSBUILD.matches(["MSBuild.exe"])).toBeTruthy();
    expect(_MSBUILD.matches(["msbuild.exe"])).toBeTruthy();
  });

  it("test_msbuild_with_args", () => {
    expect(_MSBUILD.matches(["msbuild", "/p:Configuration=Release", "MyApp.sln"])).toBeTruthy();
  });

  it("test_non_msbuild_no_match", () => {
    expect(_MSBUILD.matches(["dotnet"])).toBeFalsy();
    expect(_MSBUILD.matches(["cmake"])).toBeFalsy();
    expect(_MSBUILD.matches([])).toBeFalsy();
  });

  it("test_dispatch_routes_to_msbuild", () => {
    const f = select_filter(["msbuild", "MyApp.sln"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("msbuild");
  });

  it("test_dispatch_routes_msbuild_exe", () => {
    const f = select_filter(["MSBuild.exe", "/t:Build"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("msbuild");
  });
});

// ===========================================================================
// MSBuildFilter — Build succeeded / summary lines
// ===========================================================================

describe("TestMSBuildFilterBuildSucceeded", () => {
  it("test_build_succeeded_preserved", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    expect(result).toContain("Build succeeded.");
  });

  it("test_error_count_line_preserved", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    expect(result).toContain("0 Error(s)");
  });

  it("test_warning_count_line_preserved", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    expect(result).toContain("0 Warning(s)");
  });
});

// ===========================================================================
// MSBuildFilter — Copying file lines
// ===========================================================================

describe("TestMSBuildFilterCopyLines", () => {
  it("test_copy_lines_collapsed_to_note", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    expect(result).toContain("collapsed 2 file-copy lines");
  });

  it("test_copy_lines_not_in_output", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    expect(result).not.toContain("Copying file from");
  });

  it("test_no_copy_no_note", () => {
    const out = "Build started.\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)\n";
    const result = _apply(_MSBUILD, { stdout: out });
    expect(result).not.toContain("file-copy");
  });
});

// ===========================================================================
// MSBuildFilter — Creating directory lines
// ===========================================================================

describe("TestMSBuildFilterMkdirLines", () => {
  it("test_mkdir_lines_collapsed", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    expect(result).toContain("collapsed 1 directory-creation lines");
  });

  it("test_mkdir_text_not_in_output", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    expect(result).not.toContain("Creating directory");
  });
});

// ===========================================================================
// MSBuildFilter — Task-name lines
// ===========================================================================

describe("TestMSBuildFilterTaskLines", () => {
  it("test_task_lines_collapsed", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    expect(result).toContain("collapsed 3 task-name lines");
  });

  it("test_task_lines_not_in_output", () => {
    const result = _apply(_MSBUILD, { stdout: _MSBUILD_TYPICAL });
    // None of "  GenerateResource:", "  Csc:", "  Link:" should appear raw
    expect(result).not.toContain("  GenerateResource:");
    expect(result).not.toContain("  Csc:");
  });
});

// ===========================================================================
// MSBuildFilter — Build started headers
// ===========================================================================

describe("TestMSBuildFilterBuildStartedHeaders", () => {
  it("test_first_build_started_kept", () => {
    const out = [
      "Build started 05/30/2026 10:00:00.",
      'Project "App.sln" (targets) on node 1.',
      'Project "App.sln" (targets) on node 2.',
      "Build succeeded.",
      "    0 Warning(s)",
      "    0 Error(s)",
    ].join("\n");
    const result = _apply(_MSBUILD, { stdout: out });
    expect(result).toContain("Build started");
  });

  it("test_repeated_headers_collapsed", () => {
    const out = [
      "Build started 05/30/2026 10:00:00.",
      "Build started 05/30/2026 10:00:01.",
      "Build succeeded.",
      "    0 Warning(s)",
      "    0 Error(s)",
    ].join("\n");
    const result = _apply(_MSBUILD, { stdout: out });
    expect(result).toContain("collapsed 1 repeated build-started headers");
  });
});

// ===========================================================================
// MSBuildFilter — Error lines
// ===========================================================================

describe("TestMSBuildFilterErrorLines", () => {
  it("test_error_line_kept_verbatim", () => {
    const out =
      "Build started.\n" +
      "src\\MyApp\\Program.cs(10,5): error CS0001: Type or namespace not found\n" +
      "Build FAILED.\n" +
      "    1 Error(s)\n";
    const result = _apply(_MSBUILD, { stdout: out, exit_code: 1 });
    expect(result).toContain("CS0001");
    expect(result).toContain("Program.cs(10,5)");
  });

  it("test_copy_lines_kept_on_failure", () => {
    // On failure, copy lines near an error are still compressed (counts),
    // but the error itself is preserved.
    const out =
      "Copying file from 'a.dll' to 'bin\\a.dll'\n" +
      "src\\Foo.cs(1,1): error CS0001: Bad\n" +
      "    1 Error(s)\n";
    const result = _apply(_MSBUILD, { stdout: out, exit_code: 1 });
    expect(result).toContain("CS0001");
  });
});

// ===========================================================================
// MSBuildFilter — Warnings
// ===========================================================================

describe("TestMSBuildFilterWarnings", () => {
  it("test_warning_kept_first_occurrence", () => {
    const out =
      "Build started.\n" +
      "src\\MyApp\\A.cs(5,3): warning CS0168: Variable declared but never used\n" +
      "Build succeeded.\n" +
      "    1 Warning(s)\n" +
      "    0 Error(s)\n";
    const result = _apply(_MSBUILD, { stdout: out });
    expect(result).toContain("CS0168");
  });

  it("test_duplicate_warning_code_deduped", () => {
    const out =
      "Build started.\n" +
      "src\\A.cs(5,3): warning CS0168: Variable 'x' declared but never used\n" +
      "src\\B.cs(7,3): warning CS0168: Variable 'y' declared but never used\n" +
      "Build succeeded.\n" +
      "    2 Warning(s)\n" +
      "    0 Error(s)\n";
    const result = _apply(_MSBUILD, { stdout: out });
    expect(result).toContain("deduplicated 1 repeated warnings");
  });
});

// ===========================================================================
// MSBuildFilter — Noise lines
// ===========================================================================

describe("TestMSBuildFilterNoiseLines", () => {
  it("test_done_building_dropped_on_success", () => {
    const out =
      "Build started.\n" +
      'Done building project "MyApp.csproj".\n' +
      "Build succeeded.\n" +
      "    0 Warning(s)\n" +
      "    0 Error(s)\n";
    const result = _apply(_MSBUILD, { stdout: out, exit_code: 0 });
    expect(result).not.toContain("Done building");
    expect(result).toContain("dropped");
  });
});

// ===========================================================================
// NuGetFilter — fixtures
// ===========================================================================

const _NUGET_RESTORE_OUTPUT =
  "Restoring packages for C:\\src\\MyApp\\MyApp.csproj...\n" +
  "Installing Newtonsoft.Json 13.0.3\n" +
  "Installing Microsoft.Extensions.Logging 8.0.0\n" +
  "Installing Serilog 3.1.1\n" +
  "OK https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg\n" +
  "OK https://api.nuget.org/v3-flatcontainer/serilog/3.1.1/serilog.3.1.1.nupkg\n" +
  "Package Newtonsoft.Json 13.0.0 is already installed\n" +
  "Successfully installed 'Newtonsoft.Json 13.0.3'\n" +
  "Successfully installed 'Serilog 3.1.1'\n";

// ===========================================================================
// NuGetFilter — matches()
// ===========================================================================

describe("TestNuGetFilterMatches", () => {
  it("test_nuget_bare", () => {
    expect(_NUGET.matches(["nuget"])).toBeTruthy();
  });

  it("test_nuget_exe", () => {
    expect(_NUGET.matches(["nuget.exe"])).toBeTruthy();
    expect(_NUGET.matches(["NuGet.exe"])).toBeTruthy();
  });

  it("test_nuget_with_subcommand", () => {
    expect(_NUGET.matches(["nuget", "restore"])).toBeTruthy();
    expect(_NUGET.matches(["nuget", "install", "Newtonsoft.Json"])).toBeTruthy();
  });

  it("test_non_nuget_no_match", () => {
    expect(_NUGET.matches(["dotnet"])).toBeFalsy();
    expect(_NUGET.matches(["pip"])).toBeFalsy();
    expect(_NUGET.matches([])).toBeFalsy();
  });

  it("test_dispatch_routes_to_nuget", () => {
    const f = select_filter(["nuget", "restore"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("nuget");
  });
});

// ===========================================================================
// NuGetFilter — Installing lines
// ===========================================================================

describe("TestNuGetFilterInstallingLines", () => {
  it("test_installing_lines_collapsed", () => {
    const result = _apply(_NUGET, { stdout: _NUGET_RESTORE_OUTPUT });
    expect(result).toContain("collapsed 3 package-install lines");
  });

  it("test_raw_installing_lines_absent", () => {
    const result = _apply(_NUGET, { stdout: _NUGET_RESTORE_OUTPUT });
    expect(result).not.toContain("Installing Newtonsoft.Json 13.0.3");
    expect(result).not.toContain("Installing Serilog");
  });
});

// ===========================================================================
// NuGetFilter — Restoring packages lines
// ===========================================================================

describe("TestNuGetFilterRestoringLines", () => {
  it("test_single_restoring_line_kept", () => {
    const result = _apply(_NUGET, { stdout: _NUGET_RESTORE_OUTPUT });
    expect(result).toContain("Restoring packages");
  });

  it("test_multiple_restoring_lines_collapsed", () => {
    const out =
      "Restoring packages for C:\\src\\A\\A.csproj...\n" +
      "Restoring packages for C:\\src\\B\\B.csproj...\n" +
      "Restoring packages for C:\\src\\C\\C.csproj...\n";
    const result = _apply(_NUGET, { stdout: out });
    expect(result).toContain("3 projects");
  });

  it("test_raw_restoring_paths_absent_when_multiple", () => {
    const out =
      "Restoring packages for C:\\src\\A\\A.csproj...\n" +
      "Restoring packages for C:\\src\\B\\B.csproj...\n";
    const result = _apply(_NUGET, { stdout: out });
    expect(result).not.toContain("A.csproj");
    expect(result).not.toContain("B.csproj");
  });
});

// ===========================================================================
// NuGetFilter — Download (OK https://) lines
// ===========================================================================

describe("TestNuGetFilterDownloadLines", () => {
  it("test_ok_https_lines_collapsed", () => {
    const result = _apply(_NUGET, { stdout: _NUGET_RESTORE_OUTPUT });
    expect(result).toContain("collapsed 2 package-download lines");
  });

  it("test_raw_urls_absent", () => {
    const result = _apply(_NUGET, { stdout: _NUGET_RESTORE_OUTPUT });
    expect(result).not.toContain("api.nuget.org");
  });
});

// ===========================================================================
// NuGetFilter — Already-installed lines
// ===========================================================================

describe("TestNuGetFilterAlreadyInstalled", () => {
  it("test_already_installed_collapsed", () => {
    const result = _apply(_NUGET, { stdout: _NUGET_RESTORE_OUTPUT });
    expect(result).toContain("collapsed 1 already-installed lines");
  });
});

// ===========================================================================
// NuGetFilter — Successfully installed lines
// ===========================================================================

describe("TestNuGetFilterSuccessfullyInstalled", () => {
  it("test_successfully_installed_collapsed", () => {
    const result = _apply(_NUGET, { stdout: _NUGET_RESTORE_OUTPUT });
    expect(result).toContain("collapsed 2 successfully-installed lines");
  });
});

// ===========================================================================
// NuGetFilter — Errors
// ===========================================================================

describe("TestNuGetFilterErrors", () => {
  it("test_error_line_kept", () => {
    const out =
      "Restoring packages for C:\\src\\MyApp.csproj...\n" +
      "Installing Serilog 3.1.1\n" +
      "error: Unable to find package 'Serilog' with version '99.0'\n";
    const result = _apply(_NUGET, { stdout: out, exit_code: 1 });
    expect(result).toContain("error: Unable to find package");
  });
});

// ===========================================================================
// PowerShellFilter — fixtures
// ===========================================================================

const _PWSH_VERBOSE_OUTPUT =
  "VERBOSE: Loading module 'Pester' version 5.6.0\n" +
  'VERBOSE: Performing the operation "Install-Module" on target "Pester"\n' +
  "VERBOSE: Binding parameter 'Name' to 'Pester'\n" +
  "DEBUG: ParameterSet selected 'NameParameterSet'\n" +
  "DEBUG: Getting module 'Pester'\n" +
  "WARNING: The module 'PSReadLine' is already loaded with version 2.2.6\n" +
  "WARNING: The module 'PSReadLine' is already loaded with version 2.2.6\n" +
  "Install-Module: Installing Pester 5.6.0...\n" +
  "Processing record 1 of 3\n" +
  "Processing record 2 of 3\n" +
  "Processing record 3 of 3\n" +
  "Tests passed: 42\n";

// ===========================================================================
// PowerShellFilter — matches()
// ===========================================================================

describe("TestPowerShellFilterMatches", () => {
  it("test_pwsh", () => {
    expect(_PWSH.matches(["pwsh"])).toBeTruthy();
  });

  it("test_powershell", () => {
    expect(_PWSH.matches(["powershell"])).toBeTruthy();
  });

  it("test_powershell_exe", () => {
    expect(_PWSH.matches(["powershell.exe"])).toBeTruthy();
    expect(_PWSH.matches(["PowerShell.exe"])).toBeTruthy();
  });

  it("test_pwsh_with_args", () => {
    expect(_PWSH.matches(["pwsh", "-File", "deploy.ps1"])).toBeTruthy();
  });

  it("test_non_pwsh_no_match", () => {
    expect(_PWSH.matches(["bash"])).toBeFalsy();
    expect(_PWSH.matches(["cmd"])).toBeFalsy();
    expect(_PWSH.matches([])).toBeFalsy();
  });

  it("test_dispatch_routes_to_powershell", () => {
    const f = select_filter(["pwsh", "-File", "script.ps1"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("powershell");
  });

  it("test_dispatch_powershell_exe", () => {
    const f = select_filter(["powershell.exe", "-Command", "Get-Process"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("powershell");
  });
});

// ===========================================================================
// PowerShellFilter — VERBOSE lines
// ===========================================================================

describe("TestPowerShellFilterVerboseLines", () => {
  it("test_verbose_lines_collapsed", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).toContain("collapsed 3 VERBOSE lines");
  });

  it("test_verbose_lines_absent", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).not.toContain("VERBOSE: Loading module");
    expect(result).not.toContain("VERBOSE: Performing");
  });
});

// ===========================================================================
// PowerShellFilter — DEBUG lines
// ===========================================================================

describe("TestPowerShellFilterDebugLines", () => {
  it("test_debug_lines_collapsed", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).toContain("collapsed 2 DEBUG lines");
  });

  it("test_debug_lines_absent", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).not.toContain("DEBUG: ParameterSet");
  });
});

// ===========================================================================
// PowerShellFilter — WARNING lines
// ===========================================================================

describe("TestPowerShellFilterWarningLines", () => {
  it("test_unique_warning_kept", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).toContain("WARNING: The module 'PSReadLine'");
  });

  it("test_duplicate_warning_deduped", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).toContain("deduplicated 1 repeated warnings");
  });

  it("test_unique_warnings_both_kept", () => {
    const out = "WARNING: Module A is outdated\n" + "WARNING: Module B needs update\n";
    const result = _apply(_PWSH, { stdout: out });
    expect(result).toContain("Module A is outdated");
    expect(result).toContain("Module B needs update");
  });
});

// ===========================================================================
// PowerShellFilter — Install-Module progress lines
// ===========================================================================

describe("TestPowerShellFilterInstallModuleLines", () => {
  it("test_install_module_collapsed", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).toContain("collapsed 1 Install-Module progress lines");
  });

  it("test_install_module_line_absent", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).not.toContain("Install-Module: Installing Pester");
  });
});

// ===========================================================================
// PowerShellFilter — Progress-record lines
// ===========================================================================

describe("TestPowerShellFilterProgressRecords", () => {
  it("test_progress_records_collapsed", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).toContain("collapsed 3 progress-record lines");
  });

  it("test_progress_lines_absent", () => {
    const result = _apply(_PWSH, { stdout: _PWSH_VERBOSE_OUTPUT });
    expect(result).not.toContain("Processing record 1 of 3");
    expect(result).not.toContain("Processing record 3 of 3");
  });
});

// ===========================================================================
// PowerShellFilter — Terminating errors
// ===========================================================================

describe("TestPowerShellFilterTerminatingError", () => {
  it("test_terminating_error_block_kept", () => {
    const out =
      "VERBOSE: Trying something\n" +
      "At C:\\scripts\\deploy.ps1:42 char:5\n" +
      "+ Connect-AzAccount -TenantId $tenantId\n" +
      "+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n" +
      "CategoryInfo          : AuthenticationError\n" +
      "FullyQualifiedErrorId : AuthenticationException\n";
    const result = _apply(_PWSH, { stdout: out, exit_code: 1 });
    expect(result).toContain("At C:\\scripts\\deploy.ps1:42 char:5");
    expect(result).toContain("CategoryInfo");
    expect(result).toContain("FullyQualifiedErrorId");
  });

  it("test_error_signal_line_kept", () => {
    const out =
      "VERBOSE: Setting up...\n" +
      "VERBOSE: Connecting...\n" +
      "Error: Connection refused to server 'prod-db'\n";
    const result = _apply(_PWSH, { stdout: out, exit_code: 1 });
    expect(result).toContain("Connection refused");
  });
});

// ===========================================================================
// PowerShellFilter — Clean output (no noise)
// ===========================================================================

describe("TestPowerShellFilterCleanOutput", () => {
  it("test_regular_output_lines_preserved", () => {
    const out = "VERBOSE: Loading...\n" + "Tests passed: 42\n" + "All done.\n";
    const result = _apply(_PWSH, { stdout: out });
    expect(result).toContain("Tests passed: 42");
    expect(result).toContain("All done.");
  });

  it("test_no_noise_no_note", () => {
    const out = "Tests passed: 10\nAll done.\n";
    const result = _apply(_PWSH, { stdout: out });
    expect(result).not.toContain("collapsed");
    expect(result).not.toContain("deduplicated");
  });
});
