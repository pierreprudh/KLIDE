//! Native workbook tools. Calculation happens before review; applying the
//! proposal writes exactly the bytes that were validated. No frontend required.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use ironcalc::base::{
    cell::CellValue,
    expressions::utils::number_to_column,
    types::{CellType, Color},
    Model,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Cursor;

const MAX_BYTES: usize = 5_000_000;
const MAX_CELLS: usize = 10_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SheetInput {
    name: String,
    cells: BTreeMap<String, CellInput>,
    widths: Option<Vec<f64>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CellInput {
    value: Value,
    format: Option<String>,
    bold: Option<bool>,
    color: Option<String>,
    fill: Option<String>,
}
fn address(s: &str) -> Result<(i32, i32), String> {
    let split = s
        .find(|c: char| c.is_ascii_digit())
        .ok_or("Expected an A1 cell address")?;
    let (letters, digits) = s.split_at(split);
    if letters.is_empty()
        || letters.len() > 3
        || !letters.bytes().all(|b| b.is_ascii_uppercase())
        || digits.starts_with('0')
    {
        return Err(format!("Invalid cell address: {s}"));
    }
    let col = letters
        .bytes()
        .fold(0, |n, b| n * 26 + i32::from(b - b'A' + 1));
    let row = digits
        .parse::<i32>()
        .map_err(|_| format!("Invalid cell address: {s}"))?;
    if !(1..=10_000).contains(&row) || !(1..=256).contains(&col) {
        return Err("Supported grid: A1:IV10000".into());
    }
    Ok((row, col))
}
fn rgb(s: &str) -> Result<Color, String> {
    if s.len() != 6 || !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Colors must be six hex digits without #".into());
    }
    Ok(Color::Rgb(format!("#{s}")))
}
fn bytes(ws: &Workspace, path: &str) -> Result<Vec<u8>, String> {
    if !path.to_ascii_lowercase().ends_with(".xlsx") {
        return Err("Expected an .xlsx workbook".into());
    }
    let full = ws.resolve_existing(path)?;
    ws.guard(&full, Access::Agent)?;
    let mut data = Vec::new();
    std::fs::File::open(&full)
        .map_err(|e| e.to_string())?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > MAX_BYTES {
        return Err("Workbook exceeds the 5 MB agent limit".into());
    }
    Ok(data)
}
fn load(data: &[u8]) -> Result<Model<'static>, String> {
    // Refuse oversized ZIP expansion before the XML importer allocates it.
    let mut archive = zip::ZipArchive::new(Cursor::new(data)).map_err(|e| e.to_string())?;
    if archive.len() > 1000 {
        return Err("Workbook contains too many ZIP entries".into());
    }
    let mut expanded = 0u64;
    for i in 0..archive.len() {
        expanded = expanded.saturating_add(archive.by_index(i).map_err(|e| e.to_string())?.size());
        if expanded > 20_000_000 {
            return Err("Workbook expands beyond the 20 MB agent limit".into());
        }
    }
    let workbook = ironcalc::import::load_from_xlsx_bytes(data, "Workbook", "en", "UTC")
        .map_err(|e| e.to_string())?;
    let model = Model::from_workbook(workbook, "en")?;
    bounds(&model)?;
    Ok(model)
}
fn bounds(model: &Model) -> Result<(), String> {
    let cells = model.get_all_cells();
    if cells.len() > MAX_CELLS || model.workbook.worksheets.len() > 50 {
        return Err("Agent limit: 10,000 cells and 50 sheets".into());
    }
    for c in cells {
        if c.row > 10_000 || c.column > 256 {
            return Err("Supported grid: A1:IV10000".into());
        }
        if let Some(f) = model.get_cell_formula(c.index, c.row, c.column)? {
            if f.len() > 1024 {
                return Err("Formula exceeds the 1,024 character agent limit".into());
            }
        }
    }
    Ok(())
}
fn report(
    model: &Model,
    sheet: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    let mut cells = Vec::new();
    let mut errors = Vec::new();
    for c in model.get_all_cells() {
        let name = &model.workbook.worksheets[c.index as usize].name;
        let addr = format!(
            "{}{}",
            number_to_column(c.column).ok_or("Invalid column")?,
            c.row
        );
        let display = model.get_formatted_cell_value(c.index, c.row, c.column)?;
        if model.get_cell_type(c.index, c.row, c.column)? == CellType::ErrorValue {
            errors.push(json!({"sheet":name,"cell":addr,"error":display}));
        }
        if sheet.is_some_and(|s| s != name) {
            continue;
        }
        let value = match model.get_cell_value_by_index(c.index, c.row, c.column)? {
            CellValue::None => Value::Null,
            CellValue::Number(n) => json!(n),
            CellValue::String(s) => json!(s),
            CellValue::Boolean(b) => json!(b),
        };
        let style = model.get_style_for_cell(c.index, c.row, c.column)?;
        cells.push(json!({"sheet":name,"cell":addr,"value":value,"formula":model.get_cell_formula(c.index,c.row,c.column)?,"display":display,"format":style.num_fmt,"bold":style.font.b,"color":style.font.color,"fill":style.fill.color}));
    }
    let total = cells.len();
    let page: Vec<_> = cells.into_iter().skip(offset).take(limit).collect();
    Ok(
        json!({"sheets":model.workbook.worksheets.iter().map(|s| &s.name).collect::<Vec<_>>(),"columns":model.workbook.worksheets.iter().map(|s| json!({"sheet":s.name,"widths":s.cols.iter().map(|c| json!({"first":c.min,"last":c.max,"width":c.width})).collect::<Vec<_>>()})).collect::<Vec<_>>(),"totalCells":total,"offset":offset,"nextOffset":if offset+page.len()<total {Some(offset+page.len())} else {None},"cells":page,"errorCount":errors.len(),"errors":errors.into_iter().take(100).collect::<Vec<_>>()}),
    )
}
pub(super) fn inspect(ws: &Workspace, input: &Value, _: &str, _: Option<&Path>) -> ToolResult {
    let result = (|| -> Result<Value, String> {
        let path = trimmed_arg(input, "path").ok_or("inspect_spreadsheet requires path")?;
        let data = bytes(ws, &path)?;
        let mut model = load(&data)?;
        let sheet = input.get("sheet").and_then(Value::as_str);
        if sheet.is_some_and(|name| !model.workbook.worksheets.iter().any(|s| s.name == name)) {
            return Err("Sheet not found".into());
        }
        model.evaluate();
        let mut result = report(
            &model,
            sheet,
            input.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize,
            input
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .clamp(1, 500) as usize,
        )?;
        result["hash"] = json!(hash_content(&STANDARD.encode(&data)));
        result["path"] = json!(path);
        result["note"] = json!("Read-only recalculation. For complex imported Excel files, save revisions to a new path with source_path: charts, pivots and other advanced features may not survive export.");
        Ok(result)
    })();
    match result {
        Ok(value) => ok(value.to_string()),
        Err(e) => err(e),
    }
}
pub(super) fn preview(
    ws: &Workspace,
    input: &Value,
    run_id: &str,
) -> Result<DiffProposal, ToolResult> {
    prepare(ws, input, run_id).map_err(err)
}
fn prepare(ws: &Workspace, input: &Value, run_id: &str) -> Result<DiffProposal, String> {
    let path = trimmed_arg(input, "path").ok_or("write_spreadsheet requires path")?;
    if !path.to_ascii_lowercase().ends_with(".xlsx") {
        return Err("Output path must end in .xlsx".into());
    }
    if input.to_string().len() as u64 > AGENT_MAX_WRITE_BYTES {
        return Err("Spreadsheet request too large; write smaller batches".into());
    }
    let full = ws.resolve_new(&path)?;
    ws.guard(&full, Access::Agent)?;
    let old = if full.exists() {
        Some(bytes(ws, &path)?)
    } else {
        None
    };
    let old_base64 = old.as_ref().map(|b| STANDARD.encode(b));
    let expected = input.get("expected_hash").and_then(Value::as_str);
    match &old_base64 {
        Some(data) if expected != Some(hash_content(data).as_str()) => {
            return Err(
                "Inspect the existing workbook first and pass its current hash as expected_hash"
                    .into(),
            )
        }
        None if expected.is_some() => {
            return Err(
                "The workbook no longer exists; omit expected_hash only to create a new file"
                    .into(),
            )
        }
        _ => {}
    }
    let source = trimmed_arg(input, "source_path");
    if source.is_some() && old.is_some() {
        return Err("source_path requires a new output path".into());
    }
    let mut model = if let Some(data) = &old {
        load(data)?
    } else if let Some(source) = source {
        load(&bytes(ws, &source)?)?
    } else {
        Model::new_empty("Workbook", "en", "UTC", "en")?
    };
    let fresh = old.is_none() && input.get("source_path").is_none();
    let old_content = if old.is_some() {
        serde_json::to_string_pretty(&report(&model, None, 0, MAX_CELLS)?)
            .map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let sheets: Vec<SheetInput> =
        serde_json::from_value(input.get("sheets").cloned().ok_or("sheets is required")?)
            .map_err(|e| e.to_string())?;
    if sheets.is_empty() || sheets.len() > 50 {
        return Err("Provide 1–50 sheets".into());
    }
    let mut names = std::collections::HashSet::new();
    // Register every sheet before parsing formulas so forward sheet references
    // resolve just like references to sheets earlier in the request.
    for (index, sheet) in sheets.iter().enumerate() {
        if !names.insert(sheet.name.to_lowercase()) {
            return Err("Duplicate sheet name".into());
        }
        if fresh && index == 0 {
            model.rename_sheet_by_index(0, &sheet.name)?;
        }
        if !model
            .workbook
            .worksheets
            .iter()
            .any(|s| s.name == sheet.name)
        {
            model.add_sheet(&sheet.name)?;
        }
    }
    for sheet in &sheets {
        let idx = model
            .workbook
            .worksheets
            .iter()
            .position(|s| s.name == sheet.name)
            .ok_or("Sheet not found")? as u32;
        if let Some(widths) = &sheet.widths {
            if widths.len() > 256 {
                return Err("At most 256 column widths".into());
            }
            for (col, width) in widths.iter().enumerate() {
                if !(1.0..=100.0).contains(width) {
                    return Err("Column widths must be between 1 and 100 characters".into());
                }
                model.set_column_width(idx, col as i32 + 1, width * 9.0)?;
            }
        }
        for (addr, cell) in &sheet.cells {
            let (row, col) = address(addr)?;
            let user_input = match &cell.value {
                Value::Null => String::new(),
                Value::String(s) if s.starts_with('=') => s.clone(),
                Value::String(s) => format!("'{s}"),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
                _ => return Err("Cell value must be text, number, boolean, or null".into()),
            };
            if user_input.len() > 32_000 {
                return Err("Cell text too long".into());
            }
            model.set_user_input(idx, row, col, user_input)?;
            let mut style = model.get_style_for_cell(idx, row, col)?;
            if let Some(f) = &cell.format {
                if f.len() > 256 {
                    return Err("Number format too long".into());
                }
                style.num_fmt = f.clone();
            }
            if let Some(b) = cell.bold {
                style.font.b = b;
            }
            if let Some(c) = &cell.color {
                style.font.color = rgb(c)?;
            }
            if let Some(c) = &cell.fill {
                style.fill.color = rgb(c)?;
            }
            model.set_cell_style(idx, row, col, &style)?;
        }
    }
    bounds(&model)?;
    model.evaluate();
    let summary = report(&model, None, 0, MAX_CELLS)?;
    if summary["errorCount"].as_u64().unwrap_or(0) > 0 {
        return Err(format!(
            "Workbook not saved. Fix formula errors: {}",
            summary["errors"]
        ));
    }
    let output = ironcalc::export::save_xlsx_to_writer(&model, Cursor::new(Vec::new()))
        .map_err(|e| e.to_string())?
        .into_inner();
    if output.len() > MAX_BYTES {
        return Err("Export exceeds 5 MB agent limit".into());
    }
    let new_base64 = STANDARD.encode(&output);
    let new_content = serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?;
    Ok(DiffProposal {
        id: format!("spreadsheet_{run_id}"),
        run_id: run_id.into(),
        tool_call_id: String::new(),
        path: ws.display(&full),
        old_hash: hash_content(old_base64.as_deref().unwrap_or("")),
        new_hash: hash_content(&new_base64),
        unified_diff: unified_diff_lines(&old_content, &new_content),
        old_content,
        new_content,
        is_create: old.is_none(),
        reason: Some(format!(
            "{} sheets; {} cells. Recalculated with no formula errors. Excel output: {} bytes.",
            model.workbook.worksheets.len(),
            summary["totalCells"],
            output.len()
        )),
        binary: Some(super::super::types::BinaryWrite {
            old_base64,
            new_base64,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> (PathBuf, Workspace) {
        let p = std::env::temp_dir().join(format!(
            "klide-agent-sheet-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        let p = p.canonicalize().unwrap();
        let ws = Workspace::new(p.to_str().unwrap()).unwrap();
        (p, ws)
    }
    fn budget() -> Value {
        json!({"path":"out/budget.xlsx","sheets":[
            {"name":"Budget","widths":[24,18],"cells":{"A1":{"value":"Amount","bold":true,"fill":"E8EDF4"},"B2":{"value":1200,"format":"$#,##0.00"},"B3":{"value":"=B2*2"},"A4":{"value":"00123"},"A5":{"value":false},"C1":{"value":"=Summary!A1"}}},
            {"name":"Summary","cells":{"A1":{"value":"=Budget!B3+100"}}}
        ]})
    }
    #[test]
    fn agent_spreadsheet_create_inspect_update_and_rollback() {
        let (dir, ws) = workspace();
        let proposal = prepare(&ws, &budget(), "test").unwrap();
        assert!(
            !dir.join("out/budget.xlsx").exists(),
            "preview must not write"
        );
        apply_write(dir.to_str().unwrap(), &proposal).unwrap();
        let original = std::fs::read(dir.join("out/budget.xlsx")).unwrap();
        assert!(original.starts_with(b"PK"));
        // Verify the public XLSX representation, independent of re-import.
        let mut archive = zip::ZipArchive::new(Cursor::new(&original)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(
            xml.contains("width=\"24\""),
            "Column widths use Excel character units: {xml}"
        );
        assert!(
            xml.contains("<v>2400</v>"),
            "Calculated formula results must be cached: {xml}"
        );

        let result = inspect(&ws, &json!({"path":"out/budget.xlsx"}), "", None);
        assert!(result.ok, "{}", result.content);
        let report: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(report["errorCount"], 0);
        assert!(report["cells"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["sheet"] == "Summary" && c["value"].as_f64() == Some(2500.0)));
        assert!(report["cells"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["cell"] == "A4" && c["value"] == "00123"));
        let update = json!({"path":"out/budget.xlsx","expected_hash":report["hash"],"sheets":[{"name":"Budget","cells":{"B2":{"value":2000}}}]});
        let proposal = prepare(&ws, &update, "test").unwrap();
        apply_write(dir.to_str().unwrap(), &proposal).unwrap();
        let model = load(&std::fs::read(dir.join("out/budget.xlsx")).unwrap()).unwrap();
        assert_eq!(
            model.get_cell_value_by_index(1, 1, 1).unwrap(),
            CellValue::Number(4100.0)
        );
        assert_eq!(
            model.get_style_for_cell(0, 2, 2).unwrap().num_fmt,
            "$#,##0.00"
        );
        let runs = dir.join("runs");
        let file = super::super::super::checkpoint_file(&runs, "test", "edit");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file,serde_json::to_vec(&json!({"toolCallId":"edit","path":proposal.path,"oldContent":proposal.old_content,"newContent":proposal.new_content,"isCreate":false,"workspaceRoot":dir,"ts":0,"binary":proposal.binary})).unwrap()).unwrap();
        super::super::super::revert_checkpoint_at(&runs, "test", "edit").unwrap();
        assert_eq!(
            std::fs::read(dir.join("out/budget.xlsx")).unwrap(),
            original,
            "rollback restores exact bytes"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn agent_spreadsheet_refuses_errors_stale_writes_and_escapes() {
        let (dir, ws) = workspace();
        let mut bad = budget();
        bad["sheets"][0]["cells"]["B3"]["value"] = json!("=1/0");
        assert!(prepare(&ws, &bad, "test")
            .unwrap_err()
            .contains("formula errors"));
        bad["sheets"][0]["cells"]["B3"]["value"] = json!("=B3");
        assert!(prepare(&ws, &bad, "test").is_err());
        let mut escape = budget();
        escape["path"] = json!("../outside.xlsx");
        assert!(prepare(&ws, &escape, "test").is_err());
        escape["path"] = json!(".env.xlsx");
        assert!(prepare(&ws, &escape, "test").is_err());
        let p = prepare(&ws, &budget(), "test").unwrap();
        apply_write(dir.to_str().unwrap(), &p).unwrap();
        assert!(
            apply_write(dir.to_str().unwrap(), &p).is_err(),
            "create never clobbers"
        );
        assert!(
            prepare(&ws, &budget(), "test").is_err(),
            "update requires inspection hash"
        );
        let r = inspect(&ws, &json!({"path":"out/budget.xlsx"}), "", None);
        let r: Value = serde_json::from_str(&r.content).unwrap();
        let mut update = budget();
        update["expected_hash"] = r["hash"].clone();
        let p = prepare(&ws, &update, "test").unwrap();
        std::fs::write(dir.join("out/budget.xlsx"), b"external change").unwrap();
        assert!(
            apply_write(dir.to_str().unwrap(), &p).is_err(),
            "stale review must not overwrite"
        );
        assert_eq!(
            std::fs::read(dir.join("out/budget.xlsx")).unwrap(),
            b"external change"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn agent_spreadsheet_tools_obey_modes_and_register_executable_schemas() {
        assert_eq!(
            find_tool_kind_for_workspace("write_spreadsheet", None),
            Some(ToolKind::Write)
        );
        assert_eq!(
            find_tool_kind_for_workspace("inspect_spreadsheet", None),
            Some(ToolKind::ReadOnly)
        );
        assert!(!tool_allowed_in_mode(&AgentMode::Plan, ToolKind::Write));
        assert!(tool_allowed_in_mode(&AgentMode::Goal, ToolKind::Write));
        assert!(tool_allowed_in_mode(&AgentMode::Plan, ToolKind::ReadOnly));
        assert!(!tool_allowed_in_mode(&AgentMode::Chat, ToolKind::ReadOnly));
    }
}
