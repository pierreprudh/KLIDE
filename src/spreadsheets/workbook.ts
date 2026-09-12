import ExcelJS from "exceljs";
import FormulaParser from "fast-formula-parser";
import { format } from "ssf";

export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 256;
const MAX_CELLS = 100_000;
export type CellInput = string | number | boolean | null;
export type NativeCell = { value: CellInput; format?: string; bold?: boolean; color?: string; fill?: string };
export type NativeWorkbook = {
  version: 1;
  sheets: { name: string; cells: Record<string, NativeCell>; widths?: number[] }[];
};

export function columnName(column: number): string {
  let name = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}

export function parseInput(text: string): ExcelJS.CellValue {
  if (text.startsWith("'")) return text.slice(1);
  if (text.startsWith("=")) return { formula: text.slice(1) };
  if (text === "") return null;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  // Keep identifiers such as 00123 as text.
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) && Number.isFinite(Number(text))) return Number(text);
  return text;
}

export function cellInput(cell: ExcelJS.Cell): string {
  if (cell.formula) return `=${cell.formula}`;
  if (typeof cell.value === "string" && /^[=']/.test(cell.value)) return `'${cell.value}`;
  if (cell.value instanceof Date) return cell.value.toISOString().slice(0, 10);
  return cell.text;
}

export function blankWorkbook(): ExcelJS.Workbook {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Sheet 1");
  return book;
}

export function readNative(text: string): ExcelJS.Workbook {
  const data = JSON.parse(text) as NativeWorkbook;
  if (data.version !== 1 || !Array.isArray(data.sheets) || !data.sheets.length || data.sheets.length > 50) throw new Error("Expected a version 1 workbook with 1–50 sheets.");
  const book = new ExcelJS.Workbook();
  let count = 0;
  for (const source of data.sheets) {
    if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 31 || /[\\/*?:\[\]]/.test(source.name) || book.worksheets.some(s => s.name.toLowerCase() === source.name.toLowerCase())) throw new Error("Sheet names must be unique and valid Excel names (up to 31 characters).");
    if (!source.cells || typeof source.cells !== "object" || Array.isArray(source.cells)) throw new Error(`Missing cells in ${source.name}.`);
    const sheet = book.addWorksheet(source.name);
    for (const [address, spec] of Object.entries(source.cells)) {
      if (!/^[A-Z]{1,3}[1-9]\d{0,4}$/.test(address)) throw new Error(`Invalid cell address: ${address}`);
      const letters = address.match(/^[A-Z]+/)![0];
      const col = [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
      if (col > MAX_COLUMNS || Number(address.slice(letters.length)) > MAX_ROWS || ++count > MAX_CELLS) throw new Error("Workbook exceeds the built-in editor’s limits (10,000 rows, 256 columns, 100,000 populated cells).");
      if (!spec || !(spec.value === null || ["string", "number", "boolean"].includes(typeof spec.value)) || (typeof spec.value === "number" && !Number.isFinite(spec.value))) throw new Error(`Invalid value at ${source.name}!${address}`);
      const cell = sheet.getCell(address);
      cell.value = typeof spec.value === "string" && spec.value.startsWith("=") ? { formula: spec.value.slice(1) } : typeof spec.value === "string" && spec.value.startsWith("'") ? spec.value.slice(1) : spec.value;
      if (typeof spec.format === "string") cell.numFmt = spec.format;
      cell.font = { name: "Arial", size: 11, bold: spec.bold === true, ...(typeof spec.color === "string" && /^[0-9A-F]{6}$/i.test(spec.color) ? { color: { argb: `FF${spec.color}` } } : {}) };
      if (typeof spec.fill === "string" && /^[0-9A-F]{6}$/i.test(spec.fill)) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${spec.fill}` } };
    }
    if (Array.isArray(source.widths)) source.widths.slice(0, MAX_COLUMNS).forEach((width, i) => {
      if (typeof width === "number" && Number.isFinite(width)) sheet.getColumn(i + 1).width = Math.max(6, Math.min(60, width));
    });
  }
  return book;
}

export function writeNative(book: ExcelJS.Workbook): string {
  let count = 0;
  const data: NativeWorkbook = { version: 1, sheets: book.worksheets.map(sheet => {
    const cells: Record<string, NativeCell> = {};
    // eachCell() skips styled empty inputs; findCell preserves them without
    // materializing the holes in a sparse worksheet.
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = sheet.findRow(r);
      if (!row) continue;
      for (let c = 1; c <= row.cellCount; c++) {
        const cell = row.findCell(c);
        if (!cell) continue;
        if (cell.value === null && !cell.numFmt && !cell.font?.bold && !cell.font?.color?.argb && !(cell.fill?.type === "pattern" && cell.fill.fgColor?.argb)) continue;
        if (++count > MAX_CELLS) throw new Error("Workbook exceeds 100,000 populated cells. Split it into smaller workbooks before saving.");
        const value = cell.formula ? `=${cell.formula}` : typeof cell.value === "string" && /^[=']/.test(cell.value) ? `'${cell.value}` : cell.value;
        const spec: NativeCell = { value: value === null || ["string", "number", "boolean"].includes(typeof value) ? value as CellInput : cell.text };
        if (cell.numFmt) spec.format = cell.numFmt;
        if (cell.font?.bold) spec.bold = true;
        if (cell.font?.color?.argb) spec.color = cell.font.color.argb.slice(-6);
        if (cell.fill?.type === "pattern" && cell.fill.fgColor?.argb) spec.fill = cell.fill.fgColor.argb.slice(-6);
        cells[cell.address] = spec;
      }
    }
    return { name: sheet.name, cells, widths: Array.from({ length: Math.max(sheet.columns?.length ?? 0, sheet.columnCount) }, (_, i) => sheet.getColumn(i + 1).width ?? 16) };
  }) };
  return `${JSON.stringify(data, null, 2)}\n`;
}

export async function readXlsx(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  let count = 0;
  if (!book.worksheets.length || book.worksheets.length > 50) throw new Error("This workbook must have 1–50 sheets.");
  for (const sheet of book.worksheets) {
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) throw new Error("This workbook is too large for the built-in editor. Open it in its app.");
    sheet.eachRow(row => row.eachCell(() => { count++; }));
  }
  if (count > MAX_CELLS) throw new Error("This workbook has more than 100,000 populated cells. Open it in its app.");
  return book;
}

/** A fresh evaluator per revision means edits invalidate every dependent sheet. */
export function evaluator(book: ExcelJS.Workbook) {
  const cache = new Map<string, unknown>();
  const visiting = new Set<string>();
  const get = (sheetName: string, row: number, col: number): unknown => {
    const sheet = book.worksheets.find(s => s.name.toLowerCase() === sheetName.toLowerCase());
    if (!sheet || row < 1 || col < 1 || row > MAX_ROWS || col > MAX_COLUMNS) return FormulaParser.FormulaError.REF;
    const key = `${sheet.id}:${row}:${col}`;
    if (cache.has(key)) return cache.get(key);
    if (visiting.has(key) || visiting.size > 200) return FormulaParser.FormulaError.REF;
    const cell = sheet.findCell(row, col);
    if (!cell) return null;
    if (!cell.formula) {
      if (cell.value instanceof Date) return cell.value.getTime() / 86400000 + (book.properties.date1904 ? 24107 : 25569);
      if (cell.value && typeof cell.value === "object") return "error" in cell.value ? new FormulaParser.FormulaError(cell.value.error) : cell.text;
      return cell.value;
    }
    visiting.add(key);
    let result: unknown;
    try {
      // Each nested evaluation owns parser state; formulas never execute JS.
      const parser = new FormulaParser({
        onCell: ref => get(ref.sheet ?? sheet.name, ref.row, ref.col),
        onRange: ref => {
          const target = book.worksheets.find(s => s.name.toLowerCase() === (ref.sheet ?? sheet.name).toLowerCase());
          if (!target) throw FormulaParser.FormulaError.REF;
          const endRow = ref.to.row;
          const endCol = ref.to.col;
          if (endRow > MAX_ROWS || endCol > MAX_COLUMNS || ref.from.row < 1 || ref.from.col < 1) throw FormulaParser.FormulaError.REF;
          if ((endRow - ref.from.row + 1) * (endCol - ref.from.col + 1) > MAX_CELLS) throw FormulaParser.FormulaError.NUM;
          return Array.from({ length: endRow - ref.from.row + 1 }, (_, r) => Array.from({ length: endCol - ref.from.col + 1 }, (_, c) => get(target.name, ref.from.row + r, ref.from.col + c)));
        },
      });
      result = parser.parse(cell.formula, { sheet: sheet.name, row, col });
      if (Array.isArray(result)) result = FormulaParser.FormulaError.VALUE;
      if (typeof result === "number" && !Number.isFinite(result)) result = FormulaParser.FormulaError.NUM;
    } catch (error) { result = error instanceof Error ? error : FormulaParser.FormulaError.VALUE; }
    visiting.delete(key);
    cache.set(key, result);
    return result;
  };
  return {
    value: (sheet: ExcelJS.Worksheet, cell: ExcelJS.Cell) => get(sheet.name, Number(cell.row), Number(cell.col)),
    display(sheet: ExcelJS.Worksheet, cell: ExcelJS.Cell): string {
      const value = get(sheet.name, Number(cell.row), Number(cell.col));
      if (value instanceof Error) return /^#[A-Z0-9/?!]+$/.test(value.name) ? value.name : /^#[A-Z0-9/?!]+$/.test(value.message) ? value.message : "#VALUE!";
      if (value === null || value === undefined) return "";
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      try { return format(cell.numFmt || "General", value as string | number, { date1904: book.properties.date1904 }); }
      catch { return String(value); }
    },
  };
}

export async function exportXlsx(book: ExcelJS.Workbook): Promise<Uint8Array> {
  const evaluate = evaluator(book);
  const results: { cell: ExcelJS.Cell; formula: string; value: unknown }[] = [];
  book.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
    if (cell.isMerged && cell.master.address !== cell.address) return;
    if (cell.formula) results.push({ cell, formula: cell.formula, value: evaluate.value(sheet, cell) });
  })));
  const errors = results.filter(result => result.value instanceof Error);
  if (errors.length) throw new Error(`Resolve ${errors.length} formula error${errors.length === 1 ? "" : "s"} before exporting (${errors.slice(0, 3).map(r => `${r.cell.worksheet.name}!${r.cell.address}`).join(", ")}). Unsupported formulas can be calculated in Excel using the original file.`);
  for (const { cell, formula, value } of results) cell.value = { formula, result: (value ?? 0) as string | number | boolean };
  book.calcProperties.fullCalcOnLoad = true;
  return new Uint8Array(await book.xlsx.writeBuffer());
}
