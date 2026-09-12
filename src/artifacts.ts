import { invoke } from "@tauri-apps/api/core";
import { readWorkspaceFileDataUri, workspacePath } from "./workspaceFs";
import { isSpreadsheetPath } from "./spreadsheets/paths";

/** Where a document a run produced can be read.
 *
 * The frontend twin of `src-tauri/src/agent/artifacts.rs`: that module decides
 * what a command left behind, this one decides what Klide can do with it.
 *
 * Text goes to the Artifact Inspector. Workbooks have an interactive sheet
 * surface; other documents use the preview viewer and the system-app handoff.
 */

/** Extensions the inspector can show as text. Deliberately a list rather than
 *  a guess: a file with no extension, or one we have not thought about, is
 *  likelier to be a binary than a document, and opening a binary in Monaco is
 *  the failure mode this list exists to avoid. */
const READABLE = new Set([
  "md", "markdown", "mdx", "txt", "text", "log",
  "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "env",
  "html", "htm", "xml", "svg", "css", "scss",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "rb", "java", "kt",
  "sh", "bash", "zsh", "sql", "graphql", "diff", "patch",
]);

export type ArtifactTarget = "inspector" | "system" | "spreadsheet";

/** Where the row should send this file. */
export function artifactOpensIn(path: string): ArtifactTarget {
  if (isSpreadsheetPath(path)) return "spreadsheet";
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  // A dot at position 0 is a dotfile (`.env`), not an extension marker.
  if (dot <= 0) return "system";
  return READABLE.has(name.slice(dot + 1).toLowerCase()) ? "inspector" : "system";
}

/** The word for what the row's action will do, for its tooltip and its
 *  accessible name — "open" is vague when half of these leave the app. */
export function artifactActionLabel(path: string): string {
  const name = path.split("/").pop() || path;
  return artifactOpensIn(path) === "spreadsheet" ? `Open ${name} in spreadsheet` : artifactOpensIn(path) === "inspector" ? `Read ${name}` : `Open ${name} in its app`;
}

/** Images the webview draws itself; a deck, a PDF or a spreadsheet is drawn by
 *  macOS through Quick Look; text needs no picture, since the row opens it in
 *  the inspector where it can be read properly. */
export type ArtifactPreview = "image" | "quicklook" | "none";

const PICTURES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);

/** Text the inspector reads that is nonetheless worth a picture: a page a run
 *  wrote is judged by how it renders, not by its source, and Quick Look draws
 *  it in ~150 ms. */
const RENDERED_TEXT = new Set(["html", "htm"]);

export function artifactPreview(path: string): ArtifactPreview {
  if (/\.sheet\.json$/i.test(path)) return "none";
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "none";
  const extension = name.slice(dot + 1).toLowerCase();
  if (RENDERED_TEXT.has(extension)) return "quicklook";
  if (artifactOpensIn(path) === "inspector") return "none";
  return PICTURES.has(extension) ? "image" : "quicklook";
}

/** A picture of a document, at roughly `size` px on its long edge.
 *
 *  An image is already one and comes straight off disk; everything else is
 *  drawn by macOS Quick Look. Both go through `workspacePath` first: the Rust
 *  side canonicalizes the path it is handed and does *not* join the workspace
 *  root, so a relative path resolves against the app's own working directory
 *  and finds nothing. */
export function loadArtifactPreview(workspaceRoot: string, path: string, size = 900): Promise<string> {
  return artifactPreview(path) === "image"
    ? readWorkspaceFileDataUri(workspaceRoot, path)
    : invoke<string>("preview_file", {
      workspaceRoot,
      path: workspacePath(workspaceRoot, path),
      size,
    });
}

/** Hand the file to the application the machine opens it with. */
export function openArtifactInApp(workspaceRoot: string, path: string): Promise<void> {
  return invoke("open_entry", {
    workspaceRoot,
    path: workspacePath(workspaceRoot, path),
  });
}
