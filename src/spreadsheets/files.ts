import { invoke } from "@tauri-apps/api/core";
import { readWorkspaceFileDataUri, workspacePath } from "../workspaceFs";

export function decodeBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}
export function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(text);
}
export async function readWorkbookFile(root: string, path: string) {
  const version = await workbookFileVersion(root, path);
  const uri = await readWorkspaceFileDataUri(root, path);
  const base64 = uri.slice(uri.indexOf(",") + 1);
  return { bytes: decodeBytes(base64), base64, version };
}
export function workbookFileVersion(root: string, path: string): Promise<string> {
  return invoke("spreadsheet_version", { workspaceRoot: root, path: workspacePath(root, path) });
}
/** null baseline means create-only, never overwrite an existing workbook. */
export async function saveWorkbookFile(root: string, path: string, bytes: Uint8Array, expected: string | null): Promise<string> {
  const content = encodeBytes(bytes);
  await invoke("save_spreadsheet", { workspaceRoot: root, path: workspacePath(root, path), content, expected });
  return content;
}
