import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type ExcelJS from "exceljs";
import { CloseIcon } from "../icons";
import { Z } from "../zLayers";
import { blankWorkbook, cellInput, columnName, evaluator, exportXlsx, MAX_COLUMNS, MAX_ROWS, parseInput, readNative, readXlsx, writeNative } from "../spreadsheets/workbook";
import { readWorkbookFile, saveWorkbookFile, workbookFileVersion } from "../spreadsheets/files";
import { isNativeWorkbook } from "../spreadsheets/paths";
import "./spreadsheetViewer.css";

type Props = { workspaceRoot: string; path: string; onClose: () => void; onOpenExternal: (path: string) => void; onAddToChat?: (reference: string) => void };
type CellState = { value: ExcelJS.CellValue; style: Partial<ExcelJS.Style> };
type Edit = { sheet: number; address: string; before: CellState; after: CellState };
const snapshot = (cell: ExcelJS.Cell): CellState => structuredClone({ value: cell.value, style: cell.style });
const ROW_HEIGHT = 30;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const titleOf = (path: string) => path.split(/[\\/]/).pop() || "Untitled spreadsheet";

export function SpreadsheetViewer({ workspaceRoot, path, onClose, onOpenExternal, onAddToChat }: Props) {
  const [book, setBook] = useState<ExcelJS.Workbook | null>(null);
  const [filePath, setFilePath] = useState(path);
  const baseline = useRef<string | null>(null);
  const diskVersion = useRef<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [sheetId, setSheetId] = useState(0);
  const [selected, setSelected] = useState({ row: 1, col: 1 });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingExit, setPendingExit] = useState<"close" | "reload" | null>(null);
  const [saveAs, setSaveAs] = useState<"native" | "xlsx" | null>(null);
  const [destination, setDestination] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [extraRows, setExtraRows] = useState(100);
  const [extraCols, setExtraCols] = useState(20);
  const history = useRef<Edit[][]>([]);
  const future = useRef<Edit[][]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const formulaInput = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const sheet = book?.getWorksheet(sheetId);
  const cell = sheet?.getCell(selected.row, selected.col);
  const calculate = useMemo(() => book ? evaluator(book) : null, [book, revision]);
  const native = !filePath || isNativeWorkbook(filePath);
  const [sheetName, setSheetName] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const file = path ? await readWorkbookFile(workspaceRoot, path) : null;
        const workbook = file ? (isNativeWorkbook(path) ? readNative(new TextDecoder().decode(file.bytes)) : await readXlsx(file.bytes)) : blankWorkbook();
        if (!live) return;
        baseline.current = file?.base64 ?? null;
        diskVersion.current = file?.version ?? null;
        setBook(workbook);
        setSheetId(workbook.worksheets[0].id);
        setDraft(cellInput(workbook.worksheets[0].getCell("A1")));
      } catch (e) { if (live) setError(errorText(e)); }
    })();
    return () => { live = false; };
  }, [workspaceRoot, path]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [book]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  // Poll only metadata, not workbook bytes. Clean sheets follow agent edits;
  // dirty sheets retain local work and offer an explicit reload.
  useEffect(() => {
    if (!book || !filePath || busy) return;
    let live = true;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const version = await workbookFileVersion(workspaceRoot, filePath);
        if (!live || version === diskVersion.current) return;
        if (dirty || (cell && draft !== cellInput(cell))) setExternalChange(true);
        else { diskVersion.current = version; await reload(); }
      } catch { /* Deletion or rename is reported by an explicit reload/save. */ }
      finally { checking = false; }
    };
    const timer = window.setInterval(() => void check(), 2500);
    window.addEventListener("focus", check);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener("focus", check); };
  }, [book, filePath, workspaceRoot, busy, dirty, draft, sheetId, selected.row, selected.col]);

  function changed() { setRevision(v => v + 1); setDirty(true); setStatus(""); }
  function remember(edits: Edit[]) {
    history.current = [...history.current.slice(-99), edits]; future.current = []; changed();
  }
  function commit() {
    if (!cell || cell.isMerged || draft === cellInput(cell) || busy) return;
    const before = snapshot(cell);
    cell.value = parseInput(draft);
    remember([{ sheet: sheetId, address: cell.address, before, after: snapshot(cell) }]);
  }
  function applyFormat(update: (target: ExcelJS.Cell) => void) {
    if (!cell || busy || cell.isMerged) return;
    commit(); const before = snapshot(cell); update(cell);
    remember([{ sheet: sheetId, address: cell.address, before, after: snapshot(cell) }]);
  }
  async function reload() {
    if (!filePath || busy) return;
    setBusy(true); setError("");
    try {
      const file = await readWorkbookFile(workspaceRoot, filePath);
      const next = native ? readNative(new TextDecoder().decode(file.bytes)) : await readXlsx(file.bytes);
      baseline.current = file.base64; diskVersion.current = file.version; history.current = []; future.current = [];
      setBook(next); setSheetId(next.worksheets[0].id); setSelected({ row: 1, col: 1 });
      setDraft(cellInput(next.worksheets[0].getCell("A1"))); setDirty(false); setStatus("Reloaded from disk");
      setScrollTop(0); scroller.current?.scrollTo(0, 0); setPendingExit(null); setExternalChange(false);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  function select(row: number, col: number) {
    if (!sheet || busy) return;
    commit();
    const next = { row: Math.max(1, Math.min(MAX_ROWS, row)), col: Math.max(1, Math.min(MAX_COLUMNS, col)) };
    setSelected(next);
    setExtraRows(n => Math.max(n, next.row + 10));
    setExtraCols(n => Math.max(n, next.col));
    setDraft(cellInput(sheet.getCell(next.row, next.col)));
    if (scroller.current) {
      const y = (next.row - 1) * ROW_HEIGHT;
      if (y < scroller.current.scrollTop) scroller.current.scrollTop = y;
      else if (y + ROW_HEIGHT * 2 > scroller.current.scrollTop + height) scroller.current.scrollTop = y + ROW_HEIGHT * 2 - height;
    }
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-address="${columnName(next.col)}${next.row}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  function undo(redo = false) {
    if (!book || busy) return;
    const source = redo ? future : history;
    const edits = source.current.pop();
    if (!edits) return;
    for (const edit of redo ? edits : [...edits].reverse()) {
      const target = book.getWorksheet(edit.sheet)!.getCell(edit.address);
      const state = structuredClone(redo ? edit.after : edit.before);
      target.value = state.value; target.style = state.style;
    }
    (redo ? history : future).current.push(edits);
    if (cell) setDraft(cellInput(cell));
    changed();
  }
  function beginSave(kind: "native" | "xlsx", copy = false) {
    commit();
    setError("");
    if (kind === "native" && filePath && native && !copy) { void save(kind, filePath, baseline.current); return; }
    const stem = filePath.replace(/(?:\.sheet\.json|\.xlsx)$/i, "") || "Untitled";
    setDestination(`${stem}${copy ? "-copy" : ""}${kind === "native" ? ".sheet.json" : native ? ".xlsx" : "-edited.xlsx"}`);
    setSaveAs(kind);
  }
  async function save(kind: "native" | "xlsx", target: string, expected: string | null = null) {
    if (!book || busy) return;
    const suffix = kind === "native" ? ".sheet.json" : ".xlsx";
    if (!target.trim().toLowerCase().endsWith(suffix)) { setError(`Use a ${suffix} filename.`); return; }
    setBusy(true); setError("");
    try {
      const bytes = kind === "native" ? new TextEncoder().encode(writeNative(book)) : await exportXlsx(book);
      const nextBaseline = await saveWorkbookFile(workspaceRoot, target.trim(), bytes, expected);
      if (kind === "native") {
        setFilePath(target.trim()); baseline.current = nextBaseline;
        diskVersion.current = await workbookFileVersion(workspaceRoot, target.trim());
        setDirty(false); setExternalChange(false);
      }
      else if (!native) setDirty(false);
      setStatus(`Saved ${titleOf(target.trim())}`); setSaveAs(null);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  function close() {
    if (busy) return;
    if (dirty || (cell && draft !== cellInput(cell))) setPendingExit("close");
    else onClose();
  }
  function onKey(event: KeyboardEvent) {
    // Only this surface owns these shortcuts; the adjacent chat stays usable.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); event.stopPropagation(); beginSave(native ? "native" : "xlsx"); return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      if (saveAs) setSaveAs(null);
      else if (cell && draft !== cellInput(cell)) setDraft(cellInput(cell));
      else close();
      return;
    }
    if (event.target !== grid.current) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.stopPropagation(); undo(event.shiftKey); return; }
    const delta: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1], Tab: [0, event.shiftKey ? -1 : 1], Enter: [1, 0] };
    if (delta[event.key]) { event.preventDefault(); event.stopPropagation(); const [r, c] = delta[event.key]; select(selected.row + r, selected.col + c); }
    else if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); setDraft(""); formulaInput.current?.focus(); }
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); setDraft(event.key); formulaInput.current?.focus(); }
  }

  const rows = Math.min(MAX_ROWS, Math.max(extraRows, (sheet?.rowCount ?? 0) + 20));
  const cols = Math.min(MAX_COLUMNS, Math.max(extraCols, (sheet?.columnCount ?? 0) + 2));
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  const end = Math.min(rows, start + Math.ceil(height / ROW_HEIGHT) + 12);
  const widths = Array.from({ length: cols }, (_, i) => Math.max(88, Math.min(320, (sheet?.getColumn(i + 1).width ?? 16) * 7 + 12)));
  const columns = `46px ${widths.map(w => `${w}px`).join(" ")}`;
  const gridWidth = widths.reduce((sum, width) => sum + width, 46);

  return <div className="klide-sheet-dock" style={{ zIndex: Z.modal }}>
    <section className="klide-sheet-shell" aria-label={`Spreadsheet: ${titleOf(filePath)}`} onKeyDown={onKey}>
      <header className="klide-sheet-header">
        <span className="klide-sheet-mark" aria-hidden="true">▦</span>
        <div className="klide-sheet-heading"><strong>{titleOf(filePath)}</strong><span>{dirty ? "Unsaved changes" : filePath ? "Workbook" : "Start with a cell. Build from there."}</span></div>
        <div className="klide-sheet-actions">
          {filePath && !native && <button onClick={() => onOpenExternal(filePath)} title="Open saved file in its default application">Open in app ↗</button>}
          {native && <button disabled={!book || busy} onClick={() => beginSave("native")}>Save</button>}
          <button className="klide-sheet-primary" disabled={!book || busy} onClick={() => beginSave("xlsx")}>{busy ? "Saving…" : native ? "Export Excel" : "Save Excel copy"}</button>
          <button aria-label="Close spreadsheet" disabled={busy} onClick={close}><CloseIcon size={18} /></button>
        </div>
      </header>
      {error && <div role="alert" className="klide-sheet-message" data-error="true">{error}<span>{native && book && <button disabled={busy} onClick={() => beginSave("native", true)}>Save a copy</button>}<button aria-label="Dismiss error" onClick={() => setError("")}>×</button></span></div>}
      {externalChange && !error && <div role="status" className="klide-sheet-message">The file changed on disk. Your unsaved edits are still here.<button disabled={busy} onClick={() => setPendingExit("reload")}>Reload from disk</button></div>}
      {pendingExit && <div className="klide-sheet-message">Keep your unsaved changes?<span><button disabled={busy} onClick={() => setPendingExit(null)}>Keep editing</button><button disabled={busy} onClick={() => pendingExit === "reload" ? void reload() : onClose()}>Discard and {pendingExit}</button></span></div>}
      {saveAs && <form className="klide-sheet-save" onSubmit={event => { event.preventDefault(); void save(saveAs, destination); }}>
        <label htmlFor="sheet-destination">Save in workspace</label>
        <div><input id="sheet-destination" autoFocus value={destination} disabled={busy} onChange={e => setDestination(e.target.value)} /><button disabled={busy} type="submit">Save</button><button disabled={busy} type="button" onClick={() => setSaveAs(null)}>Cancel</button></div>
        {saveAs === "xlsx" && !native && <p>The copy includes cells, formulas, and supported formatting. Charts and other advanced Excel features may not be preserved. Your original stays unchanged.</p>}
      </form>}
      {!book ? <div className="klide-sheet-loading">{error ? "The workbook could not be opened." : "Opening spreadsheet…"}</div> : <>
        <div className="klide-sheet-toolbar">
          <button disabled={busy || !history.current.length} onClick={() => undo()} aria-label="Undo cell edit" title="Undo cell edit">↶</button>
          <button disabled={busy || !future.current.length} onClick={() => undo(true)} aria-label="Redo cell edit" title="Redo cell edit">↷</button>
          <span className="klide-sheet-divider" />
          <button aria-label="Bold" aria-pressed={cell?.font?.bold === true} disabled={busy || cell?.isMerged} onClick={() => applyFormat(target => { target.font = { ...target.font, bold: !target.font?.bold }; })}><strong>B</strong></button>
          <select aria-label="Number format" value={cell?.numFmt || "General"} disabled={busy || cell?.isMerged} onChange={event => applyFormat(target => { target.numFmt = event.target.value; })}>
            {!["General", "#,##0.00", "0.0%", "$#,##0.00", "yyyy-mm-dd"].includes(cell?.numFmt || "General") && <option value={cell?.numFmt}>Custom</option>}
            <option value="General">General</option><option value="#,##0.00">Number</option><option value="0.0%">Percent</option><option value="$#,##0.00">Currency ($)</option><option value="yyyy-mm-dd">Date</option>
          </select>
          {filePath && <button disabled={busy} onClick={() => dirty ? setPendingExit("reload") : void reload()}>Reload</button>}
          <button className="klide-sheet-copy" onClick={() => {
            if (!sheet || !cell || !calculate) return;
            const reference = `Spreadsheet in workspace ${workspaceRoot}: ${filePath || "Unsaved workbook"} · '${sheet.name}'!${cell.address}\n${cellInput(cell)}${cell.formula ? ` → ${calculate.display(sheet, cell)}` : ""}${dirty ? "\nThese edits have not been saved to disk yet." : ""}`;
            if (onAddToChat) { onAddToChat(reference); setStatus("Cell added to conversation draft"); return; }
            void navigator.clipboard.writeText(reference).then(() => setStatus("Cell reference copied for chat"), e => setError(errorText(e)));
          }}>{onAddToChat ? "Add to chat" : "Copy for chat"}</button>
        </div>
        <div className="klide-sheet-formula"><span>{columnName(selected.col)}{selected.row}</span><span aria-hidden="true">ƒx</span>
          <input ref={formulaInput} aria-label="Cell value or formula" value={draft} disabled={busy || cell?.isMerged} onChange={e => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); select(selected.row + 1, selected.col); grid.current?.focus(); } }} placeholder="Value or =SUM(A1:A10)" />
        </div>
        <div className="klide-sheet-scroll" ref={scroller} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
          <div ref={grid} role="grid" aria-label={sheet?.name} aria-rowcount={rows + 1} aria-colcount={cols + 1} tabIndex={0} aria-activedescendant={`sheet-cell-${sheetId}-${selected.row}-${selected.col}`} className="klide-sheet-grid" style={{ width: gridWidth }}
            onCopy={event => { if (cell && sheet && calculate) { event.preventDefault(); event.clipboardData.setData("text/plain", calculate.display(sheet, cell)); } }}
            onPaste={event => {
              if (!sheet || busy) return;
              event.preventDefault();
              const values = event.clipboardData.getData("text/plain").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map(row => row.split("\t"));
              if (values.length + selected.row - 1 > MAX_ROWS || values.some(row => row.length + selected.col - 1 > MAX_COLUMNS) || values.reduce((n, row) => n + row.length, 0) > 10_000) { setError("Paste up to 10,000 cells within the sheet’s row and column limits."); return; }
              if (values.some((row, r) => row.some((_, c) => sheet.findCell(selected.row + r, selected.col + c)?.isMerged))) { setError("This paste overlaps merged cells. Edit those cells in Excel."); return; }
              const edits: Edit[] = [];
              values.forEach((row, r) => row.forEach((text, c) => {
                const target = sheet.getCell(selected.row + r, selected.col + c); const before = snapshot(target); target.value = parseInput(text);
                edits.push({ sheet: sheetId, address: target.address, before, after: snapshot(target) });
              }));
              remember(edits); setDraft(cellInput(sheet.getCell(selected.row, selected.col)));
            }}>
            <div role="row" className="klide-sheet-column-head" style={{ gridTemplateColumns: columns }}><span role="columnheader" />{widths.map((_, i) => <span role="columnheader" key={i} data-selected={selected.col === i + 1 || undefined}>{columnName(i + 1)}</span>)}</div>
            <div style={{ height: rows * ROW_HEIGHT, position: "relative" }}>
              {sheet && calculate && Array.from({ length: Math.max(0, end - start) }, (_, i) => {
                const row = start + i + 1;
                return <div role="row" aria-rowindex={row + 1} key={row} className="klide-sheet-row" style={{ top: (row - 1) * ROW_HEIGHT, gridTemplateColumns: columns }}>
                  <span role="rowheader" data-selected={selected.row === row || undefined}>{row}</span>
                  {widths.map((_, c) => {
                    const col = c + 1;
                    const target = sheet.findCell(row, col);
                    const display = target && (!target.isMerged || target.master.address === target.address) ? calculate.display(sheet, target) : "";
                    const fill = target?.fill?.type === "pattern" ? target.fill.fgColor?.argb : undefined;
                    const color = target?.font?.color?.argb;
                    const style: CSSProperties = { fontWeight: target?.font?.bold ? 650 : undefined, fontStyle: target?.font?.italic ? "italic" : undefined,
                      backgroundColor: fill ? `#${fill.slice(-6)}` : undefined, color: color ? `#${color.slice(-6)}` : fill ? "#202522" : undefined,
                      textAlign: target?.alignment?.horizontal === "center" ? "center" : target && typeof calculate.value(sheet, target) === "number" ? "right" : "left" };
                    return <div role="gridcell" id={`sheet-cell-${sheetId}-${row}-${col}`} aria-colindex={col + 1} aria-selected={selected.row === row && selected.col === col} data-address={`${columnName(col)}${row}`} key={col} style={style} title={target?.isMerged ? "Merged cell · edit in Excel" : target ? cellInput(target) : ""} data-formula={!!target?.formula || undefined} data-error={display.startsWith("#") || undefined}
                      onClick={() => { select(row, col); grid.current?.focus(); }} onDoubleClick={() => formulaInput.current?.focus()}>{display}</div>;
                  })}
                </div>;
              })}
            </div>
          </div>
        </div>
        <footer className="klide-sheet-footer">
          <div role="tablist" aria-label="Worksheets">{book.worksheets.map(tab => <button role="tab" aria-selected={sheetId === tab.id} disabled={busy} key={tab.id} onDoubleClick={() => { if (native) setSheetName(tab.name); }} onClick={() => {
            commit(); setSheetId(tab.id); setSelected({ row: 1, col: 1 }); setDraft(cellInput(tab.getCell("A1"))); setScrollTop(0); scroller.current?.scrollTo(0, 0);
          }}>{tab.name}</button>)}<button disabled={busy} aria-label="Add worksheet" onClick={() => {
            commit(); let n = book.worksheets.length + 1; while (book.getWorksheet(`Sheet ${n}`)) n++;
            if (book.worksheets.length >= 50) { setError("A workbook can have up to 50 sheets."); return; }
            const added = book.addWorksheet(`Sheet ${n}`); setSheetId(added.id); setSelected({ row: 1, col: 1 }); setDraft(""); setScrollTop(0); scroller.current?.scrollTo(0, 0); changed();
          }}>+</button></div>
          {native && <button disabled={busy} onClick={() => setSheetName(sheet?.name ?? "")}>Rename</button>}
          <span role="status">{status || `${sheet?.actualRowCount ?? 0} rows · ${sheet?.actualColumnCount ?? 0} columns`}</span>
          <button disabled={rows >= MAX_ROWS || busy} onClick={() => setExtraRows(rows + 100)} title="Show 100 more rows">+ Rows</button>
        </footer>
        {sheetName !== null && <form className="klide-sheet-save" onSubmit={event => {
          event.preventDefault();
          if (!sheet || !sheetName.trim() || sheetName.length > 31 || /[\\/*?:\[\]]/.test(sheetName) || book.worksheets.some(s => s.id !== sheet.id && s.name.toLowerCase() === sheetName.toLowerCase())) { setError("Choose a unique sheet name of 1–31 characters without / \\ * ? : [ ]."); return; }
          // Renaming a referenced sheet requires rewriting formula tokens.
          // Keep existing references reliable until that operation is supported.
          let hasReferences = false; book.eachSheet(s => s.eachRow(row => row.eachCell(c => {
            if (c.formula?.includes(`${sheet.name}!`) || c.formula?.includes(`'${sheet.name.replace(/'/g, "''")}'!`)) hasReferences = true;
          })));
          if (hasReferences && sheetName.trim() !== sheet.name) { setError("This sheet is referenced by formulas. Rename it in Excel to update those references together."); return; }
          sheet.name = sheetName.trim(); setSheetName(null); changed();
        }}><label htmlFor="sheet-name">Worksheet name</label><div><input id="sheet-name" value={sheetName} autoFocus onChange={e => setSheetName(e.target.value)} /><button type="submit">Rename</button><button type="button" onClick={() => setSheetName(null)}>Cancel</button></div></form>}
      </>}
    </section>
  </div>;
}
