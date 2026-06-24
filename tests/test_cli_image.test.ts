/**
 * Tests for the batch-G image CLI commands (cli_image.ts): image-shrink +
 * caption-instead. (fetch-image has its own TestFetchImageCli in
 * test_webfetch.test.ts; compress is deferred pending bash_runner.)
 *
 * image-shrink calls image_shrink.shrink / stats_for via the `import * as
 * image_shrink` namespace, so Python `patch.object(image_shrink, "shrink", …)`
 * → `vi.spyOn(image_shrink, "shrink")`. The src file must exist (the command
 * checks fs.existsSync first), so each success/null case seeds a real tmp file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as image_shrink from "../src/token_goat/image_shrink.js";
import { invoke } from "./_cli_runner.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A throwaway tmp dir (the Python tmp_path fixture analogue). */
function makeTmpPath(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-cli-image-")));
}

describe("TestImageShrinkCli", () => {
  it("missing file exits one", async () => {
    const missing = path.join(makeTmpPath(), "nope.png");

    const result = await invoke(["image-shrink", missing]);

    expect(result.exit_code).toBe(1);
  });

  it("not shrunk exits zero", async () => {
    const src = path.join(makeTmpPath(), "tiny.png");
    fs.writeFileSync(src, Buffer.from("not really an image"));

    vi.spyOn(image_shrink, "shrink").mockResolvedValue(null);

    const result = await invoke(["image-shrink", src]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Not shrunk");
    expect(result.output).toContain(src);
  });

  it("success human output", async () => {
    const dir = makeTmpPath();
    const src = path.join(dir, "big.png");
    const out = path.join(dir, "big.webp");
    fs.writeFileSync(src, Buffer.alloc(4));

    vi.spyOn(image_shrink, "shrink").mockResolvedValue(out);
    vi.spyOn(image_shrink, "stats_for").mockResolvedValue({
      src_bytes: 4096,
      out_bytes: 1024,
      bytes_saved: 3072,
      orig_width: 100,
      orig_height: 100,
      out_width: 50,
      out_height: 50,
    });

    const result = await invoke(["image-shrink", src]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain(`${src} → ${out}`);
    expect(result.output).toContain("4,096 → 1,024 bytes");
    expect(result.output).toContain("saved 3,072");
  });

  it("json output", async () => {
    const dir = makeTmpPath();
    const src = path.join(dir, "big.png");
    const out = path.join(dir, "big.webp");
    fs.writeFileSync(src, Buffer.alloc(4));

    vi.spyOn(image_shrink, "shrink").mockResolvedValue(out);
    vi.spyOn(image_shrink, "stats_for").mockResolvedValue({
      src_bytes: 2048,
      out_bytes: 512,
      bytes_saved: 1536,
      orig_width: 100,
      orig_height: 100,
      out_width: 50,
      out_height: 50,
    });

    const result = await invoke(["image-shrink", src, "--json"]);

    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.shrunken_path).toBe(out);
    expect(data.src_bytes).toBe(2048);
    expect(data.bytes_saved).toBe(1536);
  });
});

describe("TestCaptionInsteadCli", () => {
  it("echoes v2 stub", async () => {
    const result = await invoke(["caption-instead", "/tmp/whatever.png"]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("v2 feature, not in v1");
  });
});
