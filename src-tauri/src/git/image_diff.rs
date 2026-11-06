//! Image bytes must come from the same two versions as the text diff:
//! index → working tree, or HEAD → index. Never substitute working bytes
//! for a staged preview.
use super::git_output;
use base64::Engine;
use std::{
    io::Read,
    path::{Component, Path},
    process::Command,
};

#[derive(serde::Serialize)]
pub(super) struct ImageDiff {
    before: Option<ImageSide>,
    after: Option<ImageSide>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageSide {
    data_uri: Option<String>,
    error: Option<String>,
}

fn side(result: Result<Vec<u8>, String>, path: &str) -> ImageSide {
    match result {
        Ok(bytes) => ImageSide {
            data_uri: Some(format!(
                "data:{};base64,{}",
                crate::mime_for_path(path),
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )),
            error: None,
        },
        Err(error) => ImageSide {
            data_uri: None,
            error: Some(error),
        },
    }
}

fn size_ok(size: u64) -> Result<(), String> {
    if size > crate::workspace::USER_MAX_READ_BYTES {
        Err("Image is too large to preview (max 20 MB).".into())
    } else {
        Ok(())
    }
}

fn blob(root: &str, oid: &str) -> Result<Vec<u8>, String> {
    let size = git_output(root, &["cat-file", "-s", oid])?;
    size_ok(size.trim().parse().map_err(|_| "Invalid image size")?)?;
    let output = Command::new("git")
        .args(["-C", root, "cat-file", "blob", oid])
        .output()
        .map_err(|e| format!("Unable to read image: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    Ok(output.stdout)
}

fn snapshot(root: &str, path: &str, head: bool) -> Result<Option<ImageSide>, String> {
    let literal = format!(":(literal){path}");
    let listing = if head {
        // A new repository has no HEAD; its staged images are additions.
        let head = Command::new("git")
            .args(["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;
        if head.status.code() == Some(1) {
            return Ok(None);
        }
        if !head.status.success() {
            return Err(String::from_utf8_lossy(&head.stderr).trim().into());
        }
        git_output(root, &["ls-tree", "-z", "HEAD", "--", &literal])?
    } else {
        git_output(root, &["ls-files", "--stage", "-z", "--", &literal])?
    };
    for entry in listing.split('\0').filter(|e| !e.is_empty()) {
        let Some((header, entry_path)) = entry.split_once('\t') else {
            continue;
        };
        if entry_path != path {
            continue;
        }
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 3 {
            return Err("Invalid Git image entry".into());
        }
        if !head && fields[2] != "0" {
            return Ok(Some(side(
                Err("Resolve the merge conflict to preview this image.".into()),
                path,
            )));
        }
        if !fields[0].starts_with("100") {
            return Ok(Some(side(
                Err("Image preview requires a regular file.".into()),
                path,
            )));
        }
        let oid = if head { fields[2] } else { fields[1] };
        return Ok(Some(side(blob(root, oid), path)));
    }
    Ok(None)
}

pub(super) fn load(root: &str, path: &str, staged: bool) -> Result<ImageDiff, String> {
    if Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Image path must be relative to the workspace.".into());
    }
    let before = snapshot(root, path, staged)?;
    let after = if staged {
        snapshot(root, path, false)?
    } else {
        let ws = crate::workspace::Workspace::new(root)?;
        let full = Path::new(root).join(path);
        if !full.try_exists().map_err(|e| e.to_string())? {
            None
        } else {
            let bytes = (|| {
                let abs = ws.resolve_abs_read(&full.to_string_lossy())?;
                let file = std::fs::File::open(abs).map_err(|e| e.to_string())?;
                size_ok(file.metadata().map_err(|e| e.to_string())?.len())?;
                let mut bytes = Vec::new();
                file.take(crate::workspace::USER_MAX_READ_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                size_ok(bytes.len() as u64)?;
                Ok(bytes)
            })();
            Some(side(bytes, path))
        }
    };
    Ok(ImageDiff { before, after })
}
