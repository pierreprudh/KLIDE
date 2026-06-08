import { readDir } from "@tauri-apps/plugin-fs";

const WALK_IGNORE = new Set([
  "node_modules", ".git", "target", "dist", "build", ".next", ".turbo",
  ".cache", "out", "coverage", ".venv", "__pycache__", ".idea",
]);

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const MAX = 4000;
  const out: string[] = [];
  async function walk(abs: string, rel: string, depth: number) {
    if (out.length >= MAX || depth > 8) return;
    let entries;
    try {
      entries = await readDir(abs);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!WALK_IGNORE.has(e.name)) await walk(`${abs}/${e.name}`, childRel, depth + 1);
      } else {
        out.push(childRel);
      }
    }
  }
  await walk(root, "", 0);
  return out.sort();
}