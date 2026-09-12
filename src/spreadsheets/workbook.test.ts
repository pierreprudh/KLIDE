import { describe, expect, it } from "vitest";
import { blankWorkbook, cellInput, evaluator, exportXlsx, parseInput, readNative, readXlsx, writeNative } from "./workbook";

describe("spreadsheet editing and calculation", () => {
  it("recalculates dependents across sheets after editing an input", () => {
    const book = readNative(JSON.stringify({ version: 1, sheets: [
      { name: "Inputs", cells: { A1: { value: 10 }, A2: { value: 20 } } },
      { name: "Summary", cells: { A1: { value: "=SUM(Inputs!A1:A2)" }, B1: { value: "=A1*2" }, C1: { value: '=IF(B1>50,"Yes","No")' } } },
    ] }));
    const sheet = book.getWorksheet("Summary")!;
    let calculate = evaluator(book);
    expect(calculate.value(sheet, sheet.getCell("B1"))).toBe(60);
    expect(calculate.display(sheet, sheet.getCell("C1"))).toBe("Yes");
    book.getWorksheet("Inputs")!.getCell("A1").value = 5;
    calculate = evaluator(book);
    expect(calculate.value(sheet, sheet.getCell("B1"))).toBe(50);
    expect(calculate.display(sheet, sheet.getCell("C1"))).toBe("No");
  });

  it("shows divide-by-zero, missing sheet and circular reference errors and refuses export", async () => {
    const book = blankWorkbook(); const sheet = book.worksheets[0];
    sheet.getCell("A1").value = { formula: "1/0" };
    sheet.getCell("B1").value = { formula: "Missing!A1" };
    sheet.getCell("C1").value = { formula: "C1+1" };
    const calculate = evaluator(book);
    expect(calculate.display(sheet, sheet.getCell("A1"))).toBe("#DIV/0!");
    expect(calculate.display(sheet, sheet.getCell("B1"))).toBe("#REF!");
    expect(calculate.display(sheet, sheet.getCell("C1"))).toBe("#REF!");
    await expect(exportXlsx(book)).rejects.toThrow("3 formula errors");
  });

  it("round trips formulas, cached results, formats and sheet names through Excel", async () => {
    const book = readNative(JSON.stringify({ version: 1, sheets: [{ name: "Annual budget", cells: {
      A1: { value: "Revenue", bold: true, color: "FFFFFF", fill: "225544" },
      B1: { value: 1250, format: "$#,##0.00" }, B2: { value: "=B1*1.2", format: "$#,##0.00" },
    }, widths: [25, 18] }] }));
    const restored = await readXlsx(await exportXlsx(book));
    const sheet = restored.worksheets[0];
    expect(sheet.name).toBe("Annual budget");
    expect(sheet.getCell("B2").formula).toBe("B1*1.2");
    expect(sheet.getCell("B2").result).toBe(1500);
    expect(evaluator(restored).display(sheet, sheet.getCell("B2"))).toBe("$1,500.00");
    expect(sheet.getCell("A1").font.bold).toBe(true);
    expect(sheet.getColumn(1).width).toBe(25);
    expect(readNative(writeNative(book)).worksheets[0].getCell("A1").font.color?.argb).toBe("FFFFFFFF");
  });

  it("keeps typed numbers, booleans, identifiers and explicit text distinct", () => {
    expect(parseInput("00123")).toBe("00123");
    expect(parseInput("12.5")).toBe(12.5);
    expect(parseInput("FALSE")).toBe(false);
    expect(parseInput("'=A1")).toBe("=A1");
    expect(parseInput("=A1")).toEqual({ formula: "A1" });
    const book = blankWorkbook();
    book.worksheets[0].getCell("A1").value = { formula: "SUM(B1:B3)" };
    expect(cellInput(book.worksheets[0].getCell("A1"))).toBe("=SUM(B1:B3)");
    book.worksheets[0].getCell("B1").value = "=plain text";
    expect(readNative(writeNative(book)).worksheets[0].getCell("B1").value).toBe("=plain text");
  });

  it("rejects malformed and excessive native workbooks before creating out-of-range cells", () => {
    for (const address of ["A0", "A10001", "ZZZ1", "constructor"]) {
      expect(() => readNative(JSON.stringify({ version: 1, sheets: [{ name: "Sheet", cells: { [address]: { value: 1 } } }] }))).toThrow();
    }
    expect(() => readNative('{"version":2,"sheets":[]}')).toThrow();
  });

  it("reads empty references without growing workbook dimensions", () => {
    const book = blankWorkbook(); const sheet = book.worksheets[0];
    sheet.getCell("A1").value = { formula: "SUM(B1:B1000)" };
    expect(evaluator(book).value(sheet, sheet.getCell("A1"))).toBe(0);
    expect(sheet.rowCount).toBe(1);
  });

  it("preserves formatting on empty input cells in native saves", () => {
    const book = blankWorkbook();
    book.worksheets[0].getCell("B8").numFmt = "0.0%";
    book.worksheets[0].getColumn(2).width = 24;
    const restored = readNative(writeNative(book));
    expect(restored.worksheets[0].getCell("B8").numFmt).toBe("0.0%");
    expect(restored.worksheets[0].getColumn(2).width).toBe(24);
  });
});
