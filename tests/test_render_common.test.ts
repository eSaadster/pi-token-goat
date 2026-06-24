/**
 * Unit tests for token_goat/render/common — shared CLI rendering helpers.
 *
 * 1:1 port of tests/test_render_common.py. The three Python test classes
 * (TestRenderTable / TestRenderList / TestRenderPanel) map to three describe
 * blocks; each `def test_*` maps to one `it()` with the same name and polarity.
 *
 * Parity seam — Rich -> local renderables:
 *   The Python suite imports `Table` from rich.table and `Panel` from
 *   rich.panel for its `isinstance` checks. The TS port ships no Rich
 *   equivalent (PORT-PLAN §4 maps rich -> picocolors + cli-table3, neither yet
 *   on disk), so render/common.ts defines minimal local Table/Panel classes
 *   that reproduce the exact surface these tests read (table.columns length,
 *   panel.title, panel.border_style). This file imports those local classes;
 *   `isinstance(x, Table)` -> `x instanceof Table`.
 *
 *   panel.title is None in Python for the empty-title case; the TS Panel stores
 *   `undefined` there (the project's exactOptionalPropertyTypes convention), so
 *   `panel.title is None` -> `panel.title === undefined`.
 *
 * No module-global state, no data-dir/fs use, no caplog: render/common is pure.
 */
import { describe, expect, it } from "vitest";

import {
  Panel,
  Table,
  render_list,
  render_panel,
  render_table,
} from "../src/token_goat/render/common.js";

describe("render/common (port of tests/test_render_common.py)", () => {
  // -------------------------------------------------------------------------
  // TestRenderTable — render_table function.
  // -------------------------------------------------------------------------
  describe("TestRenderTable", () => {
    it("test_render_table_basic", () => {
      // Test basic table creation with headers and rows.
      const table = render_table(
        ["Name", "Value"],
        [
          ["foo", "100"],
          ["bar", "200"],
        ],
      );
      expect(table).toBeInstanceOf(Table);
    });

    it("test_render_table_headers", () => {
      // Test that headers are correctly set.
      const table = render_table(["Col1", "Col2", "Col3"], [["a", "b", "c"]]);
      expect(table).toBeInstanceOf(Table);
      // Rich Table's columns are accessed via the columns property.
      expect(table.columns.length).toBe(3);
    });

    it("test_render_table_multiple_rows", () => {
      // Test table with multiple rows.
      const rows = [
        ["row1col1", "row1col2"],
        ["row2col1", "row2col2"],
        ["row3col1", "row3col2"],
      ];
      const table = render_table(["A", "B"], rows);
      expect(table).toBeInstanceOf(Table);
      // Verify table was created successfully.
      expect(table.columns.length).toBe(2);
    });

    it("test_render_table_empty", () => {
      // Test table creation with empty rows.
      const table = render_table(["Name", "Value"], []);
      expect(table).toBeInstanceOf(Table);
      expect(table.columns.length).toBe(2);
    });

    it("test_render_table_with_title", () => {
      // Test table creation with title (reserved for future use).
      const table = render_table(["X", "Y"], [["1", "2"]], "Test Table");
      expect(table).toBeInstanceOf(Table);
    });
  });

  // -------------------------------------------------------------------------
  // TestRenderList — render_list function.
  // -------------------------------------------------------------------------
  describe("TestRenderList", () => {
    it("test_render_list_basic", () => {
      // Test basic list rendering with default bullet.
      const items = ["item 1", "item 2", "item 3"];
      const result = render_list(items);
      expect(result).toContain("• item 1");
      expect(result).toContain("• item 2");
      expect(result).toContain("• item 3");
    });

    it("test_render_list_custom_bullet", () => {
      // Test list rendering with custom bullet character.
      const items = ["apple", "banana"];
      const result = render_list(items, "", "-");
      expect(result).toContain("- apple");
      expect(result).toContain("- banana");
      expect(result).not.toContain("•");
    });

    it("test_render_list_empty", () => {
      // Test list rendering with empty items.
      const result = render_list([]);
      expect(result).toBe("");
    });

    it("test_render_list_single_item", () => {
      // Test list rendering with single item.
      const result = render_list(["only item"]);
      expect(result).toBe("• only item");
    });

    it("test_render_list_multiline_output", () => {
      // Test that list items are separated by newlines.
      const items = ["first", "second", "third"];
      const result = render_list(items);
      const lines = result.split("\n");
      expect(lines.length).toBe(3);
    });

    it("test_render_list_with_title", () => {
      // Test list rendering with title (reserved for future use).
      const result = render_list(["item"], "My List");
      expect(result).toContain("• item");
    });

    it("test_render_list_special_characters", () => {
      // Test list rendering with items containing special characters.
      const items = ["item with → arrow", "item with → emoji"];
      const result = render_list(items);
      expect(result).toContain("item with → arrow");
      expect(result).toContain("item with → emoji");
    });
  });

  // -------------------------------------------------------------------------
  // TestRenderPanel — render_panel function.
  // -------------------------------------------------------------------------
  describe("TestRenderPanel", () => {
    it("test_render_panel_basic", () => {
      // Test basic panel creation.
      const panel = render_panel("Hello, World!");
      expect(panel).toBeInstanceOf(Panel);
    });

    it("test_render_panel_with_title", () => {
      // Test panel creation with title.
      const panel = render_panel("Content", "My Panel");
      expect(panel).toBeInstanceOf(Panel);
      expect(panel.title).toBe("My Panel");
    });

    it("test_render_panel_with_style", () => {
      // Test panel creation with custom border style.
      const panel = render_panel("Content", "Panel", "bright_cyan");
      expect(panel).toBeInstanceOf(Panel);
      expect(panel.border_style).toBe("bright_cyan");
    });

    it("test_render_panel_empty_title", () => {
      // Test that empty title results in None (no title).
      const panel = render_panel("Content", "");
      expect(panel).toBeInstanceOf(Panel);
      // Empty string title should result in None (undefined in the TS port).
      expect(panel.title).toBeUndefined();
    });

    it("test_render_panel_default_style", () => {
      // Test panel with default style.
      const panel = render_panel("Content");
      expect(panel).toBeInstanceOf(Panel);
      expect(panel.border_style).toBe("dim");
    });

    it("test_render_panel_multiline_content", () => {
      // Test panel with multiline content.
      const content = "Line 1\nLine 2\nLine 3";
      const panel = render_panel(content, "Multi-line");
      expect(panel).toBeInstanceOf(Panel);
    });

    it("test_render_panel_all_styles", () => {
      // Test panel with different style values.
      for (const style of ["dim", "bright_cyan", "bold green", "red"]) {
        const panel = render_panel("Content", "", style);
        expect(panel.border_style).toBe(style);
      }
    });
  });
});
