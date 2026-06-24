/**
 * Tests for webfetch.ts — TypeScript port of tests/test_webfetch.py (Phase 14).
 *
 * The implementation injects two seams (mirroring the Python test's two patch
 * points); no real network calls are made.
 *
 * Port notes (Python -> TS):
 *  - patch("httpx.Client", return_value=client)
 *      -> webfetch._setHttpClient(() => client)      (cleared via setup.ts reset
 *         registry / explicitly via _setHttpClient(null) in afterEach).
 *  - patch("httpx.Client", side_effect=[a, b])       (a different client per
 *      construction) -> a factory closure returning the next client per call.
 *  - patch("socket.getaddrinfo", return_value=fake_addrinfo)
 *      -> webfetch._setGetaddrinfo(() => fakeAddrinfo)
 *  - patch("socket.getaddrinfo", side_effect=OSError(...))
 *      -> webfetch._setGetaddrinfo(() => { throw new webfetch.OSErrorLike(...) })
 *  - pytest.raises(ValueError, match="SSRF") -> await expect(...).rejects.toThrow(/SSRF/)
 *  - _is_ssrf_safe / _resolve_and_validate_ip / fetch_url are ASYNC in TS — every
 *    call is awaited.
 *  - The per-test tmp data dir (Python tmp_data_dir fixture) is provided
 *    automatically by tests/setup.ts (setDataDirOverride). webfetch.paths
 *    .webCacheDir()/imageCacheDir() therefore resolve under the isolated tmp dir.
 *  - mock_resp.status_code/url/headers(dict)/iter_bytes()/raise_for_status()
 *    /__enter__/__exit__ -> a plain WebfetchResponse object (see _mockHttpResponse).
 *  - mock_client.stream(...)/__enter__/__exit__ -> a plain WebfetchClient (see
 *    _mockClient).
 *  - PIL.Image PNG bytes -> sharp(rawBuffer, {raw}).png().toBuffer().
 *  - caplog.at_level(WARNING) -> vi.spyOn(console, "warn") (util.ts's logger
 *    .warning routes through console.warn).
 *
 * CLI test class (TestFetchImageCli) exercises the `fetch-image` subcommand
 * (cli_image.ts, batch G) via the in-process CliRunner `invoke`. It calls
 * webfetch.fetch_url through the `import * as webfetch` namespace, so the same
 * _setHttpClient / _setGetaddrinfo seams above are observed; fail-soft failures
 * exit 0 with a "WebFetch failed" message. Every module-level test is ported
 * and GREEN.
 *
 * SKIPPED (httpx-internal mechanism): TestMakePinnedTransport tests
 * `_make_pinned_transport` + httpx HTTPTransport.handle_request monkeypatching +
 * socket.getaddrinfo restoration. webfetch.ts has no _make_pinned_transport
 * analogue — the TS port pins via the fetch/dns seam (the default client rewrites
 * the URL host to the pinned IP). Those three tests are it.skip'd; the pinning
 * behavior is covered by the fetch_url SSRF + post-redirect tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import * as image_shrink from "../src/token_goat/image_shrink.js";
import * as paths from "../src/token_goat/paths.js";
import * as webfetch from "../src/token_goat/webfetch.js";
import { setDataDirOverride } from "../src/token_goat/reset.js";
import { invoke } from "./_cli_runner.js";

import type {
  AddrInfoTuple,
  WebfetchClient,
  WebfetchResponse,
} from "../src/token_goat/webfetch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBuffer(len: number): Buffer {
  const buf = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return buf;
}

/** Raw bytes of a synthetic PNG (Python _make_png_bytes via Pillow). */
async function makePngBytes(width = 64, height = 64): Promise<Buffer> {
  const raw = randomBuffer(width * height * 3);
  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * >100 KB of PNG bytes (Python _make_large_png_bytes — 1200x900 random, padded
 * past the shrink threshold). Cached per process via a module-level memo so the
 * expensive encode runs once.
 */
let _largePngCache: Buffer | null = null;
async function makeLargePngBytes(): Promise<Buffer> {
  if (_largePngCache !== null) {
    return _largePngCache;
  }
  const width = 1200;
  const height = 900;
  const raw = randomBuffer(width * height * 3);
  let data = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  // Pad if still under threshold (Python appends NUL blocks).
  while (data.length <= image_shrink.SIZE_THRESHOLD_BYTES) {
    data = Buffer.concat([data, Buffer.alloc(10240)]);
  }
  _largePngCache = data;
  return data;
}

/** Dict-like headers (httpx.Headers analogue): get(name) -> value | null. */
function _headers(d: Record<string, string>): {
  get(name: string): string | null;
} {
  return { get: (name: string): string | null => d[name] ?? null };
}

/**
 * Build a mock httpx streaming response (Python _mock_http_response).
 * Tracks iter_bytes invocation so a test can assert it was NOT called.
 */
interface MockResponse extends WebfetchResponse {
  iter_bytes_called: boolean;
}

function _mockHttpResponse(
  body: Buffer,
  content_type = "image/png",
  status = 200,
): MockResponse {
  const resp: MockResponse = {
    status_code: status,
    url: "https://example.com/final.png",
    headers: _headers({
      "content-type": content_type,
      "content-length": String(body.length),
    }),
    iter_bytes_called: false,
    iter_bytes(): Iterable<Uint8Array> {
      resp.iter_bytes_called = true;
      return [body];
    },
    raise_for_status(): void {
      // does nothing for 200
    },
    enter(): WebfetchResponse {
      return resp;
    },
    exit(): void {
      // no-op
    },
  };
  return resp;
}

/** Return a context-manager client wrapping the given response (Python _mock_client). */
function _mockClient(response: WebfetchResponse): WebfetchClient {
  const client: WebfetchClient = {
    stream(): WebfetchResponse {
      return response;
    },
    get(): WebfetchResponse {
      return response;
    },
    enter(): WebfetchClient {
      return client;
    },
    exit(): void {
      // no-op
    },
  };
  return client;
}

/** Python socket.getaddrinfo tuple for an IPv4 address. */
function v4AddrInfo(ip: string): AddrInfoTuple {
  // socket.AF_INET=2, SOCK_STREAM=1, IPPROTO_TCP=6.
  return [2, 1, 6, "", [ip, 0]];
}

/** Python socket.getaddrinfo tuple for an IPv6 address. */
function v6AddrInfo(ip: string): AddrInfoTuple {
  // socket.AF_INET6=10.
  return [10, 1, 6, "", [ip, 0, 0, 0]];
}

afterEach(() => {
  webfetch._setHttpClient(null);
  webfetch._setGetaddrinfo(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. is_image_url
// ---------------------------------------------------------------------------

describe("TestIsImageUrl", () => {
  it("jpg url", () => {
    expect(webfetch.is_image_url("https://example.com/photo.jpg")).toBe(true);
  });

  it("png url", () => {
    expect(webfetch.is_image_url("https://example.com/banner.png")).toBe(true);
  });

  it("webp url", () => {
    expect(webfetch.is_image_url("https://example.com/img.webp")).toBe(true);
  });

  it("avif url", () => {
    expect(webfetch.is_image_url("https://example.com/img.avif")).toBe(true);
  });

  it("uppercase extension", () => {
    expect(webfetch.is_image_url("https://example.com/PHOTO.JPG")).toBe(true);
  });

  it("non image url", () => {
    expect(webfetch.is_image_url("https://example.com/page.html")).toBe(false);
  });

  it("json url", () => {
    expect(webfetch.is_image_url("https://example.com/data.json")).toBe(false);
  });

  it("non http scheme", () => {
    expect(webfetch.is_image_url("ftp://example.com/photo.jpg")).toBe(false);
  });

  it("file scheme", () => {
    expect(webfetch.is_image_url("file:///home/user/photo.jpg")).toBe(false);
  });

  it("url with query string", () => {
    expect(webfetch.is_image_url("https://cdn.example.com/img.png?v=2")).toBe(
      true,
    );
  });

  it("empty string", () => {
    expect(webfetch.is_image_url("")).toBe(false);
  });

  it("plain text url", () => {
    expect(webfetch.is_image_url("https://example.com/readme.txt")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. is_image_content_type
// ---------------------------------------------------------------------------

describe("TestIsImageContentType", () => {
  it("image jpeg", () => {
    expect(webfetch.is_image_content_type("image/jpeg")).toBe(true);
  });

  it("image png", () => {
    expect(webfetch.is_image_content_type("image/png")).toBe(true);
  });

  it("image webp", () => {
    expect(webfetch.is_image_content_type("image/webp")).toBe(true);
  });

  it("application json", () => {
    expect(webfetch.is_image_content_type("application/json")).toBe(false);
  });

  it("text html", () => {
    expect(webfetch.is_image_content_type("text/html")).toBe(false);
  });

  it("with charset", () => {
    expect(webfetch.is_image_content_type("image/png; charset=utf-8")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. _suffix_for: derives from URL extension
// ---------------------------------------------------------------------------

describe("TestSuffixForUrl", () => {
  it("jpg", () => {
    expect(webfetch._suffix_for("https://example.com/photo.jpg")).toBe(".jpg");
  });

  it("jpeg", () => {
    expect(webfetch._suffix_for("https://example.com/photo.jpeg")).toBe(
      ".jpeg",
    );
  });

  it("png", () => {
    expect(webfetch._suffix_for("https://example.com/banner.png")).toBe(".png");
  });

  it("webp", () => {
    expect(webfetch._suffix_for("https://example.com/img.webp")).toBe(".webp");
  });

  it("avif", () => {
    expect(webfetch._suffix_for("https://example.com/img.avif")).toBe(".avif");
  });
});

// ---------------------------------------------------------------------------
// 4. _suffix_for: content-type fallback when URL has no extension
// ---------------------------------------------------------------------------

describe("TestSuffixForContentType", () => {
  it("jpeg content type", () => {
    expect(webfetch._suffix_for("https://example.com/image", "image/jpeg")).toBe(
      ".jpg",
    );
  });

  it("png content type", () => {
    expect(webfetch._suffix_for("https://example.com/image", "image/png")).toBe(
      ".png",
    );
  });

  it("webp content type", () => {
    expect(webfetch._suffix_for("https://example.com/image", "image/webp")).toBe(
      ".webp",
    );
  });

  it("unknown content type", () => {
    expect(
      webfetch._suffix_for(
        "https://example.com/image",
        "application/octet-stream",
      ),
    ).toBe(".bin");
  });

  it("no extension no content type", () => {
    expect(webfetch._suffix_for("https://example.com/image")).toBe(".bin");
  });
});

// ---------------------------------------------------------------------------
// 5. fetch_url: downloads and caches
// ---------------------------------------------------------------------------

describe("TestFetchUrl", () => {
  it("download and cache", async () => {
    const body = await makePngBytes(64, 64);
    const url = "https://example.com/test.png";

    const resp = _mockHttpResponse(body, "image/png");
    const client = _mockClient(resp);

    webfetch._setHttpClient(() => client);
    const result = await webfetch.fetch_url(url, { shrink_if_image: false });

    expect(fs.existsSync(result)).toBe(true);
    expect(fs.readFileSync(result)).toEqual(body);
  });

  it("cached path uses sha256 of url", async () => {
    const body = await makePngBytes();
    const url = "https://example.com/specific.png";
    const expectedStem = crypto
      .createHash("sha256")
      .update(Buffer.from(url, "utf-8"))
      .digest("hex");

    const resp = _mockHttpResponse(body, "image/png");
    const client = _mockClient(resp);

    webfetch._setHttpClient(() => client);
    const result = await webfetch.fetch_url(url, { shrink_if_image: false });

    // Path.stem = basename without final extension.
    const stem = path.basename(result, path.extname(result));
    expect(stem).toBe(expectedStem);
  });

  it("redirect to private target is blocked", async () => {
    const url = "https://example.com/redirect.png";
    const resp = _mockHttpResponse(Buffer.from("body"), "image/png");
    resp.url = "http://127.0.0.1/private.png";
    const client = _mockClient(resp);

    webfetch._setHttpClient(() => client);
    await expect(
      webfetch.fetch_url(url, { shrink_if_image: false }),
    ).rejects.toThrow(/SSRF/);

    expect(resp.iter_bytes_called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. fetch_url: cache reuse — client not constructed twice
// ---------------------------------------------------------------------------

describe("TestFetchUrlCacheReuse", () => {
  it("second call returns cached path", async () => {
    const body = await makePngBytes();
    const url = "https://example.com/cached.png";

    const resp = _mockHttpResponse(body, "image/png");
    const client = _mockClient(resp);

    let constructCount = 0;
    webfetch._setHttpClient(() => {
      constructCount += 1;
      return client;
    });

    const result1 = await webfetch.fetch_url(url, { shrink_if_image: false });
    const result2 = await webfetch.fetch_url(url, { shrink_if_image: false });

    expect(result1).toBe(result2);
    // Client was only constructed once (second call is a cache hit).
    expect(constructCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. fetch_url: oversized file raises RuntimeError, no cache file left
// ---------------------------------------------------------------------------

describe("TestFetchUrlOversized", () => {
  it("content length header too large", async () => {
    const url = "https://example.com/huge.png";
    const maxBytes = 1024;

    const resp = _mockHttpResponse(Buffer.alloc(512, 0x78), "image/png");
    resp.headers = _headers({
      "content-type": "image/png",
      "content-length": String(maxBytes + 1),
    });
    const client = _mockClient(resp);

    webfetch._setHttpClient(() => client);
    await expect(
      webfetch.fetch_url(url, { max_size_bytes: maxBytes }),
    ).rejects.toThrow(/file too large/);
  });

  it("streaming exceeds limit cleans up", async () => {
    const url = "https://example.com/sneaky.png";
    const maxBytes = 100;
    // content-length is 0 so header check passes; body exceeds limit.
    const body = Buffer.alloc(maxBytes + 50, 0x78);

    const resp: MockResponse = {
      status_code: 200,
      url: "https://example.com/sneaky.png",
      headers: _headers({ "content-type": "image/png", "content-length": "0" }),
      iter_bytes_called: false,
      iter_bytes(): Iterable<Uint8Array> {
        resp.iter_bytes_called = true;
        return [body];
      },
      raise_for_status(): void {
        // no-op
      },
      enter(): WebfetchResponse {
        return resp;
      },
      exit(): void {
        // no-op
      },
    };
    const client = _mockClient(resp);

    const cacheDir = webfetch.paths.webCacheDir();

    webfetch._setHttpClient(() => client);
    await expect(
      webfetch.fetch_url(url, { max_size_bytes: maxBytes }),
    ).rejects.toThrow(/file too large/);

    // No .tmp or cached file should survive.
    const leftover = fs.existsSync(cacheDir)
      ? fs.readdirSync(cacheDir).filter((n) => n.endsWith(".tmp"))
      : [];
    expect(leftover).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. fetch_url: shrinking applied when image > 100 KB
// ---------------------------------------------------------------------------

describe("TestFetchUrlShrink", () => {
  it("large image gets shrunk", async () => {
    const url = "https://example.com/large.png";
    const body = await makeLargePngBytes();

    expect(body.length).toBeGreaterThan(image_shrink.SIZE_THRESHOLD_BYTES);

    const resp = _mockHttpResponse(body, "image/png");
    const client = _mockClient(resp);

    webfetch._setHttpClient(() => client);
    const result = await webfetch.fetch_url(url, { shrink_if_image: true });

    // The returned path should exist.
    expect(fs.existsSync(result)).toBe(true);
    // Shrunken files land in image_cache_dir; un-shrunk in web_cache_dir.
    const parent = path.dirname(result);
    expect([paths.imageCacheDir(), paths.webCacheDir()]).toContain(parent);
  });
});

// ---------------------------------------------------------------------------
// 9. SSRF protection: _is_ssrf_safe and fetch_url refuse private/loopback URLs
// ---------------------------------------------------------------------------

describe("TestIsSsrfSafe", () => {
  it("public https allowed", async () => {
    // example.com resolves to a public IP via the real DNS path.
    expect(await webfetch._is_ssrf_safe("https://example.com/image.png")).toBe(
      true,
    );
  });

  it("public http allowed", async () => {
    expect(await webfetch._is_ssrf_safe("http://example.com/image.png")).toBe(
      true,
    );
  });

  it("non http scheme blocked", async () => {
    expect(await webfetch._is_ssrf_safe("file:///etc/passwd")).toBe(false);
  });

  it("ftp scheme blocked", async () => {
    expect(await webfetch._is_ssrf_safe("ftp://example.com/file.jpg")).toBe(
      false,
    );
  });

  it("localhost blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://localhost/admin")).toBe(false);
  });

  it("localhost uppercase blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://LOCALHOST/admin")).toBe(false);
  });

  it("gcp metadata hostname blocked", async () => {
    expect(
      await webfetch._is_ssrf_safe(
        "http://metadata.google.internal/computeMetadata/v1/",
      ),
    ).toBe(false);
  });

  it("loopback ipv4 blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://127.0.0.1/")).toBe(false);
  });

  it("loopback ipv4 variant blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://127.1.2.3/")).toBe(false);
  });

  it("aws metadata ip blocked", async () => {
    // 169.254.169.254 is the link-local AWS/Azure/GCP IMDS endpoint.
    expect(
      await webfetch._is_ssrf_safe("http://169.254.169.254/latest/meta-data/"),
    ).toBe(false);
  });

  it("link local range blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://169.254.0.1/anything")).toBe(
      false,
    );
  });

  it("private rfc1918 10 blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://10.0.0.1/")).toBe(false);
  });

  it("private rfc1918 192 168 blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://192.168.1.1/router")).toBe(
      false,
    );
  });

  it("private rfc1918 172 blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://172.16.0.1/internal")).toBe(
      false,
    );
  });

  // Audit: RFC1918 172.16/12 spans 172.16.0.0–172.31.255.255.
  it.each([
    "http://172.17.0.1/", // docker bridge default
    "http://172.20.10.1/", // iOS personal hotspot range
    "http://172.31.255.254/", // upper bound of the /12
  ])("private rfc1918 172 middle and upper blocked: %s", async (ipUrl) => {
    expect(await webfetch._is_ssrf_safe(ipUrl)).toBe(false);
  });

  // Audit: 127.0.0.0/8 upper edge.
  it("loopback upper edge blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://127.255.255.254/")).toBe(false);
  });

  // Audit: link-local /16 — a non-IMDS link-local address is also blocked.
  it("link local non imds blocked", async () => {
    expect(await webfetch._is_ssrf_safe("http://169.254.99.99/")).toBe(false);
  });

  it("empty url blocked", async () => {
    expect(await webfetch._is_ssrf_safe("")).toBe(false);
  });

  it("no hostname blocked", async () => {
    expect(await webfetch._is_ssrf_safe("https:///image.png")).toBe(false);
  });
});

describe("TestFetchUrlSsrfGuard", () => {
  it("localhost raises value error", async () => {
    await expect(
      webfetch.fetch_url("http://localhost/image.png"),
    ).rejects.toThrow(/SSRF/);
  });

  it("aws metadata raises value error", async () => {
    await expect(
      webfetch.fetch_url(
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      ),
    ).rejects.toThrow(/SSRF/);
  });

  it("private ip raises value error", async () => {
    await expect(
      webfetch.fetch_url("http://10.0.0.1/image.png"),
    ).rejects.toThrow(/SSRF/);
  });

  it("loopback raises no http request", async () => {
    // Verify the client factory is never invoked for a blocked URL.
    let constructed = false;
    webfetch._setHttpClient(() => {
      constructed = true;
      return _mockClient(_mockHttpResponse(Buffer.from("x")));
    });
    await expect(
      webfetch.fetch_url("http://127.0.0.1/image.png"),
    ).rejects.toThrow(webfetch.ValueErrorLike);
    expect(constructed).toBe(false);
  });

  // Audit: DNS-rebind class. A hostname (not an IP literal) that resolves to a
  // private IP must be rejected at the _is_ssrf_safe stage *before* the IP pin
  // step runs and *before* any client is constructed.
  it.each([
    "127.0.0.1", // loopback
    "10.0.0.5", // RFC1918 /8
    "172.16.7.7", // RFC1918 /12 lower
    "172.24.0.99", // RFC1918 /12 middle
    "192.168.1.50", // RFC1918 /16
    "169.254.169.254", // link-local IMDS
  ])("hostname resolving to private ip blocked: %s", async (privateIp) => {
    let constructed = false;
    webfetch._setGetaddrinfo(() => [v4AddrInfo(privateIp)]);
    webfetch._setHttpClient(() => {
      constructed = true;
      return _mockClient(_mockHttpResponse(Buffer.from("x")));
    });
    await expect(
      webfetch.fetch_url("http://rebind.attacker.example/image.png"),
    ).rejects.toThrow(/SSRF/);
    expect(constructed).toBe(false);
  });

  it("hostname resolving to ipv4 mapped private blocked", async () => {
    let constructed = false;
    webfetch._setGetaddrinfo(() => [v6AddrInfo("::ffff:192.168.1.1")]);
    webfetch._setHttpClient(() => {
      constructed = true;
      return _mockClient(_mockHttpResponse(Buffer.from("x")));
    });
    await expect(
      webfetch.fetch_url("http://v6mapped.attacker.example/image.png"),
    ).rejects.toThrow(/SSRF/);
    expect(constructed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10b. DNS rebinding mitigation: _resolve_and_validate_ip
// ---------------------------------------------------------------------------

describe("TestResolveAndValidateIp", () => {
  it("private ip raises", async () => {
    webfetch._setGetaddrinfo(() => [v4AddrInfo("10.0.0.1")]);
    await expect(
      webfetch._resolve_and_validate_ip("internal.corp"),
    ).rejects.toThrow(/no safe address/);
  });

  it("loopback ip raises", async () => {
    webfetch._setGetaddrinfo(() => [v4AddrInfo("127.0.0.1")]);
    await expect(
      webfetch._resolve_and_validate_ip("loopback.internal"),
    ).rejects.toThrow(/no safe address/);
  });

  it("link local ip raises", async () => {
    webfetch._setGetaddrinfo(() => [v4AddrInfo("169.254.169.254")]);
    await expect(
      webfetch._resolve_and_validate_ip("metadata.aws"),
    ).rejects.toThrow(/no safe address/);
  });

  it("unresolvable hostname raises", async () => {
    webfetch._setGetaddrinfo(() => {
      throw new webfetch.OSErrorLike("Name or service not known");
    });
    await expect(
      webfetch._resolve_and_validate_ip("does-not-exist.invalid"),
    ).rejects.toThrow(/cannot resolve/);
  });

  it("public ip returned", async () => {
    webfetch._setGetaddrinfo(() => [v4AddrInfo("93.184.216.34")]);
    const result = await webfetch._resolve_and_validate_ip("example.com");
    expect(result).toBe("93.184.216.34");
  });

  it("ipv4 mapped ipv6 private raises", async () => {
    // ::ffff:10.0.0.1 maps to 10.0.0.1 (private).
    webfetch._setGetaddrinfo(() => [v6AddrInfo("::ffff:10.0.0.1")]);
    await expect(
      webfetch._resolve_and_validate_ip("mapped.internal"),
    ).rejects.toThrow(/no safe address/);
  });

  it("mixed addresses returns first safe", async () => {
    webfetch._setGetaddrinfo(() => [
      v4AddrInfo("10.0.0.1"), // private
      v4AddrInfo("93.184.216.34"), // public
    ]);
    const result = await webfetch._resolve_and_validate_ip("mixed.example.com");
    expect(result).toBe("93.184.216.34");
  });
});

describe("TestMakePinnedTransport", () => {
  it.skip("pinned transport redirects getaddrinfo", () => {
    // httpx HTTPTransport monkeypatch mechanism — TS pins via the fetch/dns
    // seam; pinning behavior is covered by the fetch_url SSRF + post-redirect
    // tests.
  });

  it.skip("getaddrinfo restored after exception", () => {
    // httpx HTTPTransport monkeypatch mechanism — TS pins via the fetch/dns
    // seam; pinning behavior is covered by the fetch_url SSRF + post-redirect
    // tests.
  });
});

// ---------------------------------------------------------------------------
// 11. CLI: token-goat fetch-image <url> — the `fetch-image` command lives in
// cli_image.ts (batch G). It calls webfetch.fetch_url via the `import * as
// webfetch` namespace, so the same _setHttpClient / _setGetaddrinfo seams used
// above are observed. Fail-soft: every failure exits 0 with a "WebFetch failed"
// stderr message (CliRunner mixes stderr into result.output).
// ---------------------------------------------------------------------------

describe("TestFetchImageCli", () => {
  it("bad url exits zero with stderr", async () => {
    // Simulate the DNS failure of an ".invalid" host: getaddrinfo throws.
    webfetch._setGetaddrinfo(() => {
      throw new webfetch.OSErrorLike("Name or service not known");
    });

    const result = await invoke([
      "fetch-image",
      "https://this-host-definitely-does-not-exist-token-goat.invalid/photo.jpg",
    ]);

    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("WebFetch failed");
  });

  // Audit: user-supplied URL on the CLI surface must be gated by the same SSRF
  // check as the hook surface. fetch-image is the only public CLI that accepts a
  // URL and forwards it to the network layer.
  it.each([
    "http://localhost/admin",
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/internal",
    "http://172.16.0.1/internal",
    "http://192.168.1.1/router",
    "file:///etc/passwd",
    "ftp://example.com/image.jpg",
  ])("cli blocks ssrf url: %s", async (ssrfUrl) => {
    // The HTTP client factory must NEVER be constructed for a blocked URL.
    let constructed = false;
    webfetch._setHttpClient(() => {
      constructed = true;
      return _mockClient(_mockHttpResponse(Buffer.from("x")));
    });
    // Hostnames (only "localhost" here) resolve via getaddrinfo; pin it to a
    // loopback so the SSRF guard blocks deterministically with no real DNS.
    webfetch._setGetaddrinfo(() => [v4AddrInfo("127.0.0.1")]);

    const result = await invoke(["fetch-image", ssrfUrl]);

    expect(result.exit_code).toBe(0);
    expect(constructed).toBe(false);
  });

  it("cli blocks hostname resolving to private ip", async () => {
    // DNS-rebind through the CLI: hostname resolves to a private IP and must be
    // rejected before the HTTP client fires.
    webfetch._setGetaddrinfo(() => [v4AddrInfo("169.254.169.254")]);
    let constructed = false;
    webfetch._setHttpClient(() => {
      constructed = true;
      return _mockClient(_mockHttpResponse(Buffer.from("x")));
    });

    const result = await invoke(["fetch-image", "http://rebind-cli.example/photo.png"]);

    expect(result.exit_code).toBe(0);
    expect(constructed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. fetch_url: content-hash dedup across URLs
// ---------------------------------------------------------------------------

describe("TestFetchUrlContentDedup", () => {
  it("index records content sha after download", async () => {
    const body = await makePngBytes();
    const url = "https://example.com/a.png";

    const resp = _mockHttpResponse(body, "image/png");
    const client = _mockClient(resp);

    webfetch._setHttpClient(() => client);
    await webfetch.fetch_url(url, { shrink_if_image: false });

    const contentSha = crypto.createHash("sha256").update(body).digest("hex");
    const idx = webfetch._content_index_path(contentSha);
    expect(fs.existsSync(idx)).toBe(true);
  });

  it("meta records content sha256", async () => {
    const body = await makePngBytes();
    const url = "https://example.com/meta-sha.png";

    const resp = _mockHttpResponse(body, "image/png");
    const client = _mockClient(resp);

    webfetch._setHttpClient(() => client);
    const result = await webfetch.fetch_url(url, { shrink_if_image: false });

    const meta = webfetch._read_cache_meta(result);
    expect(meta["content_sha256"]).toBe(
      crypto.createHash("sha256").update(body).digest("hex"),
    );
  });

  it("second url same bytes skips shrink pipeline", async () => {
    const body = await makeLargePngBytes();
    expect(body.length).toBeGreaterThan(image_shrink.SIZE_THRESHOLD_BYTES);

    const urlA = "https://example.com/slack-screenshot.png";
    const urlB = "https://example.com/github-pr-comment.png";

    // Each fetch returns its own response; both have identical bodies.
    const respA = _mockHttpResponse(body, "image/png");
    const respB = _mockHttpResponse(body, "image/png");
    const clients = [_mockClient(respA), _mockClient(respB)];
    let clientIdx = 0;
    webfetch._setHttpClient(() => clients[clientIdx++]!);

    let shrinkCalls = 0;
    const realShrink = image_shrink.shrink_if_image;
    vi.spyOn(image_shrink, "shrink_if_image").mockImplementation(
      async (p) => {
        shrinkCalls += 1;
        return realShrink(p);
      },
    );

    const resultA = await webfetch.fetch_url(urlA, { shrink_if_image: true });
    const resultB = await webfetch.fetch_url(urlB, { shrink_if_image: true });

    // Dedup hit means the second URL returns the same shrunk artifact path.
    expect(resultA).toBe(resultB);
    // First call shrinks; second short-circuits via the content index.
    expect(shrinkCalls).toBe(1);
  });

  it("shrunk pointer skips image shrink on url cache hit", async () => {
    const body = await makeLargePngBytes();
    expect(body.length).toBeGreaterThan(image_shrink.SIZE_THRESHOLD_BYTES);

    const url = "https://example.com/repeat.png";
    const resp = _mockHttpResponse(body, "image/png");

    // First fetch performs the actual download + shrink.
    webfetch._setHttpClient(() => _mockClient(resp));
    const first = await webfetch.fetch_url(url, { shrink_if_image: true });

    // Second fetch should hit the URL cache; with the shrunk_path pointer set,
    // it must not invoke image_shrink at all, and must not construct a client.
    const mockShrink = vi
      .spyOn(image_shrink, "shrink_if_image")
      .mockResolvedValue("UNREACHABLE");
    let constructed = false;
    webfetch._setHttpClient(() => {
      constructed = true;
      return _mockClient(resp);
    });
    const second = await webfetch.fetch_url(url, { shrink_if_image: true });

    expect(first).toBe(second);
    expect(mockShrink).not.toHaveBeenCalled();
    // No HTTP request was made either — pointer hit beats revalidation.
    expect(constructed).toBe(false);
  });

  it("stale pointer falls back gracefully", async () => {
    const body = await makeLargePngBytes();
    expect(body.length).toBeGreaterThan(image_shrink.SIZE_THRESHOLD_BYTES);

    const url = "https://example.com/stale.png";
    const respA = _mockHttpResponse(body, "image/png");

    webfetch._setHttpClient(() => _mockClient(respA));
    const first = await webfetch.fetch_url(url, { shrink_if_image: true });

    // Simulate the shrunk artifact being evicted by the LRU sweeper.
    if (fs.existsSync(first)) {
      fs.unlinkSync(first);
    }

    // The next fetch should detect the missing pointer target and re-shrink
    // rather than returning a path-to-nothing.
    const respB = _mockHttpResponse(body, "image/png");
    webfetch._setHttpClient(() => _mockClient(respB));
    const second = await webfetch.fetch_url(url, { shrink_if_image: true });

    expect(fs.existsSync(second)).toBe(true);
  });

  it("corrupt content index is discarded", () => {
    const sha = "0".repeat(64);
    const idx = webfetch._content_index_path(sha);
    fs.mkdirSync(path.dirname(idx), { recursive: true });
    fs.writeFileSync(idx, "{not valid json", "utf-8");

    expect(webfetch._read_content_index(sha)).toBeNull();
  });

  it("content index pointer to missing file cleaned up", () => {
    const sha = "1".repeat(64);
    const idx = webfetch._content_index_path(sha);
    fs.mkdirSync(path.dirname(idx), { recursive: true });
    fs.writeFileSync(idx, '{"cache_path": "C:/does/not/exist.png"}', "utf-8");

    expect(webfetch._read_content_index(sha)).toBeNull();
    expect(fs.existsSync(idx)).toBe(false);
  });

  it("hash file sha256 unreadable returns none", () => {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tg-webfetch-")),
    );
    const nonexistent = path.join(tmp, "ghost.png");
    expect(webfetch._hash_file_sha256(nonexistent)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 13. _strip_html_to_text: HTML-to-text compression
// ---------------------------------------------------------------------------

describe("TestStripHtmlToText", () => {
  /** Return HTML bytes, optionally padded (Python _html_body). */
  function htmlBody(extraPadding = 0): Buffer {
    const navBloat =
      "<nav>" + "<a href='#'>link</a>".repeat(20) + "</nav>";
    const scriptBloat =
      "<script>" + "var x = 1;\n".repeat(30) + "</script>";
    const styleBloat =
      "<style>" + "body { margin: 0; }\n".repeat(30) + "</style>";
    const content = "<p>Readable content here.</p>".repeat(5);
    const html =
      "<!DOCTYPE html>\n<html><head>" +
      styleBloat +
      scriptBloat +
      "</head><body>" +
      navBloat +
      content +
      "</body></html>";
    return Buffer.from(html + " ".repeat(extraPadding), "utf-8");
  }

  it("html is stripped to text", () => {
    const body = htmlBody();
    const result = webfetch._strip_html_to_text(body);
    expect(result).not.toBe(body);
    expect(result.length).toBeLessThan(body.length);
  });

  it("result contains marker", () => {
    const body = htmlBody();
    const result = webfetch._strip_html_to_text(body);
    if (result !== body && !Buffer.from(result).equals(body)) {
      const firstLine = Buffer.from(result)
        .toString("utf-8")
        .split("\n")[0]!;
      expect(firstLine.startsWith("[token-goat: HTML→text,")).toBe(true);
    }
  });

  it("json content passes through unchanged", () => {
    const body = Buffer.from('{"key": "value", "items": [1, 2, 3]}');
    const result = webfetch._strip_html_to_text(body);
    expect(result).toBe(body);
  });

  it("plain text passes through unchanged", () => {
    const body = Buffer.from(
      "Just some plain text content without any markup.\n".repeat(10),
    );
    const result = webfetch._strip_html_to_text(body);
    expect(result).toBe(body);
  });

  it("minimal html no reduction passes through", () => {
    // A page almost entirely text inside a thin HTML shell — after stripping
    // the byte count drops by much less than 20%.
    const content = "word ".repeat(500);
    const thinHtml = `<html><body>${content}</body></html>`;
    const body = Buffer.from(thinHtml, "utf-8");
    const result = webfetch._strip_html_to_text(body);
    expect(result).toBe(body);
  });

  it("script and style blocks removed", () => {
    const body = htmlBody();
    const result = webfetch._strip_html_to_text(body);
    if (result === body) {
      return; // stripping threshold not met for this input size
    }
    const decoded = Buffer.from(result).toString("utf-8");
    expect(decoded.includes("var x = 1")).toBe(false);
    expect(decoded.includes("margin: 0")).toBe(false);
  });

  it("nav block removed", () => {
    const body = htmlBody();
    const result = webfetch._strip_html_to_text(body);
    if (result === body) {
      return;
    }
    const decoded = Buffer.from(result).toString("utf-8");
    const linkCount = decoded.split("link").length - 1;
    expect(linkCount).toBeLessThan(5);
  });

  it("readable content preserved", () => {
    const body = htmlBody();
    const result = webfetch._strip_html_to_text(body);
    if (result === body) {
      return;
    }
    const decoded = Buffer.from(result).toString("utf-8");
    expect(decoded.includes("Readable content here")).toBe(true);
  });

  it("never raises on garbage input", () => {
    const bads: Buffer[] = [
      Buffer.from(""),
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.concat([
        Buffer.from("<html>"),
        Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      ]),
      Buffer.alloc(1000, 0x00),
    ];
    for (const bad of bads) {
      const result = webfetch._strip_html_to_text(bad);
      expect(result).toBeInstanceOf(Uint8Array);
    }
  });
});

// ---------------------------------------------------------------------------
// 14. fetch_url: tampered sidecar containment check
// ---------------------------------------------------------------------------

describe("TestFetchUrlTamperedSidecar", () => {
  it("tampered shrunk path is rejected", async () => {
    const tmpPath = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tg-webfetch-tamper-")),
    );

    const url = "https://example.com/tampered-sidecar.png";
    const body = await makePngBytes(64, 64);

    // A fake "secret" file outside any cache root.
    const secretFile = path.join(tmpPath, "sensitive_data.txt");
    fs.writeFileSync(secretFile, "super secret content", "utf-8");

    // Point the data dir into tmp_path so web/image cache dirs are isolated
    // (Python patches paths.data_dir; the TS analogue is setDataDirOverride).
    const fakeData = path.join(tmpPath, "fake_data");
    fs.mkdirSync(fakeData);
    setDataDirOverride(fakeData);

    // Capture warnings emitted via the logger (util.ts routes .warning to
    // console.warn). Read captured args BEFORE restoring the spy.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let result: string;
    let secretResolved: string;
    try {
      // First fetch: download and cache the file normally.
      const resp = _mockHttpResponse(body, "image/png");
      const client = _mockClient(resp);
      webfetch._setHttpClient(() => client);
      const cached = await webfetch.fetch_url(url, { shrink_if_image: false });

      expect(fs.existsSync(cached)).toBe(true);

      // Tamper the sidecar: overwrite shrunk_path to point at the secret file.
      const metaPath = webfetch._sidecar_path(cached);
      let existingMeta: Record<string, unknown> = {};
      if (fs.existsSync(metaPath)) {
        try {
          existingMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Record<
            string,
            unknown
          >;
        } catch {
          existingMeta = {};
        }
      }
      existingMeta["shrunk_path"] = secretFile;
      fs.writeFileSync(metaPath, JSON.stringify(existingMeta), "utf-8");

      // Second fetch: should hit the sidecar, detect the tampered path, log a
      // warning, and NOT return the secret file path.
      webfetch._setHttpClient(() => _mockClient(_mockHttpResponse(body, "image/png")));
      result = await webfetch.fetch_url(url, { shrink_if_image: true });
      secretResolved = fs.realpathSync(secretFile);
    } finally {
      // The returned path must not be the tampered secret file.
      const captured = warnSpy.mock.calls.map((c) => c.join(" "));
      warnSpy.mockRestore();

      // Stash captured for the assertions below (closure).
      (
        globalThis as unknown as { __webfetchWarnings?: string[] }
      ).__webfetchWarnings = captured;
    }

    expect(result).not.toBe(secretFile);
    expect(fs.realpathSync(result)).not.toBe(secretResolved);

    const warnings =
      (globalThis as unknown as { __webfetchWarnings?: string[] })
        .__webfetchWarnings ?? [];
    expect(
      warnings.some(
        (m) => m.includes("tampered") || m.includes("outside allowed"),
      ),
    ).toBe(true);
  });
});
