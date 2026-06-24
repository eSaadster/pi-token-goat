/**
 * Common rendering helpers for consistent CLI output formatting.
 *
 * Faithful port of src/token_goat/render/common.py. The Python module builds
 * on the `rich` library's Table and Panel renderables; this port replaces Rich
 * (no equivalent is shipped in the TS deps — see PORT-PLAN §4, which maps
 * `rich -> picocolors + cli-table3`, neither of which is yet on disk) with two
 * minimal local renderable classes — `Table` and `Panel` — that reproduce the
 * exact observable surface the Python test-suite asserts on:
 *
 *   - Table:  isinstance(table, Table); table.columns (length per header).
 *   - Panel:  isinstance(panel, Panel); panel.title (None/undefined when the
 *             title arg is empty); panel.border_style (the style string).
 *
 * The three exported factories mirror the Python `__all__` exactly
 * (render_list, render_panel, render_table) so callers importing from
 * "token_goat/render/common" keep the same import surface.
 *
 * Parity notes:
 *   - render_table copies Rich's construction shape: one column per header (in
 *     order), one row per input row. Rich's Table.columns is the list of Column
 *     objects; the Python tests only ever read len(table.columns), so the TS
 *     Table.columns is an array of the same length (one entry per header). The
 *     Table styling kwargs (show_header / header_style / show_edge / box /
 *     pad_edge / padding) are preserved as fields on the instance so a future
 *     Rich-equivalent renderer (cli-table3) can read them; none is asserted by
 *     the current tests.
 *   - render_list is pure string math: `f"{bullet} {item}"` joined by "\n".
 *     Copied verbatim — an empty items list yields "" (join of no parts),
 *     matching Python's "\n".join([]) == "".
 *   - render_panel maps the empty-title sentinel exactly: Python passes
 *     `title if title else None` to Rich, so an empty-string title becomes
 *     None. The TS port stores `undefined` for that case (the project's
 *     exactOptionalPropertyTypes convention uses undefined, never null), and
 *     the test asserts `panel.title === undefined` where Python asserts
 *     `panel.title is None`.
 *
 * Pure, dependency-free, sync. Imports stay within the render package
 * (./ansi.js, ./types.js) and reach UP one level for top-level modules
 * (../util.js) per the directory-depth import rule.
 */

// `RenderableType` is a rich type the Python source imports only under
// TYPE_CHECKING (from rich.console). The TS type root (../types.ts) has no
// such shape and may not be edited, so it is defined locally here as the
// minimal "string or any renderable object" the render_panel signature needs.
// Reported in new_deps_needed-adjacent known_gaps for a future render layer.
//
// A `Table` / `Panel` instance (or any future Rich-equivalent renderable) is a
// non-string object; modelling RenderableType as `object` keeps the union
// `string | RenderableType` faithful to Python's `str | RenderableType`
// without pulling in a Rich dependency.
export type RenderableType = object;

// __all__ parity: render_list, render_panel, render_table (the three factory
// functions). The Table/Panel classes are exported too so callers/tests can
// reference them for isinstance-style checks (the Python tests import the Rich
// Table/Panel for `isinstance`; the TS tests import these local ones).

/**
 * Minimal renderable mirroring the surface of rich.table.Table that
 * render_table builds and the test-suite reads.
 *
 * Rich's Table is configured with a styling preset and then populated column
 * by column / row by row. The only attribute the Python tests inspect is
 * `columns` (via len()), so the port keeps `columns` as an array with one
 * entry per added header. The styling kwargs are stored verbatim for a future
 * concrete renderer; they are not asserted by the current suite.
 */
export class Table {
  /** One entry per column header, in insertion order. */
  readonly columns: TableColumn[];
  /** One entry per added row; each is the sequence of cell strings. */
  readonly rows: string[][];

  // Styling preset copied verbatim from common.py's Table(...) kwargs.
  readonly show_header: boolean;
  readonly header_style: string;
  readonly show_edge: boolean;
  readonly box: null;
  readonly pad_edge: boolean;
  readonly padding: readonly [number, number];

  constructor() {
    this.columns = [];
    this.rows = [];
    this.show_header = true;
    this.header_style = "bold dim";
    this.show_edge = false;
    this.box = null;
    this.pad_edge = false;
    this.padding = [0, 1];
  }

  /** Append a column with the given header (mirrors Rich Table.add_column). */
  add_column(header: string): void {
    this.columns.push({ header });
  }

  /** Append a row of cell strings (mirrors Rich Table.add_row(*row)). */
  add_row(...row: string[]): void {
    this.rows.push(row);
  }
}

/** A single Table column descriptor (Rich's Column, narrowed to what is used). */
export interface TableColumn {
  readonly header: string;
}

/**
 * Minimal renderable mirroring the surface of rich.panel.Panel that
 * render_panel builds and the test-suite reads.
 *
 * The Python tests inspect `title` (None when the source title arg was empty)
 * and `border_style`. The port stores `content`, `title` (undefined for the
 * empty-title sentinel — the TS analogue of Python's None), and
 * `border_style` verbatim.
 */
export class Panel {
  readonly content: string | RenderableType;
  /** undefined when the source title was empty (Python's None sentinel). */
  readonly title: string | undefined;
  readonly border_style: string;

  constructor(
    content: string | RenderableType,
    title: string | undefined,
    border_style: string,
  ) {
    this.content = content;
    this.title = title;
    this.border_style = border_style;
  }
}

/**
 * Create a Table with consistent styling.
 *
 * Direct port of common.py.render_table: builds the styled Table, adds one
 * column per header (in order), then one row per input row.
 *
 * @param headers Column header strings.
 * @param rows Each row is a sequence of cell values (strings).
 * @param title Optional table title (currently unused — reserved, exactly as
 *   in the Python source).
 * @returns A configured Table ready to render.
 */
export function render_table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  title: string = "",
): Table {
  void title; // reserved (parity with Python signature); currently unused.
  const tbl = new Table();
  for (const header of headers) {
    tbl.add_column(header);
  }
  for (const row of rows) {
    tbl.add_row(...row);
  }
  return tbl;
}

/**
 * Format a bulleted list as a string.
 *
 * Direct port of common.py.render_list. Each item becomes `${bullet} ${item}`;
 * the lines are joined by "\n". An empty items list yields "" (join of no
 * parts), matching Python's "\n".join([]).
 *
 * @param items List of item strings.
 * @param title Optional title (currently unused — reserved, exactly as in the
 *   Python source).
 * @param bullet The bullet character prepended to each item (default "•").
 * @returns A multi-line string with each item prefixed by the bullet + a space.
 */
export function render_list(
  items: readonly string[],
  title: string = "",
  bullet: string = "•",
): string {
  void title; // reserved (parity with Python signature); currently unused.
  const lines = items.map((item) => `${bullet} ${item}`);
  return lines.join("\n");
}

/**
 * Create a Panel with consistent styling.
 *
 * Direct port of common.py.render_panel. The empty-title sentinel is mapped
 * exactly: Python passes `title if title else None` to Rich, so an empty-string
 * title becomes None; the TS port stores `undefined` for that case.
 *
 * @param content The panel content (string or renderable).
 * @param title Optional panel title (empty string -> no title).
 * @param style Panel border style (default "dim").
 * @returns A configured Panel ready to render.
 */
export function render_panel(
  content: string | RenderableType,
  title: string = "",
  style: string = "dim",
): Panel {
  return new Panel(content, title ? title : undefined, style);
}

// camelCase aliases (additive; the snake_case names above are the canonical,
// test-asserted surface).
export const renderTable = render_table;
export const renderList = render_list;
export const renderPanel = render_panel;
