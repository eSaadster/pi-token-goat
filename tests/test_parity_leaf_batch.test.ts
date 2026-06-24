/**
 * Adversarial-parity regression locks for the Layer 7 leaf batch
 * (webfetch / gdrive / stats).
 *
 * These cases were found by differentially fuzzing the TS ports against the
 * CPython 3.13.2 `.venv` oracle (see task (a) of the leaf-batch follow-ups):
 *   - SSRF: ~65k IPv4+IPv6 addresses (boundary enumeration + seeded sample)
 *     driven through _is_ssrf_safe via the _setGetaddrinfo seam.
 *   - _strip_html_to_text: 31 HTML fixtures (scripts/entities/astral/threshold).
 *   - _sparkline: 45 integer lists targeting x.5 banker's-rounding ties.
 *   - _validate_file_id: 56 Unicode/path edge cases.
 *
 * The SSRF block in particular locks in CPython 3.13.2's `ipaddress`
 * predicates exactly (the hand-rolled ranges were rewritten to data-driven
 * CIDR tables transcribed from ipaddress.py L1579/L2383). This file guards
 * against silent regression of that parity — it runs with NO network and NO
 * .venv dependency; expected values are hardcoded from the oracle.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import * as webfetch from "../src/token_goat/webfetch.js";
import * as gdrive from "../src/token_goat/gdrive.js";
import * as stats from "../src/token_goat/stats.js";

/** Drive _is_ssrf_safe as if "probe.test" resolved to the single IP *ip*. */
async function safeFor(ip: string): Promise<boolean> {
  const isV6 = ip.includes(":");
  const sockaddr: [string, number, ...number[]] = isV6
    ? [ip, 0, 0, 0]
    : [ip, 0];
  const tuple: webfetch.AddrInfoTuple = [isV6 ? 10 : 2, 1, 6, "", sockaddr];
  webfetch._setGetaddrinfo(() => [tuple]);
  return webfetch._is_ssrf_safe("http://probe.test/");
}

describe("ParitySsrfIpRangesCpython313", () => {
  // IPv4 NOT blocked under CPython 3.13.2 (the old hand-rolled port over-blocked
  // these — CGNAT was private in 3.11/3.12 but is the _public_network in 3.13;
  // 192.0.0.{9,10} are _private_networks_exceptions).
  it.each([
    "100.64.0.1", // CGNAT lower bound — not private in 3.13
    "100.100.50.50", // CGNAT middle
    "100.127.255.255", // CGNAT upper bound
    "100.63.255.255", // just below CGNAT — public
    "100.128.0.1", // just above CGNAT — public
    "192.0.0.9", // private-network exception (WPAD)
    "192.0.0.10", // private-network exception (Mutual ID)
    "1.1.1.1", // public
    "8.8.8.8", // public
  ])("NOT blocked (3.13.2 parity): %s", async (ip) => {
    expect(await safeFor(ip)).toBe(true);
  });

  // IPv4 still blocked under 3.13.2 (loopback / link-local / RFC1918 / reserved
  // / documentation / the non-exception part of 192.0.0.0/24).
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.99.99",
    "0.0.0.0",
    "192.0.0.0", // 192.0.0.0/24 lower bound (not an exception)
    "192.0.0.8", // inside 192.0.0.0/24, not an exception
    "192.0.0.11", // inside 192.0.0.0/24, not an exception
    "192.0.2.5", // TEST-NET-1 documentation
    "198.51.100.5", // TEST-NET-2 documentation
    "203.0.113.5", // TEST-NET-3 documentation
    "240.0.0.1", // reserved 240.0.0.0/4
    "255.255.255.255", // limited broadcast
  ])("blocked (3.13.2 parity): %s", async (ip) => {
    expect(await safeFor(ip)).toBe(false);
  });

  // IPv6 blocked under 3.13.2 (loopback / ULA / link-local / documentation /
  // discard / the IANA reserved set ::/8, 100::/8, fe00::/9 etc.).
  it.each([
    "::1", // loopback
    "fc00::1", // unique-local fc00::/7
    "fd00::1", // unique-local
    "fe80::1", // link-local
    "2001:db8::1", // documentation 2001:db8::/32
    "2001::1", // 2001::/23
    "64:ff9b::1", // NAT64 well-known prefix — reserved via ::/8
    "100::", // discard prefix 0100::/64
    "fbff::1", // reserved (f800::/6)
    "fe00::1", // reserved fe00::/9
    "fe7f::1", // reserved fe00::/9 upper edge
  ])("blocked (IPv6 3.13.2 parity): %s", async (ip) => {
    expect(await safeFor(ip)).toBe(false);
  });

  // IPv6 NOT blocked under 3.13.2: the _private_networks_exceptions carve-out
  // makes these globally reachable despite being inside 2001::/23.
  it.each([
    "2001:1::1", // exception (APT ntp)
    "2001:1::2", // exception
    "2001:3::1", // exception 2001:3::/32
    "2001:4:112::1", // exception 2001:4:112::/48
    "2001:20::1", // exception 2001:20::/28
    "2001:30::1", // exception 2001:30::/28
    "2606:4700:4700::1111", // Cloudflare public
  ])("NOT blocked (IPv6 3.13.2 exception/public): %s", async (ip) => {
    expect(await safeFor(ip)).toBe(true);
  });

  // IPv4-mapped IPv6 of a private IPv4 must still be blocked (unwrap parity).
  it.each([
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
    "::ffff:169.254.169.254",
  ])("ipv4-mapped ipv6 blocked: %s", async (ip) => {
    expect(await safeFor(ip)).toBe(false);
  });

  it("ipv4-mapped ipv6 of a public ipv4 is allowed", async () => {
    expect(await safeFor("::ffff:8.8.8.8")).toBe(true);
  });
});

describe("ParitySparklineBankersRound", () => {
  // round((v/hi)*8) under Python's banker's half-even. 9/16*8 = 4.5 → 4 (even).
  // _SPARK = " ▁▂▃▄▅▆▇█".
  it.each([
    [[0, 9, 16, 8], " ▄█▄"],
    [[9, 16, 8], "▄█▄"],
    [[5, 5, 10], "▄▄█"],
    [[1, 1, 1], "███"],
    [[3, 7], "▃█"],
    [[0, 0, 0], "   "],
    [[], ""],
  ])("sparkline %j", (values, expected) => {
    expect(stats._sparkline(values)).toBe(expected);
  });
});

describe("ParityValidateFileIdUnicode", () => {
  // Python str.isalnum() is Unicode-aware; the port mirrors it via \p{L}\p{N}.
  it.each([
    ["café", true], // Latin accented letters
    ["北京123", true], // CJK letters + digits
    ["½", true], // Vulgar fraction (Number/other) — isalnum true
    ["a".repeat(128), true], // code-point length cap boundary
    ["a".repeat(127), true],
  ])("valid file_id: %s", (id, _ok) => {
    expect(() => gdrive._validate_file_id(id)).not.toThrow();
  });

  it.each([
    ["a".repeat(129)], // over the 128 code-point cap
    ["../x"], // path traversal
    ["a/b"], // slash
    ["a\\b"], // backslash
    ["a.b.c"], // dot not in base64url alphabet
  ])("invalid file_id: %s", (id) => {
    expect(() => gdrive._validate_file_id(id)).toThrow();
  });

  it("too-long message includes the code-point count", () => {
    try {
      gdrive._validate_file_id("a".repeat(129));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toBe("file_id too long (max 128 chars): 129");
    }
  });
});

describe("ParityStripHtmlEntities", () => {
  it("decodes named + numeric + astral entities and emits the marker", () => {
    const body = Buffer.from(
      "<html><body>&amp;&copy;&#8482;&#x1F600; x y z padding for reduction threshold</body></html>",
      "utf-8",
    );
    const out = webfetch._strip_html_to_text(new Uint8Array(body));
    const text = Buffer.from(out).toString("utf-8");
    // Marker carries original→stripped byte counts; entity decoding is faithful.
    expect(text.startsWith("[token-goat: HTML→text, 91B→48B]\n")).toBe(true);
    expect(text).toContain("&©™😀 x y z padding for reduction threshold");
  });

  it("non-HTML body passes through unchanged (reference equality)", () => {
    const body = Buffer.from('{"k": "v"}', "utf-8");
    // Buffer is a Uint8Array subtype; the function returns its arg verbatim.
    const out = webfetch._strip_html_to_text(body);
    expect(out).toBe(body); // ===, like Python `return body`
  });
});

describe("ParityValidateMimeTypeCpython313", () => {
  // gdrive._validate_mime_type accepts RFC-2045 token grammar (type/subtype +
  // optional `;`-suffix of printable non-control ASCII or any non-control byte)
  // and returns the string verbatim; anything else -> "application/octet-stream".
  // Locked from the CPython 3.13.2 oracle (`_validate_mime_type(m, "F")`).
  //
  // KEY PARITY FIX (driven by this fuzz): the Python pattern ends in a bare `$`,
  // and CPython's `$` (no re.MULTILINE) matches at the end of the string OR just
  // before a SINGLE trailing `\n`. JS `$` matches the absolute end only, so the
  // literal `$` rejected `"text/plain\n"` that CPython accepts. The TS regex now
  // ends in `(?:\n)?$` — see the "text/plain\n" / "a/b;x\n" pass cases plus the
  // "\r\n" / "\n\n" / "\nx" reject cases that pin the exactly-one-`\n` rule.
  it.each([
    // accepted (returned unchanged)
    ["text/plain", "text/plain"],
    ["application/pdf", "application/pdf"],
    [
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.document",
    ],
    ["image/png", "image/png"],
    ["text/html; charset=utf-8", "text/html; charset=utf-8"],
    ["text/plain;charset=UTF-8", "text/plain;charset=UTF-8"],
    ["x-custom!#$&-^_.+/y-sub!#$&-^_.+", "x-custom!#$&-^_.+/y-sub!#$&-^_.+"],
    ["a/b;", "a/b;"], // empty param suffix is valid
    ["TEXT/PLAIN", "TEXT/PLAIN"], // case preserved
    ["a/b;café", "a/b;café"], // non-ASCII allowed in `;`-suffix (only 0x00-0x1f/0x7f excluded)
    ["text/plain\n", "text/plain\n"], // single trailing newline tolerated (the $ fix)
    ["a/b;x\n", "a/b;x\n"], // suffix stops at \n, then $ matches before it
    // rejected -> octet-stream
    ["", "application/octet-stream"],
    ["notamimetype", "application/octet-stream"], // no slash
    ["/plain", "application/octet-stream"], // empty type
    ["text/", "application/octet-stream"], // empty subtype
    ["text/pl ain", "application/octet-stream"], // space in subtype
    ["café/plain", "application/octet-stream"], // non-ASCII in type
    ["你好/世界", "application/octet-stream"], // CJK type/subtype
    ["text/plain\r\n", "application/octet-stream"], // CRLF (not a bare \n)
    ["text/plain\n\n", "application/octet-stream"], // two trailing newlines
    ["text/plain\nx", "application/octet-stream"], // content after the \n
    ["a/b;\t", "application/octet-stream"], // tab (0x09) is a control char
    ["a/b;x\ny", "application/octet-stream"], // \n mid-suffix
    ["text/plain/extra", "application/octet-stream"], // slash not in subtype class
    ["tex@t/plain", "application/octet-stream"], // @ not a token char
    ["text/plain ", "application/octet-stream"], // NUL
    ["  text/plain", "application/octet-stream"], // leading space
  ])("mime %j -> %j", (mime, expected) => {
    expect(gdrive._validate_mime_type(mime, "F")).toBe(expected);
  });

  it("length cap is exactly 256 code points (boundary)", () => {
    const ok = "a/" + "b".repeat(254); // len 256
    expect(gdrive._validate_mime_type(ok, "F")).toBe(ok);
    const tooLong = "a/" + "b".repeat(255); // len 257
    expect(gdrive._validate_mime_type(tooLong, "F")).toBe(
      "application/octet-stream",
    );
  });
});

describe("ParityBarTextCpython313", () => {
  // stats._bar_text(value, max_value, width) -> [bar_string, rich_style].
  // 1/8-block resolution; value<=0 or max<=0 -> width spaces + "dim". Locked
  // from the CPython 3.13.2 oracle.
  //
  // KEY PARITY FIX (driven by this fuzz): when value > max_value (or width is 0),
  // `whole = int(fill_units)` exceeds `width`, so CPython's `_BAR_EMPTY * (width
  // - whole)` multiplies by a NEGATIVE count, which Python evaluates to "". JS
  // `String.repeat(negative)` throws RangeError, so the overflow cases below
  // (15/10/28, 200/100/28, 15/10/1, 5/10/0) would have crashed before the
  // `Math.max(0, ...)` clamp on each repeat count.
  it.each<[[number, number, number], [string, string]]>([
    [[0, 10, 28], ["                            ", "dim"]],
    [[5, 10, 28], ["██████████████              ", "bold green"]],
    [[10, 10, 28], ["████████████████████████████", "bold cyan"]],
    [[-5, 10, 28], ["                            ", "dim"]],
    [[5, 0, 28], ["                            ", "dim"]],
    // value > max overflows the bar past `width` with no padding (negative-mult).
    [
      [15, 10, 28],
      ["██████████████████████████████████████████", "bold cyan"],
    ],
    [
      [200, 100, 28],
      [
        "████████████████████████████████████████████████████████",
        "bold cyan",
      ],
    ],
    [[1, 1000, 28], ["▏                           ", "yellow"]],
    [[1, 8, 28], ["███▌                        ", "yellow"]],
    [[3, 8, 28], ["██████████▌                 ", "bold green"]],
    [[7, 8, 28], ["████████████████████████▌   ", "bold cyan"]],
    [[5, 16, 28], ["████████▊                   ", "yellow"]],
    [[9, 16, 28], ["███████████████▊            ", "bold green"]],
    [[5, 10, 0], ["", "bold green"]], // width 0
    [[5, 10, 1], ["▌", "bold green"]], // width 1, partial only
    [[5, 10, 2], ["█ ", "bold green"]],
    [[33, 100, 28], ["█████████▏                  ", "bold green"]], // ratio == 0.33 boundary
    [[66, 100, 28], ["██████████████████▍         ", "bold cyan"]], // ratio == 0.66 boundary
    [[32, 100, 28], ["████████▉                   ", "yellow"]], // just below 0.33
    [[3, 7, 28], ["████████████                ", "bold green"]],
    [[15, 10, 1], ["█", "bold cyan"]], // overflow with width 1
  ])("bar %j -> %j", (args, expected) => {
    expect(stats._bar_text(args[0], args[1], args[2])).toEqual(expected);
  });
});

describe("ParitySidecarJsonDumpsCpython313", () => {
  // The webfetch cache sidecar is written via _write_cache_meta -> _jsonDumps,
  // which must byte-match Python `json.dumps(meta)` with DEFAULT flags:
  // separators ", " / ": " AND ensure_ascii=True (non-ASCII -> \uXXXX, astral ->
  // surrogate pairs \uHHHH\uHHHH, DEL 0x7f -> escaped). Header values first pass
  // _sanitize_header_value (strips \r\n). Expected strings are the raw sidecar
  // bytes produced by the CPython 3.13.2 oracle; this test drives the REAL TS
  // _write_cache_meta + _jsonDumps end-to-end (no .venv at test time).
  //
  // Each tuple is [responseHeaders, expectedRawSidecarText].
  const cases: ReadonlyArray<[Record<string, string>, string]> = [
    [
      {
        etag: 'W/"snapshot-café"',
        "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
      },
      '{"etag": "W/\\"snapshot-caf\\u00e9\\"", "last_modified": "Wed, 21 Oct 2015 07:28:00 GMT"}',
    ],
    [{ etag: "abc123" }, '{"etag": "abc123"}'],
    [
      { etag: "北京 ™ © 😀" },
      '{"etag": "\\u5317\\u4eac \\u2122 \\u00a9 \\ud83d\\ude00"}',
    ],
    [
      { etag: 'has "quote" and \\ backslash and /slash' },
      '{"etag": "has \\"quote\\" and \\\\ backslash and /slash"}',
    ],
    // CRLF is stripped by _sanitize_header_value before json.dumps.
    [{ etag: "crlf\r\ninjection: evil" }, '{"etag": "crlfinjection: evil"}'],
    [
      { etag: "tab\there and DEL\x7f and form\x0cfeed" },
      '{"etag": "tab\\there and DEL\\u007f and form\\ffeed"}',
    ],
    [
      { "last-modified": "𝕳𝖊𝖑𝖑𝖔" }, // astral -> surrogate pairs
      '{"last_modified": "\\ud835\\udd73\\ud835\\udd8a\\ud835\\udd91\\ud835\\udd91\\ud835\\udd94"}',
    ],
    [
      { etag: "ÿĀ߿￿ edge bmp" }, // BMP non-ASCII edges
      '{"etag": "\\u00ff\\u0100\\u07ff\\uffff edge bmp"}',
    ],
  ];

  it.each(cases)("sidecar %j", (headers, expected) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-sc-"));
    try {
      const cp = path.join(dir, "file.bin");
      fs.writeFileSync(cp, "x");
      const rh: webfetch.ResponseHeadersLike = {
        get(name: string): string | null {
          for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === name.toLowerCase()) return v;
          }
          return null;
        },
      };
      webfetch._write_cache_meta(cp, rh);
      const scp = webfetch._sidecar_path(cp);
      const got = fs.readFileSync(scp, "utf-8");
      expect(got).toBe(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
