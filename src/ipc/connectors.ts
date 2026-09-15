// Typed frontend adapter for the `connectors_*` command family — the MCP
// servers Klide connects *to*.
//
// The store itself lives in Rust (`connectors.rs` → ~/.klide/connectors.json),
// so this module is wire types and five calls, with no cache of its own: every
// mutation answers with the whole store, and the page renders that answer.
//
// Not to be confused with `klide mcp coordination` (src-tauri/src/mcp_server.rs),
// which is the server Klide *serves* to a delegate CLI. Same protocol, opposite
// direction.

import { invoke } from "@tauri-apps/api/core";

/** How a connector is launched. Stdio only for now — a remote transport adds a
 *  variant here and in `mcp_client.rs` together. */
export type StdioServer = {
  /** Program name or path: `npx`, `uvx`, an absolute path. Never a shell line —
   *  Rust resolves it as a binary and passes `args` as argv. */
  command: string;
  args: string[];
  /** Extra environment for the child. Where a connector's token ends up, which
   *  is why the page shows the keys rather than hiding the block. */
  env: Record<string, string>;
  cwd?: string | null;
};

export type Connector = {
  id: string;
  label: string;
  server: StdioServer;
  enabled: boolean;
  /** `manual`, or the tool this was imported from (`claude-code`, `codex`,
   *  `opencode`, `workspace`). */
  origin: string;
};

/** A server found in another tool's config that Klide can offer to import. */
export type Discovered = {
  id: string;
  label: string;
  origin: string;
  sourcePath: string;
  server: StdioServer;
  alreadyAdded: boolean;
};

export type McpTool = {
  name: string;
  title?: string | null;
  description: string;
  /** `annotations.readOnlyHint`. Absent means the server didn't say — which a
   *  permission gate must read as "assume it writes". */
  readOnly?: boolean | null;
};

/** What one probe learned: the server's own identity plus its tools. */
export type Probe = {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  instructions?: string | null;
  tools: McpTool[];
  elapsedMs: number;
};

export function listConnectors(): Promise<Connector[]> {
  return invoke<Connector[]>("connectors_list");
}

/** Insert or replace by id; answers with the whole store. */
export function upsertConnector(connector: Connector): Promise<Connector[]> {
  return invoke<Connector[]>("connectors_upsert", { connector });
}

export function removeConnector(id: string): Promise<Connector[]> {
  return invoke<Connector[]>("connectors_remove", { id });
}

/** Read the MCP config the user already has. `workspace` scopes the
 *  project-local sources (`.mcp.json`, a Claude Code project block). */
export function discoverConnectors(workspace: string | null): Promise<Discovered[]> {
  return invoke<Discovered[]>("connectors_discover", { workspace });
}

/** Start the server, ask what it can do, stop it. One process spawn per call —
 *  and, the first time a connector runs, an `npx` download. Never on a timer. */
export function probeConnector(server: StdioServer): Promise<Probe> {
  return invoke<Probe>("connectors_probe", { server });
}
