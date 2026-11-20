// Typed frontend adapter for the `connectors_*` command family — the MCP
// servers Klide connects *to*.
//
// The store itself lives in Rust (`connectors.rs` → ~/.klide/connectors.json),
// so this module is wire types and seven calls, with no cache of its own: every
// mutation answers with the whole store, and the page renders that answer.
//
// Not to be confused with `klide mcp coordination` (src-tauri/src/mcp_server.rs),
// which is the server Klide *serves* to a delegate CLI. Same protocol, opposite
// direction.

import { invoke } from "@tauri-apps/api/core";

/** A program Klide starts and talks to over stdin/stdout. */
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

/** A remote server reached over HTTP — GitHub's own is one. Header values may
 *  be `${VAR}` references Rust resolves at connect time; the GitHub preset's
 *  `Authorization` is `Bearer ${KLIDE_GITHUB_TOKEN}`, never a token. */
export type HttpServer = {
  url: string;
  headers: Record<string, string>;
};

/** How a connector is reached. Mirrors Rust's untagged `ServerSpec`: a `url`
 *  means remote, a `command` means a program. */
export type ServerSpec = StdioServer | HttpServer;

export function isRemote(server: ServerSpec): server is HttpServer {
  return "url" in server;
}

export type Connector = {
  id: string;
  label: string;
  server: ServerSpec;
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
  server: ServerSpec;
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
 *  and, the first time a connector runs, an `npx` download. Never on a timer.
 *  `workspace` scopes the project `.env` a `${VAR}` reference may read. */
export function probeConnector(server: ServerSpec, workspace: string | null): Promise<Probe> {
  return invoke<Probe>("connectors_probe", { server, workspace });
}

/** Add GitHub's own MCP server, signed in as the account Klide already uses.
 *  Rust checks it connects before saving, so a missing login is this call's
 *  error rather than a row that fails later. */
export function addGithubConnector(): Promise<Connector[]> {
  return invoke<Connector[]>("connectors_add_github");
}

/** Whether each connector is live in the shared pool the assistant calls
 *  through — `connected`, `connecting`, `error`, `idle` or `disabled`. */
export type ConnectorStatus = {
  id: string;
  state: "connected" | "connecting" | "error" | "idle" | "disabled";
  tools: number;
  error?: string;
};

export function connectorStatus(): Promise<ConnectorStatus[]> {
  return invoke<ConnectorStatus[]>("connectors_status");
}
