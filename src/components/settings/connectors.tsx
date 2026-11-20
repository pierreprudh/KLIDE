// Connectors — the Settings surface for MCP servers Klide connects *to*.
//
// Four blocks, in the order a first visit needs them:
//
//   1. Your connectors     — what Klide has, and whether each one starts.
//   2. Popular servers     — the classic MCP servers as a grid of cards
//                            (`connectorCatalog.ts`); a card adds itself, or
//                            asks for the key it references first.
//   3. Available to import — the servers already configured in Claude Code,
//                            Codex and OpenCode, read from their own config.
//   4. Add a connector     — the escape hatch for a server no other tool knows:
//                            a command, or a URL for a remote server.
//
// GitHub's card is its own door: it adds GitHub's own remote server, signed in
// as the account Klide already uses (`connectors::github_preset`), so the most
// common connector needs no token and no config file at all.
//
// The import block is the point. Anyone who would use this page has already
// typed these commands into another tool's JSON; asking them to type them a
// third time would be the wrong product. Klide reads those files, never writes
// them (`connectors.rs`).
//
// The page's shape is borrowed from a reference sheet of AI-native primitives
// (beautifului.dev): a numbered section head with a one-line note, a dashed rule
// between sections, and one highlight that *glides* between rows rather than
// each row lighting up on its own. Everything inside it is Klide's — bone
// surfaces, sage, Atkinson, the hairline vocabulary — so the borrowing is
// structure, not skin.
//
// Within that: what you own is a contained ledger, what you could add is an
// airy list with no card at all. State is carried by type
// colour — a disabled row recedes, a failed check goes brick — and the verbs
// (Check, Remove, Import) stay hidden until a row is hovered or focused, so
// eight connectors read as eight names rather than twenty-four buttons. No
// badges, no status dots; the styles live under `.klide-connector-*` in
// tokens.css.
//
// What the assistant may do with them is said once, plainly, in the footnote:
// every remote tool needs approval on first use; server annotations are advisory
// (`agent/connector_tools.rs`).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  addGithubConnector,
  cancelConnectorSignIn,
  discoverConnectors,
  isRemote,
  listConnectors,
  probeConnector,
  removeConnector,
  signInConnector,
  signOutConnector,
  upsertConnector,
  usesSignIn,
  type Connector,
  type Discovered,
  type Probe,
  type ServerSpec,
} from "../../ipc/connectors";
import { openUrl } from "@tauri-apps/plugin-opener";
import { githubAccounts } from "../../ipc/git";
import { ConnectorMark, connectorBrand, connectorPicture, serverNames } from "../linkMark";
import {
  CONNECTOR_CATALOG,
  catalogConnector,
  catalogMatch,
  transportWord,
  type CatalogEntry,
} from "./connectorCatalog";
import { ProviderLogo } from "../ai/icons";
import { DELEGATES } from "../../delegates";
import type { ProviderId } from "../../agent/types";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { GhostButton, LinkButton, Panel, Toggle } from "./controls";

/** What the page knows about one connector's last check. Per-connector, and
 *  never persisted: a probe is a fact about right now, not about the store. */
type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; probe: Probe }
  | { state: "failed"; error: string };

/** Where a connector came from, in words rather than a badge. A Delegate's
 *  name comes from the one catalog; discovery only ever names a Delegate id. */
const ORIGIN_LABEL: Record<string, string> = {
  manual: "Added here",
  catalog: "Added from the list",
  preset: "As your GitHub account",
  ...Object.fromEntries(DELEGATES.map((d) => [d.id, `From ${d.label}`])),
  workspace: "From this project",
};

/** `npx -y linear-mcp`, or a remote server's URL — the same thing a config
 *  file would hold. Display only; the split that produced it happened when the
 *  connector was saved. */
function commandLine(server: ServerSpec): string {
  return isRemote(server) ? server.url : [server.command, ...server.args].join(" ");
}

/** `SkyComputerUseClient mcp` for `./Codex Computer Use.app/…/SkyComputerUseClient mcp`:
 *  a path's last segment is what tells two servers apart; the full line stays
 *  one hover away. A bare program (`npx -y linear-mcp`) is already short. */
function shortCommand(server: ServerSpec): string {
  if (isRemote(server)) return server.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const program = server.command.includes("/") ? server.command.split("/").pop() || server.command : server.command;
  return [program, ...server.args].join(" ");
}

/** `/Users/pierre/.codex/config.toml` → `~/.codex/config.toml`. */
function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

/** The tool a server was found in, as its own mark and name. */
const SOURCE: Record<string, { name: string; logo?: ProviderId }> = {
  ...Object.fromEntries(DELEGATES.map((d) => [d.id, { name: d.label, logo: d.id as ProviderId }])),
  workspace: { name: "This project" },
};

/** The names — never the values — of what a connector is handed: a program's
 *  environment, a remote server's headers. */
function configKeys(server: ServerSpec): string[] {
  return Object.keys(isRemote(server) ? server.headers : server.env);
}

/** The GitHub connector, however it arrived — the preset, or an import of
 *  GitHub's own server from another tool. It is the one row that earns a mark. */
function isGithub(connector: Connector): boolean {
  return connector.id === "github" || (isRemote(connector.server) && connector.server.url.includes("githubcopilot.com"));
}

const isUrl = (line: string) => /^https?:\/\//i.test(line.trim());

/** One command line → program + argv. Whitespace-separated, with quoted spans
 *  kept whole, so a path with a space survives. Not a shell: nothing expands,
 *  and the result is passed to Rust as argv. */
function splitCommand(line: string): { command: string; args: string[] } {
  const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const unquoted = parts.map((p) =>
    (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))
      ? p.slice(1, -1)
      : p
  );
  return { command: unquoted[0] ?? "", args: unquoted.slice(1) };
}

/** `KEY=value` per line → the child's environment. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

/** Where the list's single highlight currently sits. `opacity: 0` parks it —
 *  it keeps its last geometry so the next hover glides from there rather than
 *  sliding in from the top of the list. */
type Glide = { top: number; height: number; opacity: number };

/** One highlight per list, moved to whichever row the pointer or the keyboard
 *  is on. The row is measured against the list, so the list must be the
 *  positioning context (`.klide-glide-list`). */
function useGlide() {
  const [glide, setGlide] = useState<Glide>({ top: 0, height: 0, opacity: 0 });
  const onRow = useCallback((event: { currentTarget: HTMLElement }) => {
    const row = event.currentTarget;
    setGlide({ top: row.offsetTop, height: row.offsetHeight, opacity: 1 });
  }, []);
  const park = useCallback(() => setGlide((prev) => ({ ...prev, opacity: 0 })), []);
  return {
    glide,
    /** Spread onto the list. */
    listProps: { className: "klide-glide-list", onMouseLeave: park },
    /** Spread onto each row. Focus counts, so tabbing lights rows too. */
    rowProps: { onMouseEnter: onRow, onFocus: onRow },
  };
}

function GlideHighlight({ glide }: { glide: Glide }) {
  return <span aria-hidden className="klide-glide" style={glide} />;
}

/** `01  Your connectors   2 of 3 on · 14 tools seen        Check all` — the
 *  numbered head, in place of a plain settings heading. */
function Head({
  index,
  title,
  note,
  action,
}: {
  index: string;
  title: string;
  note: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="klide-primitive-head">
      <span className="klide-primitive-index">{index}</span>
      <h3 className="klide-primitive-title">{title}</h3>
      <p className="klide-primitive-note">{note}</p>
      {action}
    </div>
  );
}

export function ConnectorsSection({ workspaceRoot }: { workspaceRoot: string | null }) {
  const ledger = useGlide();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [found, setFound] = useState<Discovered[]>([]);
  const [scanning, setScanning] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The catalog card whose keys are being filled in, if any. */
  const [setup, setSetup] = useState<CatalogEntry | null>(null);
  /** The connector waiting on a browser sign-in. One at a time: Rust keeps a
   *  single loopback listener, and a new sign-in abandons the last. */
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [connectingGithub, setConnectingGithub] = useState(false);
  /** Who "Connect GitHub" will sign in as — the pinned account, else gh's
   *  active one. `undefined` while loading, `null` when gh has no login. */
  const [githubLogin, setGithubLogin] = useState<string | null | undefined>(undefined);
  /** A check in flight owns its row; a second click is ignored rather than
   *  spawning the same server twice. */
  const inFlight = useRef(new Set<string>());

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      setFound(await discoverConnectors(workspaceRoot));
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    } finally {
      setScanning(false);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    githubAccounts()
      .then((accounts) => setGithubLogin(accounts.pinned ?? accounts.active ?? null))
      .catch(() => setGithubLogin(null));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setConnectors(await listConnectors());
      } catch (e) {
        notify(errMessage(e), { tone: "error" });
      }
      await rescan();
    })();
  }, [rescan]);

  /** A probe is a process spawn — only ever on an explicit click. */
  const check = useCallback(async (connector: Connector) => {
    if (inFlight.current.has(connector.id)) return;
    inFlight.current.add(connector.id);
    setChecks((prev) => ({ ...prev, [connector.id]: { state: "checking" } }));
    try {
      const probe = await probeConnector(connector.server, workspaceRoot);
      setChecks((prev) => ({ ...prev, [connector.id]: { state: "ok", probe } }));
    } catch (e) {
      setChecks((prev) => ({
        ...prev,
        [connector.id]: { state: "failed", error: errMessage(e) },
      }));
    } finally {
      inFlight.current.delete(connector.id);
    }
  }, [workspaceRoot]);

  /** One at a time: each check may be an `npx` that downloads a package, and
   *  five of those at once is a stalled machine, not a faster page. */
  async function checkAll() {
    for (const connector of connectors) {
      if (connector.enabled) await check(connector);
    }
  }

  async function save(connector: Connector): Promise<boolean> {
    try {
      setConnectors(await upsertConnector(connector));
      return true;
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
      return false;
    }
  }

  /** A card picked on purpose is enabled and checked at once — the check is
   *  the answer to "did that work?", and it is still one explicit click. */
  async function addFromCatalog(entry: CatalogEntry, values: Record<string, string>) {
    const connector = catalogConnector(entry, values);
    if (!(await save(connector))) return;
    setSetup(null);
    setOpen(connector.id);
    void check(connector);
  }

  async function drop(connector: Connector) {
    try {
      setConnectors(await removeConnector(connector.id));
      // The offer comes back in the import list, so removing is reversible
      // without retyping anything.
      await rescan();
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    }
  }

  /** Rust connects before it saves, so the one failure worth explaining — no
   *  GitHub login — lands here, on the button, with the fix in its words. */
  async function connectGithub() {
    setConnectingGithub(true);
    try {
      setConnectors(await addGithubConnector());
      notify("GitHub connected", { tone: "success" });
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    } finally {
      setConnectingGithub(false);
    }
  }

  /** Browser sign-in, then save. Rust probes before it saves, so success here
   *  means the server answered as the signed-in account. */
  async function signIn(connector: Connector) {
    setSigningIn(connector.id);
    try {
      setConnectors(await signInConnector(connector));
      notify(`${connector.label} connected`, { tone: "success" });
      setChecks((prev) => ({ ...prev, [connector.id]: { state: "idle" } }));
    } catch (e) {
      const message = errMessage(e);
      if (message !== "Sign-in cancelled") notify(message, { tone: "error" });
    } finally {
      setSigningIn((prev) => (prev === connector.id ? null : prev));
    }
  }

  async function signOut(connector: Connector) {
    try {
      setConnectors(await signOutConnector(connector.id));
      setChecks((prev) => ({ ...prev, [connector.id]: { state: "idle" } }));
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    }
  }

  async function importOne(candidate: Discovered) {
    await save({
      id: candidate.id,
      label: candidate.label,
      server: candidate.server,
      // Import is inspection, not permission to spawn a discovered command.
      enabled: false,
      origin: candidate.origin,
    });
    await rescan();
  }

  const importable = useMemo(() => found.filter((f) => !f.alreadyAdded), [found]);
  const busy = connectors.some((c) => checks[c.id]?.state === "checking");

  // "2 of 3 on · 14 tools seen" — the facts worth knowing before reading rows.
  const summary = useMemo(() => {
    if (connectors.length === 0) return null;
    const on = connectors.filter((c) => c.enabled).length;
    const tools = connectors.reduce((sum, c) => {
      const check = checks[c.id];
      return sum + (check?.state === "ok" ? check.probe.tools.length : 0);
    }, 0);
    const parts = [`${on} of ${connectors.length} on`];
    if (tools > 0) parts.push(`${tools} tools seen`);
    return parts.join(" · ");
  }, [connectors, checks]);

  return (
    <>
      <section className="klide-primitive-section">
        <Head
          index="01"
          title="Your connectors"
          note={summary ?? "The services the assistant can reach."}
          action={
            connectors.length > 0 ? (
              <Verb onClick={() => void checkAll()} disabled={busy}>
                {busy ? "Checking…" : "Check all"}
              </Verb>
            ) : null
          }
        />
        <Panel>
          <div {...ledger.listProps} data-bleed>
            <GlideHighlight glide={ledger.glide} />
            {connectors.length === 0 && (
              <Empty>Nothing connected yet. Pick a service below, or import one you already use.</Empty>
            )}
            {connectors.map((connector, i) => (
                <ConnectorRow
                  key={connector.id}
                  connector={connector}
                  index={i}
                  check={checks[connector.id] ?? { state: "idle" }}
                  open={open === connector.id}
                  onToggleOpen={() =>
                    setOpen((prev) => (prev === connector.id ? null : connector.id))
                  }
                  onCheck={() => {
                    setOpen(connector.id);
                    void check(connector);
                  }}
                  onEnabledChange={(enabled) => void save({ ...connector, enabled })}
                  onRemove={() => void drop(connector)}
                  signIn={
                    usesSignIn(connector.server)
                      ? {
                          busy: signingIn === connector.id,
                          onSignIn: () => void signIn(connector),
                          onSignOut: () => void signOut(connector),
                        }
                      : undefined
                  }
                  rowProps={ledger.rowProps}
                />
            ))}
          </div>
        </Panel>
        <FootNote>
          In Plan and Goal, the assistant can use every enabled connector. Tools
          need approval on first use, even when a server marks them read-only.
          You can approve a tool for the Run or Workspace. Imported connectors
          stay off until you enable them. Klide's
          own <InlineCode>klide mcp coordination</InlineCode> server is the opposite
          direction: what delegate CLIs use to reach back into Klide.
        </FootNote>
      </section>

      <section className="klide-primitive-section">
        <Head
          index="02"
          title="Popular servers"
          note="Sign in once; the token stays in your Keychain."
          action={
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter"
              aria-label="Filter servers"
              spellCheck={false}
              className="klide-field klide-connector-filter"
            />
          }
        />
        <div className="klide-connector-grid">
          {matchesFilter({ label: "GitHub", blurb: "Repositories, issues and pull requests" }, filter) && <GithubCard
            added={connectors.find(isGithub) ?? null}
            login={githubLogin}
            connecting={connectingGithub}
            onConnect={() => void connectGithub()}
            onEnabledChange={(c, enabled) => void save({ ...c, enabled })}
          />}
          {CONNECTOR_CATALOG.filter((entry) => matchesFilter(entry, filter)).map((entry, i) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              index={i + 1}
              added={catalogMatch(entry, connectors)}
              selected={setup?.id === entry.id}
              signingIn={signingIn === entry.id}
              onPick={() => {
                if (signingIn === entry.id) void cancelConnectorSignIn();
                else if (entry.auth === "oauth") void signIn(catalogConnector(entry, {}));
                else if (entry.secrets.length === 0) void addFromCatalog(entry, {});
                else setSetup((prev) => (prev?.id === entry.id ? null : entry));
              }}
              onEnabledChange={(c, enabled) => void save({ ...c, enabled })}
            />
          ))}
        </div>
        {setup && (
          <CatalogSetup
            key={setup.id}
            entry={setup}
            onCancel={() => setSetup(null)}
            onAdd={(values) => void addFromCatalog(setup, values)}
          />
        )}
      </section>

      <section className="klide-primitive-section">
        <Head
          index="03"
          title="Available to import"
          note="Read from your other tools' own config. Klide never edits them."
          action={
            <Verb onClick={() => void rescan()} disabled={scanning}>
              {scanning ? "Scanning…" : "Rescan"}
            </Verb>
          }
        />
        {importable.length === 0 ? (
          <Empty flush>
            {scanning
              ? "Looking…"
              : found.length > 0
                ? "Everything found is already added."
                : "No MCP servers found in Claude Code, Codex or OpenCode."}
          </Empty>
        ) : (
          <div className="klide-connector-grid">
            {importable.map((candidate, i) => (
              <ImportCard
                key={`${candidate.origin}:${candidate.id}`}
                candidate={candidate}
                index={i}
                onImport={() => void importOne(candidate)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="klide-primitive-section">
        <Head
          index="04"
          title="Add a connector"
          note="A command Klide starts, or a remote server's URL."
          action={
            !adding ? <Verb onClick={() => setAdding(true)}>Add manually</Verb> : null
          }
        />
        {adding ? (
          <AddForm
            onCancel={() => setAdding(false)}
            onAdd={(connector) => {
              void save(connector);
              setAdding(false);
            }}
          />
        ) : null}
      </section>
    </>
  );
}

function ConnectorRow({
  connector,
  index,
  check,
  open,
  onToggleOpen,
  onCheck,
  onEnabledChange,
  onRemove,
  signIn,
  rowProps,
}: {
  connector: Connector;
  index: number;
  check: Check;
  open: boolean;
  onToggleOpen: () => void;
  onCheck: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onRemove: () => void;
  /** For a connector signed in through the browser. */
  signIn?: { busy: boolean; onSignIn: () => void; onSignOut: () => void };
  /** Hover/focus handlers from the list's glide. */
  rowProps: { onMouseEnter: (e: { currentTarget: HTMLElement }) => void; onFocus: (e: { currentTarget: HTMLElement }) => void };
}) {
  const env = configKeys(connector.server);
  const scope = isGithub(connector) ? githubScope(connector.server) : null;
  return (
    <div>
      <div
        className="klide-connector-row"
        data-off={!connector.enabled}
        data-open={open}
        // A short stagger on first paint, capped so a long list doesn't crawl.
        style={{ animationDelay: `${Math.min(index, 8) * 22}ms` }}
        {...rowProps}
      >
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          style={{
            minWidth: 0,
            textAlign: "left",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <RowTitle connector={connector}>{connector.label}</RowTitle>
          <div className="klide-connector-command">{commandLine(connector.server)}</div>
          <div className="klide-connector-meta">
            <span>{ORIGIN_LABEL[connector.origin] ?? connector.origin}</span>
            {scope ? (
              <span style={{ opacity: 0.75 }}>{scope}</span>
            ) : signIn ? (
              <span style={{ opacity: 0.75 }}>Signed in through your browser</span>
            ) : (
              env.length > 0 && <span style={{ opacity: 0.75 }}>{env.join(" · ")}</span>
            )}
          </div>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Status check={check} />
          <div className="klide-connector-verbs">
            <Verb onClick={onCheck} disabled={check.state === "checking"}>
              Check
            </Verb>
            {signIn && (
              <>
                <Verb onClick={signIn.onSignIn} disabled={signIn.busy}>
                  {signIn.busy ? "Waiting for browser…" : "Sign in again"}
                </Verb>
                <Verb onClick={signIn.onSignOut}>Sign out</Verb>
              </>
            )}
            <Verb onClick={onRemove} danger>
              Remove
            </Verb>
          </div>
          <Toggle
            checked={connector.enabled}
            onChange={onEnabledChange}
            label={`Use ${connector.label}`}
          />
        </div>
      </div>
      {open && check.state !== "idle" && (
        <div className="klide-connector-detail">
          <CheckDetail check={check} />
        </div>
      )}
    </div>
  );
}

/** A row's title, with the GitHub mark in front of it when it earns one. The
 *  mark sits inside the title's line, so every row's text below still starts at
 *  the same x — a marked row is never indented past its neighbours. */
/** A connector's name behind its logo — the brand its names point at, or the
 *  plug when none does. */
function RowTitle({ connector, children }: { connector: { id: string; label: string; server?: ServerSpec }; children: ReactNode }) {
  return (
    <div className="klide-row-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="klide-connector-mark">
        <ConnectorMark connector={connector.id} label={connector.label} server={connector.server} size={14} tone="brand" />
      </span>
      {children}
    </div>
  );
}

/** `repos · issues · pull requests · actions` — what a GitHub connector was
 *  scoped to, which says more on its row than the names of its headers. */
function githubScope(server: ServerSpec): string | null {
  if (!isRemote(server)) return null;
  const toolsets = Object.entries(server.headers).find(([k]) => k.toLowerCase() === "x-mcp-toolsets")?.[1];
  return toolsets ? toolsets.split(",").map((s) => s.trim().replace(/_/g, " ")).join(" · ") : null;
}

/* ---------------------------------------------------------- catalog cards --*/

/** Name or blurb contains every word typed, in any order. */
function matchesFilter(entry: { label: string; blurb: string }, filter: string): boolean {
  const haystack = `${entry.label} ${entry.blurb}`.toLowerCase();
  return filter.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/** The square a card's logo sits in: the brand's own mark when one of the
 *  server's names says which, else short letters — the way a file browser
 *  shows `PDF` for a file it has no picture of. */
function CardTile({ id, label, server, monogram }: { id: string; label: string; server?: ServerSpec; monogram: string }) {
  const names = serverNames(server);
  const brand = connectorBrand(id, label, names) ?? connectorPicture(id, label, names);
  return (
    <span className="klide-connector-tile" aria-hidden>
      {brand ? (
        <span className="klide-connector-mark">
          <ConnectorMark connector={id} label={label} server={server} size={30} tone="brand" />
        </span>
      ) : (
        <span className="klide-connector-monogram">{monogram}</span>
      )}
    </span>
  );
}

/** One card's frame. Not yet added, the whole card is the button that adds
 *  it; added, it is a plain surface whose switch is the only control — a
 *  button may not hold another button. */
function CardShell({
  added,
  selected,
  index,
  label,
  onPick,
  disabled,
  action = "Add",
  children,
}: {
  added: Connector | null;
  selected?: boolean;
  index: number;
  label: string;
  /** What a click does, for assistive tech: `Add Linear`, `Import pencil`. */
  action?: string;
  onPick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const common = {
    className: "klide-connector-card",
    "data-added": added ? "true" : undefined,
    "data-off": added && !added.enabled ? "true" : undefined,
    "data-selected": selected ? "true" : undefined,
    style: { animationDelay: `${Math.min(index, 12) * 18}ms` },
  };
  if (added) return <div {...common}>{children}</div>;
  return (
    <button
      type="button"
      {...common}
      onClick={onPick}
      disabled={disabled}
      aria-label={`${action} ${label}`}
      aria-expanded={selected}
    >
      {children}
    </button>
  );
}

/** `Remote                    ◯━` — what kind of server, and either its
 *  switch (added) or the verb a click performs (not yet). */
function CardTop({
  word,
  added,
  verb,
  onEnabledChange,
}: {
  word: ReactNode;
  added: Connector | null;
  verb: string;
  onEnabledChange: (connector: Connector, enabled: boolean) => void;
}) {
  return (
    <span className="klide-connector-card-top">
      <span>{word}</span>
      {added ? (
        <Toggle
          checked={added.enabled}
          onChange={(enabled) => onEnabledChange(added, enabled)}
          label={`Use ${added.label}`}
        />
      ) : (
        <span className="klide-connector-card-verb">{verb}</span>
      )}
    </span>
  );
}

function CatalogCard({
  entry,
  index,
  added,
  selected,
  signingIn,
  onPick,
  onEnabledChange,
}: {
  entry: CatalogEntry;
  index: number;
  added: Connector | null;
  selected: boolean;
  signingIn: boolean;
  onPick: () => void;
  onEnabledChange: (connector: Connector, enabled: boolean) => void;
}) {
  return (
    <CardShell added={added} selected={selected || signingIn} index={index} label={entry.label} onPick={onPick}>
      <CardTop
        // "Sign in" is what a card still asks for; once the connector is
        // added it has been answered, so the card says where it runs instead.
        word={entry.auth === "oauth" && !added ? "Sign in" : transportWord(entry.server)}
        added={added}
        verb={signingIn ? "Cancel" : entry.auth === "oauth" ? "Connect" : entry.secrets.length > 0 ? "Set up" : "Add"}
        onEnabledChange={onEnabledChange}
      />
      <CardTile id={entry.id} label={entry.label} server={entry.server} monogram={entry.monogram} />
      <span className="klide-connector-card-title">{entry.label}</span>
      <span className="klide-connector-card-blurb" title={entry.blurb}>
        {signingIn ? "Finish signing in in your browser" : entry.blurb}
      </span>
    </CardShell>
  );
}

/** A server found in another tool's config, as a card: that tool's mark and
 *  name on top, the server's own logo, its name, and the command or URL that
 *  starts it. A click imports it — switched off, as every import is. */
function ImportCard({
  candidate,
  index,
  onImport,
}: {
  candidate: Discovered;
  index: number;
  onImport: () => void;
}) {
  const source = SOURCE[candidate.origin];
  return (
    <CardShell added={null} index={index} label={candidate.label} action="Import" onPick={onImport}>
      <CardTop
        word={
          <span className="klide-connector-card-source" title={tildify(candidate.sourcePath)}>
            {source?.logo && <ProviderLogo id={source.logo} size={11} />}
            {source?.name ?? candidate.origin}
          </span>
        }
        added={null}
        verb="Import"
        onEnabledChange={() => {}}
      />
      <CardTile
        id={candidate.id}
        label={candidate.label}
        server={candidate.server}
        monogram={monogramOf(candidate.label)}
      />
      <span className="klide-connector-card-title" title={candidate.label}>{candidate.label}</span>
      <span className="klide-connector-card-blurb klide-connector-card-command" title={commandLine(candidate.server)}>
        {shortCommand(candidate.server)}
      </span>
    </CardShell>
  );
}

/** `obsidian-mcp-tools` → `OMT`; `pencil` → `PEN`. */
function monogramOf(label: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "?");
  return letters.slice(0, 3).toUpperCase();
}

/** GitHub's card: its own door, signed in as the account Klide already uses,
 *  so it never asks for a token. */
function GithubCard({
  added,
  login,
  connecting,
  onConnect,
  onEnabledChange,
}: {
  added: Connector | null;
  login: string | null | undefined;
  connecting: boolean;
  onConnect: () => void;
  onEnabledChange: (connector: Connector, enabled: boolean) => void;
}) {
  const blurb = added
    ? "Repositories, issues and pull requests"
    : login === undefined ? "Signs in as your GitHub account"
      : login === null ? "Run gh auth login first"
        : `Signs in as ${login}`;
  return (
    <CardShell added={added} index={0} label="GitHub" onPick={onConnect} disabled={connecting || login === null}>
      <CardTop
        word={added ? "Remote" : "Sign in"}
        added={added}
        verb={connecting ? "Connecting…" : "Connect"}
        onEnabledChange={onEnabledChange}
      />
      <CardTile id="github" label="GitHub" monogram="GH" />
      <span className="klide-connector-card-title">GitHub</span>
      <span className="klide-connector-card-blurb" title={blurb}>{blurb}</span>
    </CardShell>
  );
}

/** The keys a picked card references, asked for under the grid. Empty keeps
 *  the `${VAR}` reference — resolved from the environment or the project's
 *  `.env` at connect time — so pasting is a choice, not a requirement. */
function CatalogSetup({
  entry,
  onAdd,
  onCancel,
}: {
  entry: CatalogEntry;
  onAdd: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <div className="klide-connector-setup">
      <Panel>
        <div style={{ padding: "20px 0", display: "grid", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <CardTile id={entry.id} label={entry.label} server={entry.server} monogram={entry.monogram} />
            <div style={{ minWidth: 0 }}>
              <div className="klide-row-title">{entry.label}</div>
              <div className="klide-connector-command" title={commandLine(entry.server)}>
                {shortCommand(entry.server)}
              </div>
            </div>
          </div>
          {entry.secrets.map((secret) => (
            <Field key={secret.name} label={secret.label} hint={`leave empty to read \${${secret.name}} from your environment or .env`}>
              <Input
                value={values[secret.name] ?? ""}
                onChange={(v) => setValues((prev) => ({ ...prev, [secret.name]: v }))}
                placeholder={`\${${secret.name}}`}
                mono
                autoFocus
                secret
              />
            </Field>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
            {entry.docs && (
              <Verb onClick={() => void openUrl(entry.docs!)}>Where to find it</Verb>
            )}
            <span style={{ flex: 1 }} />
            <GhostButton onClick={onCancel}>Cancel</GhostButton>
            <LinkButton onClick={() => onAdd(values)}>Add {entry.label}</LinkButton>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** The one line that says how the last check went. A word in the right colour
 *  rather than a badge: sage only for a real success, brick for a failure,
 *  muted for everything else. */
function Status({ check }: { check: Check }) {
  if (check.state === "checking") return <Note>Checking…</Note>;
  if (check.state === "failed") return <Note tone="var(--danger)">Didn't start</Note>;
  if (check.state === "ok") {
    const n = check.probe.tools.length;
    return (
      <Note tone={n > 0 ? "var(--success)" : undefined}>
        {n} {n === 1 ? "tool" : "tools"}
      </Note>
    );
  }
  return null;
}

/** What the last check found: the server's own identity and its tools, or the
 *  reason it didn't start. The failure text is the server's own — a missing
 *  key, a 404 from npm — because that is what tells you how to fix it. */
function CheckDetail({ check }: { check: Check }) {
  if (check.state === "checking") {
    return <Quiet>Starting the server and asking what it can do…</Quiet>;
  }
  if (check.state === "failed") {
    return (
      <div className="klide-paper" style={{ padding: "13px 15px" }}>
        <div style={{ fontSize: 12.5, color: "var(--danger)", lineHeight: 1.55 }}>
          {check.error}
        </div>
      </div>
    );
  }
  if (check.state !== "ok") return null;
  const { probe } = check;
  return (
    <div className="klide-paper" style={{ padding: "14px 16px", display: "grid", gap: 12 }}>
      <div className="klide-connector-meta">
        <span>
          {probe.serverName}
          {probe.serverVersion && ` ${probe.serverVersion}`}
        </span>
        <span>MCP {probe.protocolVersion || "unknown"}</span>
        <span>ready in {(probe.elapsedMs / 1000).toFixed(1)}s</span>
      </div>
      {probe.tools.length === 0 ? (
        <Quiet>It started, but advertises no tools.</Quiet>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "12px 24px",
          }}
        >
          {probe.tools.map((tool) => (
            <div key={tool.name} style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--fg-strong)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tool.name}
                </span>
                {/* Only the annotation the server actually sent. Silence is not
                    "read-only", so an unannotated tool says nothing at all. */}
                {tool.readOnly === true && (
                  <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>reads</span>
                )}
              </div>
              {tool.description && (
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 12,
                    color: "var(--fg-subtle)",
                    lineHeight: 1.45,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {tool.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddForm({
  onAdd,
  onCancel,
}: {
  onAdd: (connector: Connector) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [line, setLine] = useState("");
  const [env, setEnv] = useState("");

  const remote = isUrl(line);

  function submit() {
    const { command, args } = splitCommand(line);
    if (!label.trim() || !command) {
      notify("A connector needs a name and a command or URL", { tone: "warn" });
      return;
    }
    onAdd({
      id: label,
      label: label.trim(),
      server: remote
        ? { url: line.trim(), headers: parseEnv(env) }
        : { command, args, env: parseEnv(env), cwd: null },
      enabled: true,
      origin: "manual",
    });
  }

  return (
    <Panel>
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        <Field label="Name">
          <Input value={label} onChange={setLabel} placeholder="Linear" autoFocus />
        </Field>
        <Field label="Command or URL">
          <Input value={line} onChange={setLine} placeholder="npx -y linear-mcp" mono />
        </Field>
        <Field
          label={remote ? "Headers" : "Environment"}
          hint={remote ? "one Name=value per line; a value may be ${VAR}" : "one KEY=value per line, optional"}
        >
          <textarea
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={remote ? "Authorization=Bearer ${LINEAR_TOKEN}" : "LINEAR_API_KEY=lin_api_…"}
            className="klide-field"
            style={{
              width: "100%",
              resize: "vertical",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              padding: "8px 10px",
              lineHeight: 1.5,
            }}
          />
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 2 }}>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <LinkButton onClick={submit}>Add connector</LinkButton>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------ small parts --*/

/** A text verb. The page's only button shape outside the add form — Klide's
 *  buttons are for commitments, and Check / Remove / Import are not. */
function Verb({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className="klide-connector-verb"
      data-danger={danger ? "true" : undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--fg-strong)" }}>
        {label}
        {hint && <span style={{ color: "var(--fg-dim)" }}> — {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  mono,
  autoFocus,
  secret,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
  /** A pasted key is masked; its reference placeholder still reads. */
  secret?: boolean;
}) {
  return (
    <input
      type={secret ? "password" : "text"}
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      autoFocus={autoFocus}
      className="klide-field"
      style={{
        width: "100%",
        height: 34,
        padding: "0 12px",
        fontSize: mono ? 12 : 13,
        fontFamily: mono ? "var(--font-mono)" : "inherit",
      }}
    />
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span style={{ fontSize: 12, color: tone ?? "var(--fg-subtle)", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 12, color: "var(--fg-subtle)", lineHeight: 1.5 }}>{children}</span>
  );
}

/** An empty state is a sentence, not a grey box. `flush` drops the card's
 *  padding for the borderless import list. */
function Empty({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return (
    <div
      style={{
        padding: flush ? "6px 2px 2px" : "20px 18px",
        fontSize: 12.5,
        color: "var(--fg-subtle)",
        lineHeight: 1.55,
        maxWidth: 560,
      }}
    >
      {children}
    </div>
  );
}

/** A command name inside prose, at the prose's own size — a mono face reads
 *  larger than Atkinson at the same pixel size, so it steps down a half. */
function InlineCode({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.92em", color: "var(--fg-subtle)" }}>{children}</span>;
}

function FootNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 12,
        fontSize: 12,
        color: "var(--fg-dim)",
        lineHeight: 1.6,
        maxWidth: 620,
      }}
    >
      {children}
    </div>
  );
}
