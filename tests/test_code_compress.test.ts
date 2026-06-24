/**
 * Tests for compress_to_skeleton in code_compress.ts.
 *
 * 1:1 port of tests/test_code_compress.py.
 */
import { describe, it, expect } from "vitest";
import { compress_to_skeleton } from "../src/token_goat/code_compress.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const _PY_FULL = `import os
from pathlib import Path
from typing import Any

__all__ = ["Greeter", "greet"]

GreeterType = Any

class Greeter:
    label = "hi"

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self._cache: dict[str, str] = {}

    def greet(self, name: str) -> str:
        key = f"{self.prefix}-{name}"
        result = f"{self.prefix} {name}"
        return result


def greet(name: str) -> str:
    msg = f"Hello, {name}"
    return msg
`;

// ---------------------------------------------------------------------------
// Test 1: large Python file retains all def/class signatures
// ---------------------------------------------------------------------------

it("test_python_signatures_retained", () => {
  const result = compress_to_skeleton(_PY_FULL, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain("class Greeter:");
  expect(result).toContain("def __init__(self, prefix: str) -> None:");
  expect(result).toContain("def greet(self, name: str) -> str:");
  expect(result).toContain("def greet(name: str) -> str:");
});

// ---------------------------------------------------------------------------
// Test 2: decorators immediately before def/class are kept
// ---------------------------------------------------------------------------

it("test_decorators_kept", () => {
  const source =
    "import functools\n" +
    "\n" +
    "@functools.lru_cache(maxsize=128)\n" +
    "def cached_func(x: int) -> int:\n" +
    "    return x * 2\n" +
    "\n" +
    "class MyClass:\n" +
    "    @staticmethod\n" +
    "    def static_method() -> None:\n" +
    "        pass\n";
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain("@functools.lru_cache(maxsize=128)");
  expect(result).toContain("def cached_func(x: int) -> int:");
  expect(result).toContain("@staticmethod");
  expect(result).toContain("def static_method() -> None:");
});

// ---------------------------------------------------------------------------
// Test 3: function body replaced with # ... N lines sentinel
// ---------------------------------------------------------------------------

it("test_body_replaced_with_sentinel", () => {
  const source = "def foo():\n    line1 = 1\n    line2 = 2\n    line3 = 3\n";
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain("def foo():");
  expect(result).toContain("# ... 3 lines");
  expect(result).not.toContain("line1");
  expect(result).not.toContain("line2");
  expect(result).not.toContain("line3");
});

// ---------------------------------------------------------------------------
// Test 4: import lines kept verbatim
// ---------------------------------------------------------------------------

it("test_import_lines_kept", () => {
  const source =
    "import os\nfrom pathlib import Path\nfrom typing import Any, Dict\n\ndef foo(): pass\n";
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain("import os");
  expect(result).toContain("from pathlib import Path");
  expect(result).toContain("from typing import Any, Dict");
});

// ---------------------------------------------------------------------------
// Test 5: compress_to_skeleton returns skeleton for a short file (150 lines)
// ---------------------------------------------------------------------------

it("test_small_file_still_returns_skeleton", () => {
  // The 200-line threshold lives in the hook, not in compress_to_skeleton.
  const lines: string[] = ["import os", ""];
  for (let i = 0; i < 148; i++) {
    lines.push(`# comment ${i}`);
  }
  const source = lines.join("\n");
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain("import os");
});

// ---------------------------------------------------------------------------
// Test 6: unsupported extensions return None
// ---------------------------------------------------------------------------

it("test_unsupported_ext_returns_none", () => {
  const body = "<html><body>hello</body></html>";
  expect(compress_to_skeleton(body, ".html")).toBeNull();
  expect(compress_to_skeleton(body, ".md")).toBeNull();
  expect(compress_to_skeleton(body, ".txt")).toBeNull();
  expect(compress_to_skeleton(body, ".css")).toBeNull();
  expect(compress_to_skeleton(body, "")).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 7: __all__ kept verbatim
// ---------------------------------------------------------------------------

it("test_dunder_all_kept", () => {
  const source =
    '__all__ = ["MyClass", "my_func"]\n\ndef my_func():\n    return 1\n';
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain('__all__ = ["MyClass", "my_func"]');
});

// ---------------------------------------------------------------------------
// Test 8: nested class/function — outer and inner signatures both kept,
//          bodies suppressed separately
// ---------------------------------------------------------------------------

it("test_nested_class_and_method", () => {
  const source =
    "class Outer:\n" +
    "    class_attr = 1\n" +
    "    extra_attr = 2\n" +
    "    def outer_method(self):\n" +
    "        x = 1\n" +
    "        y = 2\n" +
    "    class Inner:\n" +
    "        def inner_method(self):\n" +
    "            return 42\n";
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  // All four signatures present
  expect(result).toContain("class Outer:");
  expect(result).toContain("def outer_method(self):");
  expect(result).toContain("class Inner:");
  expect(result).toContain("def inner_method(self):");
  // Body lines suppressed
  expect(result).not.toContain("class_attr");
  expect(result).not.toContain("x = 1");
  expect(result).not.toContain("return 42");
  // Sentinel markers present
  expect(result).toContain("# ... ");
});

// ---------------------------------------------------------------------------
// Test 9: JS/TS file — function/class signatures kept, bodies replaced
// ---------------------------------------------------------------------------

it("test_js_ts_signatures_and_bodies", () => {
  const source =
    "import React from 'react';\n" +
    "\n" +
    "function MyComponent(props) {\n" +
    "    const x = props.x;\n" +
    "    const y = props.y;\n" +
    "    return x + y;\n" +
    "}\n" +
    "\n" +
    "class MyClass {\n" +
    "    constructor(x) {\n" +
    "        this.x = x;\n" +
    "    }\n" +
    "}\n";
  const result = compress_to_skeleton(source, ".ts");
  expect(result).not.toBeNull();
  expect(result).toContain("function MyComponent(props)");
  expect(result).toContain("class MyClass");
  // Bodies replaced
  expect(result).toContain("// ... ");
  expect(result).not.toContain("const x = props.x");
  expect(result).not.toContain("this.x = x");
});

// ---------------------------------------------------------------------------
// Test 10: empty file returns empty string
// ---------------------------------------------------------------------------

it("test_empty_file_returns_empty_string", () => {
  expect(compress_to_skeleton("", ".py")).toBe("");
  expect(compress_to_skeleton("", ".ts")).toBe("");
});

// ---------------------------------------------------------------------------
// Test 11: file with only imports — all lines kept, no bodies to suppress
// ---------------------------------------------------------------------------

it("test_only_imports_kept", () => {
  const source = "import os\nfrom pathlib import Path\nfrom typing import Any\n";
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain("import os");
  expect(result).toContain("from pathlib import Path");
  expect(result).toContain("from typing import Any");
  // No sentinel (no bodies to suppress)
  expect(result).not.toContain("# ...");
});

// ---------------------------------------------------------------------------
// Test 12: async def kept like a regular def
// ---------------------------------------------------------------------------

it("test_async_def_kept", () => {
  const source =
    "import asyncio\n" +
    "\n" +
    "async def fetch(url: str) -> str:\n" +
    "    resp = await get(url)\n" +
    "    return resp.text\n";
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain("async def fetch(url: str) -> str:");
  expect(result).toContain("# ... 2 lines");
  expect(result).not.toContain("resp = await");
  expect(result).not.toContain("return resp.text");
});

// ---------------------------------------------------------------------------
// Extra: type aliases at top level kept verbatim
// ---------------------------------------------------------------------------

it("test_type_alias_kept", () => {
  const source =
    "import typing\n\nMyType = typing.Union[str, int]\n\ndef foo():\n    pass\n";
  const result = compress_to_skeleton(source, ".py");
  expect(result).not.toBeNull();
  expect(result).toContain("MyType = typing.Union[str, int]");
});

// ---------------------------------------------------------------------------
// Extra: supported extensions all return non-None for non-empty source
// ---------------------------------------------------------------------------

describe("test_all_supported_exts_return_string", () => {
  for (const ext of [
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".go",
    ".rs",
    ".java",
  ]) {
    it(`ext=${ext}`, () => {
      const source = "// hello\nfunction foo() {\n    return 1;\n}\n";
      const result = compress_to_skeleton(source, ext);
      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
    });
  }
});
