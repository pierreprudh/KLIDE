import { invoke } from "@tauri-apps/api/core";

export type WorkspaceEntry = {
  name: string;
  isDirectory: boolean;
};

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

export function workspacePath(workspaceRoot: string, path: string): string {
  if (isAbsolutePath(path)) return path;
  const sep = workspaceRoot.includes("\\") && !workspaceRoot.includes("/") ? "\\" : "/";
  return `${workspaceRoot.replace(/[\\/]+$/, "")}${sep}${path.replace(/^[\\/]+/, "")}`;
}

export function listWorkspaceDir(workspaceRoot: string, path: string): Promise<WorkspaceEntry[]> {
  return invoke<WorkspaceEntry[]>("list_dir", {
    workspaceRoot,
    path: workspacePath(workspaceRoot, path),
  });
}

export function readWorkspaceTextFile(workspaceRoot: string, path: string): Promise<string> {
  return invoke<string>("read_text_file", {
    workspaceRoot,
    path: workspacePath(workspaceRoot, path),
  });
}

export function writeWorkspaceTextFile(
  workspaceRoot: string,
  path: string,
  content: string,
): Promise<void> {
  return invoke<void>("write_text_file", {
    workspaceRoot,
    path: workspacePath(workspaceRoot, path),
    content,
  });
}

/** Read a file as a self-contained `data:<mime>;base64,…` URI — for binary
 *  files (images) the text reader would corrupt. */
export function readWorkspaceFileDataUri(workspaceRoot: string, path: string): Promise<string> {
  return invoke<string>("read_file_data_uri", {
    workspaceRoot,
    path: workspacePath(workspaceRoot, path),
  });
}

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "apng",
]);

/** Whether a path looks like an image we render as a picture rather than text. */
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function workspacePathExists(workspaceRoot: string, path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", {
    workspaceRoot,
    path: workspacePath(workspaceRoot, path),
  });
}
