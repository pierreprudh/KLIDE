import { invoke } from "@tauri-apps/api/core";
import type { AgentMode } from "./types";

export type AgentToolCall = { id?: string; name: string; args: any; childRunId?: string };

// The Rust tool registry is the source of truth. The frontend fetches
// tool schemas over IPC so there is only one copy of each tool's name,
// description, and shape — no drift between TS and Rust schemas.

let cachedTools: Record<string, any[] | undefined> = {};
let cachedAllTools: any[] | undefined;
let cachedCatalogs: Partial<Record<AgentMode, ToolCatalogEntry[]>> = {};

/** One built-in Tool with the capability the Harness gates it by. Mirrors
 *  `ToolCatalogEntry` in src-tauri/src/agent/tools.rs. */
export type ToolCatalogEntry = { name: string; description: string; capability: string };

/** The built-in Tools a Run in `mode` may call. Read a Tool's trust effect
 *  from its `capability` here, never from a list of names. */
export async function toolCatalog(mode: AgentMode): Promise<ToolCatalogEntry[]> {
    const cached = cachedCatalogs[mode];
    if (cached) return cached;
    try {
        const catalog = await invoke<ToolCatalogEntry[]>("ai_tool_catalog", { mode });
        cachedCatalogs[mode] = catalog;
        return catalog;
    } catch {
        return [];
    }
}

/** The Tools a run in `mode` starts with turned off. Settings stores a toggle
 *  as `<mode>.<tool>`, which applies to that Mode only; a bare key applies to
 *  every Mode. Returns bare Tool names. */
export function disabledToolsFor(mode: AgentMode, overrides?: Record<string, boolean>): string[] {
    const disabled = new Set<string>();
    for (const [key, enabled] of Object.entries(overrides ?? {})) {
        if (enabled !== false) continue;
        const dot = key.indexOf(".");
        const prefix = dot < 0 ? "" : key.slice(0, dot);
        if (prefix === "chat" || prefix === "plan" || prefix === "goal") {
            if (prefix === mode) disabled.add(key.slice(dot + 1));
        } else {
            disabled.add(key);
        }
    }
    return [...disabled];
}

export async function toolsForMode(mode: AgentMode): Promise<any[] | undefined> {
    const key = mode;
    if (cachedTools[key]) return cachedTools[key];
    try {
        const tools = await invoke<any[]>("ai_list_tools", { mode });
        cachedTools[key] = tools.length > 0 ? tools : undefined;
        return cachedTools[key];
    } catch {
        return undefined;
    }
}

// The full set of tools a skill could ever allow — fetched from the
// Rust registry in "goal" mode (which returns every built-in tool,
// including the write tools). Used by the SkillsModal's "Tools & MCP"
// tab so the list stays in sync with the agent harness.
export async function listAllTools(): Promise<any[]> {
    if (cachedAllTools) return cachedAllTools;
    try {
        const tools = await invoke<any[]>("ai_list_tools", { mode: "goal" });
        cachedAllTools = tools;
        return tools;
    } catch {
        return [];
    }
}

export function clearToolCache() {
    cachedTools = {};
    cachedAllTools = undefined;
    cachedCatalogs = {};
}

export function parseToolCallsFromChunk(raw: any): AgentToolCall[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((tc): AgentToolCall | null => {
            const fn = tc.function ?? tc;
            const name = fn?.name;
            const id = typeof tc.id === "string" ? tc.id : undefined;
            let args = fn?.arguments;
            if (typeof args === "string") {
                try { args = JSON.parse(args); } catch { args = { _raw: args }; }
            }
            return name ? { id, name, args: args ?? {} } : null;
        })
        .filter((x): x is AgentToolCall => x !== null);
}
