import { listWorkspaceDir } from "../../workspaceFs";

const WALK_IGNORE = new Set([
  "node_modules", ".git", "target", "dist", "build", ".next", ".turbo",
  ".cache", "out", "coverage", ".venv", "__pycache__", ".idea",
]);

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const MAX = 4000;
  const out: string[] = [];
  async function walk(rel: string, depth: number) {
    if (out.length >= MAX || depth > 8) return;
    let entries;
    try {
      entries = await listWorkspaceDir(root, rel || root);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!WALK_IGNORE.has(e.name)) await walk(childRel, depth + 1);
      } else {
        out.push(childRel);
      }
    }
  }
  await walk("", 0);
  return out.sort();
}
