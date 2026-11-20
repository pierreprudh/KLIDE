// The classic MCP servers, offered as cards on the Connectors page.
//
// A catalog entry is a connector Klide already knows how to write: the same
// `ServerSpec` a config file would hold, with every secret as a `${VAR}`
// reference Rust resolves at connect time (`connectors::resolve` — the
// process environment, then the project `.env`). Picking a card therefore
// never asks for a token unless the person wants to paste one; leaving the
// field empty keeps the reference.
//
// Hosted servers are signed in to through the browser (`connector_oauth.rs`),
// so most cards ask for nothing: click, approve, done. The token lands in the
// Keychain and the stored connector only says `${KLIDE_OAUTH}`.
//
// GitHub is not here as data: it has its own door (`connectors_add_github`)
// that signs in as the pinned account, and the page draws its card from that.

import type { Connector, ServerSpec } from "../../ipc/connectors";
import { isRemote } from "../../ipc/connectors";

export type CatalogSecret = {
  /** The environment variable the spec references, `LINEAR_API_KEY`. */
  name: string;
  /** What it is, in the service's own words: "Personal API key". */
  label: string;
};

export type CatalogEntry = {
  id: string;
  label: string;
  /** One line: what the assistant can reach through it. */
  blurb: string;
  /** Short letters for the tile when no brand mark matches — the way a file
   *  browser shows `PDF`. */
  monogram: string;
  server: ServerSpec;
  /** Variables the spec references. Empty means it connects as-is. */
  secrets: CatalogSecret[];
  /** Where a needed key comes from. */
  docs?: string;
  /** Signed in through the browser (OAuth) rather than with a key. */
  auth?: "oauth";
};

/** A signed-in server's header: the reference Rust swaps for the token the
 *  browser sign-in left in the Keychain (`connector_oauth.rs`). */
const OAUTH_HEADERS = { Authorization: "Bearer ${KLIDE_OAUTH}" };

/** Hosted servers you sign in to, then programs and keyless servers. Each
 *  signed-in row was checked to offer the sign-in Klide speaks (discovery +
 *  open registration); Asana, HubSpot, Box and Slack don't let a new app
 *  register, Figma and Vercel only allow approved ones, so they're left out. */
export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
  {
    id: "linear",
    label: "Linear",
    blurb: "Issues, projects and cycles",
    monogram: "LIN",
    server: { url: "https://mcp.linear.app/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "notion",
    label: "Notion",
    blurb: "Pages, databases and search",
    monogram: "NOT",
    server: { url: "https://mcp.notion.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "atlassian",
    label: "Atlassian",
    blurb: "Jira issues and Confluence pages",
    monogram: "ATL",
    server: { url: "https://mcp.atlassian.com/v1/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "sentry",
    label: "Sentry",
    blurb: "Issues, events and stack traces",
    monogram: "SEN",
    server: { url: "https://mcp.sentry.dev/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "supabase",
    label: "Supabase",
    blurb: "Projects, tables, SQL and logs",
    monogram: "SUP",
    server: { url: "https://mcp.supabase.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "stripe",
    label: "Stripe",
    blurb: "Customers, payments and docs",
    monogram: "STR",
    server: { url: "https://mcp.stripe.com", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "posthog",
    label: "PostHog",
    blurb: "Insights, flags and errors",
    monogram: "PH",
    server: { url: "https://mcp.posthog.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "hugging-face",
    label: "Hugging Face",
    blurb: "Models, datasets and Spaces",
    monogram: "HF",
    server: { url: "https://huggingface.co/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "canva",
    label: "Canva",
    blurb: "Designs, from search to export",
    monogram: "CAN",
    server: { url: "https://mcp.canva.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "monday",
    label: "monday.com",
    blurb: "Boards, items and updates",
    monogram: "MON",
    server: { url: "https://mcp.monday.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "intercom",
    label: "Intercom",
    blurb: "Conversations and contacts",
    monogram: "INT",
    server: { url: "https://mcp.intercom.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "granola",
    label: "Granola",
    blurb: "Meeting notes and transcripts",
    monogram: "GRA",
    server: { url: "https://mcp.granola.ai/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "airtable",
    label: "Airtable",
    blurb: "Bases, tables and records",
    monogram: "AIR",
    server: { url: "https://mcp.airtable.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "clickup",
    label: "ClickUp",
    blurb: "Tasks, docs and time",
    monogram: "CU",
    server: { url: "https://mcp.clickup.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "miro",
    label: "Miro",
    blurb: "Boards and their items",
    monogram: "MIR",
    server: { url: "https://mcp.miro.com/", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "dropbox",
    label: "Dropbox",
    blurb: "Files and folders",
    monogram: "DBX",
    server: { url: "https://mcp.dropbox.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "todoist",
    label: "Todoist",
    blurb: "Tasks and projects",
    monogram: "TD",
    server: { url: "https://ai.todoist.net/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "neon",
    label: "Neon",
    blurb: "Postgres projects, branches and SQL",
    monogram: "NEO",
    server: { url: "https://mcp.neon.tech/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "netlify",
    label: "Netlify",
    blurb: "Sites, deploys and env",
    monogram: "NET",
    server: { url: "https://mcp.netlify.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    blurb: "Workers, KV, R2 and D1",
    monogram: "CF",
    server: { url: "https://bindings.mcp.cloudflare.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "prisma",
    label: "Prisma",
    blurb: "Prisma Postgres databases",
    monogram: "PRI",
    server: { url: "https://mcp.prisma.io/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "webflow",
    label: "Webflow",
    blurb: "Sites, pages and CMS",
    monogram: "WF",
    server: { url: "https://mcp.webflow.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "wix",
    label: "Wix",
    blurb: "Sites, stores and bookings",
    monogram: "WIX",
    server: { url: "https://mcp.wix.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "zapier",
    label: "Zapier",
    blurb: "Actions across 8,000 apps",
    monogram: "ZAP",
    server: { url: "https://mcp.zapier.com/api/mcp/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "paypal",
    label: "PayPal",
    blurb: "Invoices, orders and disputes",
    monogram: "PP",
    server: { url: "https://mcp.paypal.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "square",
    label: "Square",
    blurb: "Payments, catalog and orders",
    monogram: "SQ",
    server: { url: "https://mcp.squareup.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "cloudinary",
    label: "Cloudinary",
    blurb: "Images and video assets",
    monogram: "CLD",
    server: { url: "https://mcp.cloudinary.com/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "jam",
    label: "Jam",
    blurb: "Bug reports with console and network",
    monogram: "JAM",
    server: { url: "https://mcp.jam.dev/mcp", headers: OAUTH_HEADERS },
    secrets: [],
    auth: "oauth",
  },
  {
    id: "figma",
    label: "Figma",
    blurb: "Selected frames, from the desktop app",
    monogram: "FIG",
    server: { url: "http://127.0.0.1:3845/mcp", headers: {} },
    secrets: [],
    docs: "https://help.figma.com/hc/en-us/articles/32132100833559",
  },
  {
    id: "context7",
    label: "Context7",
    blurb: "Current library docs",
    monogram: "C7",
    server: { url: "https://mcp.context7.com/mcp", headers: {} },
    secrets: [],
  },
  {
    id: "cloudflare-docs",
    label: "Cloudflare Docs",
    blurb: "Cloudflare's documentation",
    monogram: "CF",
    server: { url: "https://docs.mcp.cloudflare.com/mcp", headers: {} },
    secrets: [],
  },
  {
    id: "playwright",
    label: "Playwright",
    blurb: "Drive a real browser",
    monogram: "PW",
    server: { command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {}, cwd: null },
    secrets: [],
  },
  {
    id: "chrome-devtools",
    label: "Chrome DevTools",
    blurb: "Console, network and performance",
    monogram: "CDT",
    server: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], env: {}, cwd: null },
    secrets: [],
  },
  {
    id: "fetch",
    label: "Fetch",
    blurb: "Read a web page as Markdown",
    monogram: "GET",
    server: { command: "uvx", args: ["mcp-server-fetch"], env: {}, cwd: null },
    secrets: [],
  },
  {
    id: "sequential-thinking",
    label: "Sequential Thinking",
    blurb: "Step-by-step reasoning scratchpad",
    monogram: "SEQ",
    server: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      env: {},
      cwd: null,
    },
    secrets: [],
  },
];

/** `Remote` for a URL, `Local` for a program Klide starts — the one fact a
 *  card's top line carries. */
export function transportWord(server: ServerSpec): string {
  // A loopback URL is a desktop app's own server (Figma's), not the network.
  if (isRemote(server)) return /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(server.url) ? "Local" : "Remote";
  return "Local";
}

/** Whether the store already holds this entry: same id, or the same URL /
 *  program line under another name (an import of the same server). */
export function catalogMatch(entry: CatalogEntry, connectors: readonly Connector[]): Connector | null {
  const line = (s: ServerSpec) => (isRemote(s) ? s.url.replace(/\/$/, "") : [s.command, ...s.args].join(" "));
  const want = line(entry.server);
  return connectors.find((c) => c.id === entry.id || line(c.server) === want) ?? null;
}

/** The entry as a connector to save. A pasted value replaces its `${VAR}`
 *  reference; an empty one leaves the reference for Rust to resolve. */
export function catalogConnector(entry: CatalogEntry, values: Record<string, string>): Connector {
  const fill = (map: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(map).map(([key, raw]) => [
        key,
        raw.replace(/\$\{([A-Z0-9_]+)\}/g, (ref, name: string) => values[name]?.trim() || ref),
      ]),
    );
  const server: ServerSpec = isRemote(entry.server)
    ? { url: entry.server.url, headers: fill(entry.server.headers) }
    : { ...entry.server, args: [...entry.server.args], env: fill(entry.server.env) };
  return { id: entry.id, label: entry.label, server, enabled: true, origin: "catalog" };
}
