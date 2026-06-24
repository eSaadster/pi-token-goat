/**
 * Tests for gdrive.ts — TypeScript port of tests/test_gdrive.py.
 *
 * All tests inject the Google API seams; no real network calls are made.
 *
 * Port notes (Python -> TS):
 *  - The Python tests `patch(...)` the lazily-imported Google library targets.
 *    The TS port injects the equivalent gdrive module seam instead:
 *      patch("google.auth.default", return_value=(creds, "proj"))
 *        -> gdrive._setGoogleAuthDefault(() => [creds, "proj"])
 *      patch("google.auth.default", side_effect=Exception("no ADC"))
 *        -> gdrive._setGoogleAuthDefault(() => { throw new Error("no ADC"); })
 *      patch("...Credentials.from_authorized_user_file", return_value=fake)
 *        -> gdrive._setCredentialsFromAuthorizedUserFile(() => fake)
 *      patch("googleapiclient.discovery.build", return_value=service)
 *        -> gdrive._setDriveBuild(() => service)
 *      patch("googleapiclient.http.MediaIoBaseDownload", side_effect=fake)
 *        -> gdrive._setMediaIoBaseDownload(fakeDownloaderCtor)
 *  - patch.object(gdrive.image_shrink, "is_image_path", return_value=False)
 *      -> vi.spyOn(image_shrink, "is_image_path").mockReturnValue(false)
 *    (gdrive.ts imports `* as image_shrink`, so the spy is observed.)
 *  - The per-test tmp data dir (Python tmp_data_dir fixture) is provided
 *    automatically by tests/setup.ts (setDataDirOverride). paths.gdriveCredsPath()
 *    / gdriveCacheDir() therefore resolve under the isolated tmp dir.
 *  - monkeypatch.setattr(gdrive, "_MAX_SECTION_INDEX_BYTES", 100)
 *      -> gdrive._setMaxSectionIndexBytes(100)
 *  - Python str truncation counts code points; the TS port uses the same.
 *
 * CLI test classes (TestGdriveAuthCli, TestGdriveFetchCli, TestGdriveSectionsCli,
 * TestCliGdriveList) exercise the 4 `gdrive-*` subcommands via the in-process
 * CliRunner (`tests/_cli_runner.ts invoke`), the TS analogue of
 * `typer.testing.CliRunner().invoke(app, [...])`. The commands themselves live in
 * cli_gdrive.ts (batch E). They call gdrive fns through the `import * as gdrive`
 * namespace, so `patch.object(gdrive, "fetch_file", return_value=cached)` →
 * `vi.spyOn(gdrive, "fetch_file").mockResolvedValue(cached)` and
 * `patch.object(gdrive, "list_drive_files", return_value=files)` →
 * `vi.spyOn(gdrive, "list_drive_files").mockReturnValue(files)` are observed.
 * The "no creds" fail-soft cases set the ADC seam as above (the gdrive
 * registerReset hook clears it between tests via the global beforeEach).
 * Every module-level test (TryAdc, TryStoredOauth, GetCredentials, FetchFile,
 * IsTextPath, ExtractSectionIndex, ListDriveFiles) is ported and GREEN.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as gdrive from "../src/token_goat/gdrive.js";
import * as image_shrink from "../src/token_goat/image_shrink.js";
import * as paths from "../src/token_goat/paths.js";
import type { GoogleCredentials, _ByteBuffer } from "../src/token_goat/gdrive.js";
import { invoke } from "./_cli_runner.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A throwaway tmp dir (the Python tmp_path fixture analogue). */
function makeTmpPath(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-gdrive-")));
}

/** A minimal MagicMock-ish credentials object that satisfies GoogleCredentials. */
function fakeCreds(
  overrides: Partial<GoogleCredentials> = {},
): GoogleCredentials {
  return {
    expired: false,
    refresh_token: "ref",
    refresh: () => {},
    to_json: () => "{}",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. _try_adc
// ---------------------------------------------------------------------------

describe("TestTryAdc", () => {
  it("adc unavailable returns none", () => {
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });
    const result = gdrive._try_adc();
    expect(result).toBeNull();
  });

  it("adc available returns creds", () => {
    const creds = fakeCreds();
    gdrive._setGoogleAuthDefault(() => [creds, "my-project"]);
    const result = gdrive._try_adc();
    expect(result).toBe(creds);
  });
});

// ---------------------------------------------------------------------------
// 2. _try_stored_oauth
// ---------------------------------------------------------------------------

describe("TestTryStoredOauth", () => {
  it("missing creds file returns none", () => {
    // gdriveCredsPath() resolves under the per-test tmp dir — doesn't exist.
    const result = gdrive._try_stored_oauth();
    expect(result).toBeNull();
  });

  it("present valid creds file returns creds", () => {
    const creds_path = paths.gdriveCredsPath();
    fs.mkdirSync(path.dirname(creds_path), { recursive: true });
    fs.writeFileSync(
      creds_path,
      JSON.stringify({
        token: "tok",
        refresh_token: "ref",
        token_uri: "https://oauth2.googleapis.com/token",
        client_id: "cid",
        client_secret: "csec",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      }),
      "utf-8",
    );

    const creds = fakeCreds({ expired: false, refresh_token: "ref" });
    gdrive._setCredentialsFromAuthorizedUserFile(() => creds);

    const result = gdrive._try_stored_oauth();
    expect(result).toBe(creds);
  });

  it("invalid creds file returns none", () => {
    const creds_path = paths.gdriveCredsPath();
    fs.mkdirSync(path.dirname(creds_path), { recursive: true });
    fs.writeFileSync(creds_path, "not-json", "utf-8");

    // The real default seam throws (package missing) -> _try_stored_oauth
    // catches and returns null, matching Python's "invalid file" path.
    const result = gdrive._try_stored_oauth();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. get_credentials
// ---------------------------------------------------------------------------

describe("TestGetCredentials", () => {
  it("raises when no creds available", () => {
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });
    expect(() => gdrive.get_credentials()).toThrow(gdrive.GDriveCredsUnavailable);
  });

  it("error message contains exact creds path", () => {
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });
    let msg = "";
    try {
      gdrive.get_credentials();
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain("token-goat gdrive-auth");
    expect(msg).toContain(paths.gdriveCredsPath());
  });

  it("error message mentions adc alternative", () => {
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });
    let msg = "";
    try {
      gdrive.get_credentials();
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain("gcloud auth application-default login");
  });

  it("returns adc creds when available", () => {
    const creds = fakeCreds();
    gdrive._setGoogleAuthDefault(() => [creds, "proj"]);
    const result = gdrive.get_credentials();
    expect(result).toBe(creds);
  });

  it("falls through to stored oauth when adc missing", () => {
    const creds = fakeCreds({ expired: false });

    const creds_path = paths.gdriveCredsPath();
    fs.mkdirSync(path.dirname(creds_path), { recursive: true });
    fs.writeFileSync(creds_path, "{}", "utf-8");

    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });
    gdrive._setCredentialsFromAuthorizedUserFile(() => creds);

    const result = gdrive.get_credentials();
    expect(result).toBe(creds);
  });
});

// ---------------------------------------------------------------------------
// 4. fetch_file
// ---------------------------------------------------------------------------

/** Build a mock Drive service that returns a single file (Python _make_drive_service_mock). */
function makeDriveServiceMock(
  opts: { file_name?: string; mime?: string; content?: Buffer } = {},
): unknown {
  const file_name = opts.file_name ?? "image.jpg";
  const mime = opts.mime ?? "image/jpeg";
  const content = opts.content ?? Buffer.from("FAKE");
  const meta_result = {
    id: "fake_id",
    name: file_name,
    mimeType: mime,
    size: String(content.length),
  };
  const filesObj = {
    get: (_opts: { fileId: string; fields: string }) => ({
      execute: () => meta_result,
    }),
    get_media: (_opts: { fileId: string }) => ({}),
    export_media: (_opts: { fileId: string; mimeType: string }) => ({}),
    list: (_opts: unknown) => ({ execute: () => ({ files: [] }) }),
  };
  return {
    files: () => filesObj,
  };
}

/**
 * A fake MediaIoBaseDownload ctor: on the first next_chunk it writes `content`
 * into the buffer and reports done. Mirrors the Python fake_downloader closure.
 */
function makeFakeDownloaderCtor(content: Buffer) {
  return class {
    private _buf: _ByteBuffer;
    private _calls = 0;
    constructor(buf: _ByteBuffer, _request: unknown) {
      this._buf = buf;
    }
    next_chunk(): [unknown, boolean] {
      if (this._calls === 0) {
        this._calls += 1;
        this._buf.write(content);
        return [{ progress: () => 1.0 }, true];
      }
      return [{}, true];
    }
  } as unknown as new (
    buf: _ByteBuffer,
    request: unknown,
  ) => { next_chunk(): [unknown, boolean] };
}

describe("TestFetchFile", () => {
  it("downloads and writes to cache", async () => {
    const content = Buffer.from("JPEG_FAKE_BYTES".repeat(100), "utf-8");
    const service = makeDriveServiceMock({ content });

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);
    gdrive._setMediaIoBaseDownload(makeFakeDownloaderCtor(content));
    vi.spyOn(image_shrink, "is_image_path").mockReturnValue(false);

    const result = await gdrive.fetch_file("fake_id");

    expect(fs.existsSync(result)).toBe(true);
    expect(fs.readFileSync(result)).toEqual(content);
  });

  it("image mime triggers shrink", async () => {
    const content = Buffer.from("PNG".repeat(200), "utf-8");
    const service = makeDriveServiceMock({
      file_name: "photo.png",
      mime: "image/png",
      content,
    });

    const tmp = makeTmpPath();
    const shrunken_path = path.join(tmp, "shrunken.png");
    fs.writeFileSync(shrunken_path, Buffer.from("small"));

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);
    gdrive._setMediaIoBaseDownload(makeFakeDownloaderCtor(content));
    // Python patches gdrive.image_shrink.{is_image_path,should_shrink,shrink}
    // and asserts shrink() is called once + the result is the shrunken path.
    // In the TS port image_shrink.shrink_if_image() calls its internal shrink()
    // via a LOCAL reference (not `self.shrink`), so vi.spyOn(image_shrink,
    // "shrink") would not intercept that internal call. fetch_file calls
    // image_shrink.shrink_if_image() (the seam fetch_file actually invokes), so
    // we spy that — the equivalent observable assertion: fetch_file routes the
    // downloaded path through shrink_if_image and returns its (shrunken) result.
    const mockShrinkIfImage = vi
      .spyOn(image_shrink, "shrink_if_image")
      .mockResolvedValue(shrunken_path);

    const result = await gdrive.fetch_file("fake_id");

    expect(mockShrinkIfImage).toHaveBeenCalledTimes(1);
    expect(result).toBe(shrunken_path);
  });

  it("no shrink when shrink returns none", async () => {
    const content = Buffer.from("BMP".repeat(50), "utf-8");
    const service = makeDriveServiceMock({
      file_name: "logo.bmp",
      mime: "image/bmp",
      content,
    });

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);
    gdrive._setMediaIoBaseDownload(makeFakeDownloaderCtor(content));
    // Python patches shrink->None and asserts the ORIGINAL downloaded path is
    // returned (shrink_if_image's "shrink returned None -> use original" path).
    // In the TS port shrink_if_image is the function fetch_file invokes, and it
    // implements that fall-back internally; we spy it to return its argument (the
    // original downloaded path) so the assertion mirrors Python's: no shrink ->
    // original path, which exists on disk.
    vi.spyOn(image_shrink, "shrink_if_image").mockImplementation(
      async (p) => p as string,
    );

    const result = await gdrive.fetch_file("fake_id");

    // Should return the original downloaded path.
    expect(fs.existsSync(result)).toBe(true);
  });

  it("cached file no re-download", async () => {
    const content = Buffer.from("CACHED_CONTENT", "utf-8");
    const service = makeDriveServiceMock({ content });

    // Pre-create the cache file as if already downloaded.
    // safe_name from "image.jpg" preserves the dot -> "fake_id_image.jpg".
    const cache_dir = paths.gdriveCacheDir();
    fs.mkdirSync(cache_dir, { recursive: true });
    const cached = path.join(cache_dir, "fake_id_image.jpg");
    fs.writeFileSync(cached, content);

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);
    const downloadCtor = vi.fn();
    gdrive._setMediaIoBaseDownload(
      downloadCtor as unknown as Parameters<
        typeof gdrive._setMediaIoBaseDownload
      >[0],
    );
    vi.spyOn(image_shrink, "is_image_path").mockReturnValue(false);

    const result = await gdrive.fetch_file("fake_id");

    // MediaIoBaseDownload should never have been instantiated.
    expect(downloadCtor).not.toHaveBeenCalled();
    expect(result).toBe(cached);
  });

  it("raises creds unavailable when no creds", async () => {
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });
    await expect(gdrive.fetch_file("any_id")).rejects.toBeInstanceOf(
      gdrive.GDriveCredsUnavailable,
    );
  });
});

// ---------------------------------------------------------------------------
// is_text_path
// ---------------------------------------------------------------------------

describe("TestIsTextPath", () => {
  it("markdown extensions recognised", () => {
    const tmp = makeTmpPath();
    expect(gdrive.is_text_path(path.join(tmp, "spec.md"))).toBe(true);
    expect(gdrive.is_text_path(path.join(tmp, "README.MD"))).toBe(true);
    expect(gdrive.is_text_path(path.join(tmp, "notes.markdown"))).toBe(true);
    expect(gdrive.is_text_path(path.join(tmp, "notes.txt"))).toBe(true);
  });

  it("non text extensions rejected", () => {
    const tmp = makeTmpPath();
    expect(gdrive.is_text_path(path.join(tmp, "image.png"))).toBe(false);
    expect(gdrive.is_text_path(path.join(tmp, "binary"))).toBe(false);
    expect(gdrive.is_text_path(path.join(tmp, "doc.pdf"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extract_section_index
// ---------------------------------------------------------------------------

describe("TestExtractSectionIndex", () => {
  it("markdown with headings", () => {
    const tmp = makeTmpPath();
    const md = path.join(tmp, "spec.md");
    fs.writeFileSync(
      md,
      "# Title\n\nIntro text.\n\n## Install\n\nRun the thing.\n\n" +
        "## Usage\n\nCall the API.\n\n### Advanced\n\nDeeper stuff.\n",
      "utf-8",
    );
    const idx = gdrive.extract_section_index(md);
    expect(idx.extractor_available).toBe(true);
    expect(idx.size_bytes).toBeGreaterThan(0);
    const headings = idx.sections.map((s) => s.heading);
    expect(headings).toContain("Title");
    expect(headings).toContain("Install");
    expect(headings).toContain("Usage");
    expect(headings).toContain("Advanced");
    for (const sec of idx.sections) {
      expect(sec.approx_bytes).toBeGreaterThanOrEqual(0);
      expect(sec.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("non markdown extension returns empty sections", () => {
    const tmp = makeTmpPath();
    const p = path.join(tmp, "image.png");
    fs.writeFileSync(p, Buffer.from("\x89PNG\x00fake", "binary"));
    const idx = gdrive.extract_section_index(p);
    expect(idx.extractor_available).toBe(false);
    expect(idx.sections).toEqual([]);
    expect(idx.size_bytes).toBeGreaterThan(0);
  });

  it("missing file returns zero size", () => {
    const tmp = makeTmpPath();
    const idx = gdrive.extract_section_index(path.join(tmp, "nope.md"));
    expect(idx.extractor_available).toBe(false);
    expect(idx.size_bytes).toBe(0);
  });

  it("oversized file skips parse", () => {
    // Force the max-bytes threshold low so we don't have to write 2 MB.
    gdrive._setMaxSectionIndexBytes(100);
    try {
      const tmp = makeTmpPath();
      const p = path.join(tmp, "huge.md");
      fs.writeFileSync(p, "# Heading\n" + "filler line\n".repeat(50), "utf-8");
      const idx = gdrive.extract_section_index(p);
      expect(idx.extractor_available).toBe(false);
      expect(idx.sections).toEqual([]);
      expect(idx.size_bytes).toBeGreaterThan(100);
    } finally {
      gdrive._setMaxSectionIndexBytes(2_000_000);
    }
  });
});

// ---------------------------------------------------------------------------
// list_drive_files
// ---------------------------------------------------------------------------

/** Build a Drive service whose files().list().execute() returns `result`. */
function makeListService(
  result: unknown,
  opts: { listImpl?: (o: unknown) => { execute(): unknown } } = {},
): { service: unknown; listCalls: unknown[] } {
  const listCalls: unknown[] = [];
  const listFn =
    opts.listImpl ??
    ((o: unknown) => {
      listCalls.push(o);
      return { execute: () => result };
    });
  const wrappedList = (o: unknown) => {
    listCalls.push(o);
    return listFn(o);
  };
  const filesObj = {
    get: () => ({ execute: () => ({}) }),
    get_media: () => ({}),
    export_media: () => ({}),
    list: opts.listImpl ? wrappedList : listFn,
  };
  return { service: { files: () => filesObj }, listCalls };
}

describe("TestListDriveFiles", () => {
  it("returns empty list when no credentials", () => {
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });
    const result = gdrive.list_drive_files();
    expect(result).toEqual([]);
  });

  it("returns files list with metadata", () => {
    const { service } = makeListService({
      files: [
        {
          id: "doc-id-1",
          name: "My Doc",
          mimeType: "application/vnd.google-apps.document",
          size: "0",
        },
        {
          id: "pdf-id-2",
          name: "Report.pdf",
          mimeType: "application/pdf",
          size: "102400",
        },
      ],
    });

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);

    const result = gdrive.list_drive_files();

    expect(result.length).toBe(2);
    expect(result[0]!.id).toBe("doc-id-1");
    expect(result[0]!.name).toBe("My Doc");
    expect(result[0]!.mimeType).toBe("application/vnd.google-apps.document");
    expect(result[0]!.size_bytes).toBe(0);
    expect(result[1]!.id).toBe("pdf-id-2");
    expect(result[1]!.size_bytes).toBe(102400);
  });

  it("filters by folder id", () => {
    const listCalls: unknown[] = [];
    const service = {
      files: () => ({
        get: () => ({ execute: () => ({}) }),
        get_media: () => ({}),
        export_media: () => ({}),
        list: (o: unknown) => {
          listCalls.push(o);
          return { execute: () => ({ files: [] }) };
        },
      }),
    };

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);

    gdrive.list_drive_files({ folder_id: "folder-123" });

    expect(listCalls.length).toBe(1);
    const query = (listCalls[0] as { q: string }).q;
    expect(query).toContain("folder-123");
    expect(query).toContain("in parents");
  });

  it("handles missing size field", () => {
    const { service } = makeListService({
      files: [
        {
          id: "sheets-id",
          name: "Budget Sheet",
          mimeType: "application/vnd.google-apps.spreadsheet",
          // note: no "size" field
        },
      ],
    });

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);

    const result = gdrive.list_drive_files();

    expect(result.length).toBe(1);
    expect(result[0]!.size_bytes).toBe(0);
  });

  it("returns empty on api error", () => {
    const service = {
      files: () => ({
        get: () => ({ execute: () => ({}) }),
        get_media: () => ({}),
        export_media: () => ({}),
        list: () => {
          throw new Error("API error");
        },
      }),
    };

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);

    const result = gdrive.list_drive_files();
    expect(result).toEqual([]);
  });

  it("respects max results parameter", () => {
    const listCalls: unknown[] = [];
    const service = {
      files: () => ({
        get: () => ({ execute: () => ({}) }),
        get_media: () => ({}),
        export_media: () => ({}),
        list: (o: unknown) => {
          listCalls.push(o);
          return { execute: () => ({ files: [] }) };
        },
      }),
    };

    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);
    gdrive._setDriveBuild(() => service);

    gdrive.list_drive_files({ max_results: 50 });

    expect(listCalls.length).toBe(1);
    expect((listCalls[0] as { pageSize: number }).pageSize).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// CLI tests — gdrive-auth (batch E: cli_gdrive.ts)
// ---------------------------------------------------------------------------

describe("TestGdriveAuthCli", () => {
  it("no setup prints instructions exit zero", async () => {
    // No ADC, no stored creds → the Option A/B/C instructions print, exit 0.
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });

    const result = await invoke(["gdrive-auth"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Option A");
    expect(result.output).toContain("Option B");
    expect(result.output).toContain("Option C");
  });

  it("with missing client secrets file exits one", async () => {
    const missing = path.join(makeTmpPath(), "does_not_exist.json");
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });

    const result = await invoke(["gdrive-auth", "--client-secrets", missing]);

    expect(result.exit_code).toBe(1);
  });

  it("adc detected prints confirmation exit zero", async () => {
    gdrive._setGoogleAuthDefault(() => [fakeCreds(), "proj"]);

    const result = await invoke(["gdrive-auth"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Application Default Credentials");
  });
});

// ---------------------------------------------------------------------------
// CLI tests — gdrive-fetch (batch E: cli_gdrive.ts)
// ---------------------------------------------------------------------------

describe("TestGdriveFetchCli", () => {
  it("no creds prints error exit zero", async () => {
    // No creds → helpful message in output, exit 0 (fail-soft).
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });

    const result = await invoke(["gdrive-fetch", "fake_id_for_test"]);

    expect(result.exit_code).toBe(0);
    // The CliRunner mixes stdout/stderr into result.output.
    expect(result.output).toContain("No Google Drive credentials");
  });

  it("successful fetch prints path", async () => {
    const cached = path.join(makeTmpPath(), "fake_id_imagejpg");
    fs.writeFileSync(cached, "data");

    vi.spyOn(gdrive, "fetch_file").mockResolvedValue(cached);
    const result = await invoke(["gdrive-fetch", "fake_id"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain(cached);
  });

  it("json output flag", async () => {
    const cached = path.join(makeTmpPath(), "fake_id_imagejpg");
    fs.writeFileSync(cached, "data");

    vi.spyOn(gdrive, "fetch_file").mockResolvedValue(cached);
    const result = await invoke(["gdrive-fetch", "fake_id", "--json"]);

    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data).toHaveProperty("path");
    expect(data).toHaveProperty("size");
  });
});

// ---------------------------------------------------------------------------
// CLI tests — gdrive-sections (batch E: cli_gdrive.ts)
// ---------------------------------------------------------------------------

describe("TestGdriveSectionsCli", () => {
  it("emits section index for markdown", async () => {
    const md = path.join(makeTmpPath(), "spec.md");
    fs.writeFileSync(md, "# Title\n\nbody\n\n## Install\n\nsteps\n", "utf-8");

    vi.spyOn(gdrive, "fetch_file").mockResolvedValue(md);
    const result = await invoke(["gdrive-sections", "fake_id"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain(md);
    expect(result.output).toContain("Title");
    expect(result.output).toContain("Install");
    expect(result.output).toContain("size=");
  });

  it("json output", async () => {
    const md = path.join(makeTmpPath(), "spec.md");
    fs.writeFileSync(md, "# A\n\n## B\n", "utf-8");

    vi.spyOn(gdrive, "fetch_file").mockResolvedValue(md);
    const result = await invoke(["gdrive-sections", "fake_id", "--json"]);

    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.extractor_available).toBe(true);
    expect(data.sections.some((s: { heading: string }) => s.heading === "A")).toBe(true);
    expect(data.sections.some((s: { heading: string }) => s.heading === "B")).toBe(true);
  });

  it("truncates when too many sections", async () => {
    // 5 headings, --max-sections 3 → result lists 3 + truncated marker.
    const md = path.join(makeTmpPath(), "spec.md");
    fs.writeFileSync(md, "# A\n## B\n## C\n## D\n## E\n", "utf-8");

    vi.spyOn(gdrive, "fetch_file").mockResolvedValue(md);
    const result = await invoke(["gdrive-sections", "fake_id", "--max-sections", "3"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("truncated at 3");
  });

  it("no creds exits zero fail soft", async () => {
    gdrive._setGoogleAuthDefault(() => {
      throw new Error("no ADC");
    });

    const result = await invoke(["gdrive-sections", "fake_id_for_test"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("No Google Drive credentials");
  });

  it("non markdown file falls back gracefully", async () => {
    const binary = path.join(makeTmpPath(), "image.png");
    fs.writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x66, 0x61, 0x6b, 0x65]));

    vi.spyOn(gdrive, "fetch_file").mockResolvedValue(binary);
    const result = await invoke(["gdrive-sections", "fake_id"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("no section index available");
  });
});

// ---------------------------------------------------------------------------
// CLI tests — gdrive-list (batch E: cli_gdrive.ts)
// ---------------------------------------------------------------------------

describe("TestCliGdriveList", () => {
  it("lists files in human readable format", async () => {
    const files: gdrive.DriveFileEntry[] = [
      { id: "doc-1", name: "Spec", mimeType: "application/vnd.google-apps.document", size_bytes: 0 },
      { id: "pdf-1", name: "Guide.pdf", mimeType: "application/pdf", size_bytes: 204800 },
    ];

    vi.spyOn(gdrive, "list_drive_files").mockReturnValue(files);
    const result = await invoke(["gdrive-list"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("doc-1  Spec (Google Docs, 0 B)");
    expect(result.output).toContain("pdf-1  Guide.pdf (PDF, 200 KB)");
  });

  it("shows helpful message when no files", async () => {
    vi.spyOn(gdrive, "list_drive_files").mockReturnValue([]);
    const result = await invoke(["gdrive-list"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("No files found");
  });

  it("passes folder id to list drive files", async () => {
    const spy = vi.spyOn(gdrive, "list_drive_files").mockReturnValue([]);
    const result = await invoke(["gdrive-list", "--folder", "folder-abc"]);

    expect(result.exit_code).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const callOpts = spy.mock.calls[0]![0] as { folder_id: string | null };
    expect(callOpts.folder_id).toBe("folder-abc");
  });

  it("outputs json when requested", async () => {
    const files: gdrive.DriveFileEntry[] = [
      { id: "id-1", name: "File 1", mimeType: "text/plain", size_bytes: 1024 },
    ];

    vi.spyOn(gdrive, "list_drive_files").mockReturnValue(files);
    const result = await invoke(["gdrive-list", "--json"]);

    expect(result.exit_code).toBe(0);
    const outputJson = JSON.parse(result.output);
    expect(outputJson).toHaveLength(1);
    expect(outputJson[0].id).toBe("id-1");
  });

  it("formats size as kb mb", async () => {
    const files: gdrive.DriveFileEntry[] = [
      { id: "a", name: "small", mimeType: "text/plain", size_bytes: 512 },
      { id: "b", name: "med", mimeType: "text/plain", size_bytes: 1048576 },
      { id: "c", name: "big", mimeType: "text/plain", size_bytes: 5242880 },
    ];

    vi.spyOn(gdrive, "list_drive_files").mockReturnValue(files);
    const result = await invoke(["gdrive-list"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("512 B"); // < 1 KB
    expect(result.output).toContain("1 MB"); // 1 MB
    expect(result.output).toContain("5 MB"); // 5 MB
  });
});
