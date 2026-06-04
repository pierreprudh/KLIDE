import { exists, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { AgentToolCall as ToolCall } from "../../agent/tools";
import type { Msg, PendingEditRequest } from "./types";
import { CONTEXT_MODE_LABELS } from "../../contextTray";

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

export function toOllamaMessage(m: Msg): any {
  if (m.role === "assistant") {
    const out: any = { role: "assistant", content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    return { role: "tool", content: m.content, name: m.toolName, tool_call_id: m.toolCallId ?? m.toolName };
  }
  if (m.role === "user" && ((m.attachments && m.attachments.length > 0) || (m.projectContext && m.projectContext.items.length > 0))) {
    const parts: string[] = [];
    if (m.projectContext && m.projectContext.items.length > 0) {
      parts.push(
        `[Project context lens: ${CONTEXT_MODE_LABELS[m.projectContext.mode]}]\n${m.projectContext.items
          .map((item) => `${item.label.toUpperCase()}: ${item.path}\n${item.detail}`)
          .join("\n\n")}`
      );
    }
    if (m.attachments && m.attachments.length > 0) {
      const ctx = m.attachments
        .map((a) => `File: ${a.path}\n\`\`\`\n${a.content}\n\`\`\``)
        .join("\n\n");
      parts.push(`[Files the user attached for context — read more with read_file if needed:]\n${ctx}`);
    }
    return { role: "user", content: `${m.content}\n\n${parts.join("\n\n")}` };
  }
  return { role: m.role, content: m.content };
}

export async function executeTool(
  call: ToolCall,
  workspaceRoot: string | null,
  requestEdit: (req: Omit<PendingEditRequest, "resolve">) => Promise<string>,
  requireDiffReview: boolean,
  onFileWritten?: (path: string, newContent: string) => void
): Promise<string> {
  if (!workspaceRoot) {
    return "Error: no workspace folder is open. Ask the user to open one via the Files panel.";
  }
  const resolvePath = (p: string): string => {
    const raw = typeof p === "string" ? p.trim() : "";
    const rel = raw === "" || raw === "/" ? "." : raw.replace(/^\/+/, "");
    const root = workspaceRoot.replace(/\/+$/, "");
    const full = rel === "." ? root : `${root}/${rel}`;
    if (full !== root && !full.startsWith(`${root}/`)) {
      throw new Error(`Path "${p}" is outside the workspace`);
    }
    return full;
  };

  try {
    if (call.name === "read_file") {
      const p = String(call.args.path ?? "").trim().replace(/^\/+/, "") || ".";
      const content = await readTextFile(resolvePath(p));
      return `Contents of ${p} (${content.length} chars):\n\`\`\`\n${content}\n\`\`\``;
    }
    if (call.name === "list_dir") {
      const p = String(call.args.path ?? "").trim().replace(/^\/+/, "") || ".";
      const entries = await readDir(resolvePath(p));
      const formatted = entries.slice().sort((a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
      ).map((e) => `${e.isDirectory ? "[dir] " : "      "}${e.name}`).join("\n");
      return `Entries in ${p}:\n${formatted || "(empty)"}`;
    }
    if (call.name === "glob") {
      const pattern = String(call.args.pattern ?? "").trim();
      const base = String(call.args.path ?? ".").trim().replace(/^\/+/, "") || ".";
      if (!pattern) return "Error: glob requires a pattern.";
      const files = await listWorkspaceFiles(resolvePath(base));
      const normalizedBase = base === "." ? "" : `${base.replace(/\/+$/, "")}/`;
      const simplePattern = pattern.replace(/^\.\//, "").replace(/\*\*\//g, "");
      const wildcard = new RegExp(`^${simplePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
      const matches = files.map((p) => `${normalizedBase}${p}`)
        .filter((p) => wildcard.test(p) || wildcard.test(p.split("/").pop() ?? p))
        .slice(0, 200);
      return `Glob matches for ${pattern}:\n${matches.join("\n") || "(none)"}`;
    }
    if (call.name === "grep") {
      const pattern = String(call.args.pattern ?? "");
      const base = String(call.args.path ?? ".").trim().replace(/^\/+/, "") || ".";
      const max = Math.min(Number(call.args.maxResults ?? 200) || 200, 200);
      if (!pattern) return "Error: grep requires a pattern.";
      const files = await listWorkspaceFiles(resolvePath(base));
      const normalizedBase = base === "." ? "" : `${base.replace(/\/+$/, "")}/`;
      const rows: string[] = [];
      for (const rel of files) {
        if (rows.length >= max) break;
        const display = `${normalizedBase}${rel}`;
        try {
          const content = await readTextFile(resolvePath(display));
          content.split("\n").forEach((line, idx) => {
            if (rows.length < max && line.includes(pattern)) rows.push(`${display}:${idx + 1}: ${line}`);
          });
        } catch { /* skip */ }
      }
      return `Grep matches for ${pattern}:\n${rows.join("\n") || "(none)"}`;
    }
    if (call.name === "get_git_status") {
      const status = await invoke<{ branch: string; files: { path: string; status: string; staged: boolean }[] }>("git_status", { workspaceRoot });
      const files = status.files.map((f) => `${f.status.padEnd(2)} ${f.path}${f.staged ? " (staged)" : ""}`).join("\n");
      return `Git status:\n## ${status.branch}\n${files || "(clean)"}`;
    }
    if (call.name === "get_git_diff") {
      const path = String(call.args.path ?? "").trim();
      const staged = Boolean(call.args.staged);
      const diff = await invoke<{ path: string; diff: string; additions: number; deletions: number }>("git_diff", { workspaceRoot, path, staged });
      return `Git diff${staged ? " (staged)" : ""}${path ? ` for ${path}` : ""} (+${diff.additions}/-${diff.deletions}):\n${diff.diff || "(empty)"}`;
    }
    if (call.name === "write_file") {
      const { path, old_str, new_str } = call.args;
      if (typeof path !== "string" || typeof old_str !== "string" || typeof new_str !== "string") {
        return "Error: write_file requires string fields { path, old_str, new_str }.";
      }
      const full = resolvePath(path);
      const current = await readTextFile(full);
      const occurrences = current.split(old_str).length - 1;
      if (occurrences === 0) return `Error: old_str not found in ${path}. Read the file again and use an exact substring (whitespace matters).`;
      if (occurrences > 1) return `Error: old_str matches ${occurrences} locations in ${path}. Include more surrounding context so it matches exactly once.`;
      const newContent = current.replace(old_str, new_str);
      if (!requireDiffReview) {
        await writeTextFile(full, newContent);
        onFileWritten?.(path, newContent);
        return `Applied: edited ${path}.`;
      }
      return await requestEdit({ path, fullPath: full, oldContent: current, newContent, isCreate: false });
    }
    if (call.name === "create_file") {
      const { path, contents } = call.args;
      if (typeof path !== "string" || typeof contents !== "string") {
        return "Error: create_file requires string fields { path, contents }.";
      }
      const full = resolvePath(path);
      if (await exists(full)) return `Error: ${path} already exists. Use write_file to modify an existing file.`;
      if (!requireDiffReview) {
        await writeTextFile(full, contents);
        onFileWritten?.(path, contents);
        return `Applied: created ${path} (${contents.length} chars).`;
      }
      return await requestEdit({ path, fullPath: full, oldContent: "", newContent: contents, isCreate: true });
    }
    return `Error: unknown tool "${call.name}"`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Tool error from ${call.name}: ${msg}. Do not claim you cannot access files unless this says no workspace is open or the user denied access. Try a normalized relative path like "." or "README.md" if appropriate.`;
  }
}
