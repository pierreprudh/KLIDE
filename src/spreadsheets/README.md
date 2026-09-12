# Built-in spreadsheets

Open an `.xlsx` or `.sheet.json` from the file list, command palette, or a run’s Documents section. Ask the agent in Goal mode to create or revise an Excel workbook; it produces the file for you.

The Focus surface provides worksheet tabs, a cell/formula bar, keyboard navigation, basic number formats and bold, table paste, and undo/redo for cell edits. **Add to chat** appends the selected cell’s reference, input and calculated value to the active conversation draft; it does not send a message. Unsaved values are identified in that context.

**Save** writes the native `.sheet.json` workbook. **Export Excel** creates an `.xlsx` with formulas and recalculated values. When editing an imported `.xlsx`, **Save Excel copy** creates a new file and keeps the original intact: the library does not preserve every Excel feature. The export form explains this before saving. Existing destination files are never overwritten by export.

Metadata polling refreshes clean workbooks when an agent changes the file. Unsaved work is retained and an external-change banner offers a reload. Native saves compare the originally loaded bytes against disk, refusing stale writes. Reload and close ask before discarding local changes.

## Agent creation

The shared Goal-mode system prompt includes [the agent authoring guide](agent-guide.md). `write_spreadsheet` is a native Write capability: it creates or patches an `.xlsx`, recalculates with IronCalc, blocks formula errors, and exports bytes before proposing the change. `inspect_spreadsheet` is read-only and returns paginated cells, formulas, calculated values, errors and an update hash. Neither tool depends on the viewer, a shell runtime, Excel, or network access.

Write review displays a readable cell/result diff. The validated binary payload follows the same approval, rejection memory and checkpoint path as other writes. Creates never overwrite; updates require the hash obtained by inspection and recheck exact bytes at apply time. Checkpoint rollback restores original bytes and refuses to overwrite subsequent changes. Imported complex workbooks should be revised into a new file using `source_path`.

The tools are available to tool-capable providers using Kit's native harness. Independently running Codex/Claude CLI agents have their own tool registries; they do not automatically acquire these native tools. The prompt explicitly avoids claiming unavailable capabilities.

Files written through ordinary edit tools keep their change/review evidence and also appear as readable spreadsheet documents in completion cards.

## Boundaries

- Supported import: `.xlsx` and version 1 `.sheet.json`. CSV/TSV remain text; legacy `.xls` and macro-enabled `.xlsm` keep their existing external/preview route.
- Up to 50 sheets, 10,000 rows and 256 columns per sheet, and 100,000 populated cells on import. Files are capped at 20 MB at the workspace boundary; individual pastes are limited to 10,000 cells.
- Common formulas and bounded cross-sheet references recalculate locally. Unsupported formulas and cycles surface as errors; formula errors block Excel export. This is not Excel calculation parity.
- Charts, pivot tables, macros, external workbook links, dynamic arrays, and full Excel layout fidelity are outside this version. Merged cells are read-only. Renaming a referenced sheet is refused rather than breaking its formulas.
- The workbook canvas stays paper-colored in both app themes so source cell colors remain readable.

## Implementation and verification

`src/spreadsheets/workbook.ts` owns import, schema validation, editing values, calculation and export. ExcelJS, fast-formula-parser and SSF load only with the spreadsheet surface. `scripts/check-bundle-split.mjs` prevents the spreadsheet vendor chunk from returning to the startup preload list.

`src-tauri/src/agent/spreadsheet_tools.rs` owns the native IronCalc adapter, schemas live in `agent/tools.rs`, and write review/checkpoints remain in the shared harness. Agent operations are capped at 10,000 cells, 50 sheets, 5 MB compressed / 20 MB expanded and 220 KB per request.

`src-tauri/src/spreadsheet.rs` owns workspace-rooted persistence, create-only exports, conflict checks and atomic replacement for native saves.

Run `npm test`, `npm run build`, and `cargo test --manifest-path src-tauri/Cargo.toml --lib spreadsheet`. The browser fixture at `/tests/fixtures/spreadsheet.html` uses the production component with in-memory IPC for interaction and visual QA; it is not part of the production entry.
