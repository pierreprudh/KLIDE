// Connectors — the Settings surface for MCP servers Klide connects *to*.
//
// Three blocks, in the order a first visit needs them:
//
//   1. Your connectors     — what Klide has, and whether each one starts.
//   2. Available to import — the servers already configured in Claude Code,
//                            Codex and OpenCode, read from their own config.
//   3. Add a connector     — the escape hatch for a server no other tool knows:
//                            a command, or a URL for a remote server.
//
// GitHub gets one more door: "Connect GitHub" adds GitHub's own remote server,
// signed in as the account Klide already uses (`connectors::github_preset`), so
// the most common connector needs no token and no config file at all.
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
// read-only tools run as asked, anything that can change something asks first
// (`agent/connector_tools.rs`).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  addGithubConnector,
  discoverConnectors,
  isRemote,
  listConnectors,
  probeConnector,
  removeConnector,
  upsertConnector,
  type Connector,
  type Discovered,
  type Probe,
  type ServerSpec,
} from "../../ipc/connectors";
import { githubAccounts } from "../../ipc/git";
import { LinkMark } from "../linkMark";
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

/** Where a connector came from, in words rather than a badge. */
const ORIGIN_LABEL: Record<string, string> = {
  manual: "Added here",
  preset: "As your GitHub account",
  "claude-code": "From Claude Code",
  codex: "From Codex",
  opencode: "From OpenCode",
  workspace: "From this project",
};

/** `npx -y linear-mcp`, or a remote server's URL — the same thing a config
 *  file would hold. Display only; the split that produced it happened when the
 *  connector was saved. */
function commandLine(server: ServerSpec): string {
  return isRemote(server) ? server.url : [server.command, ...server.args].join(" ");
}

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
  const offers = useGlide();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [found, setFound] = useState<Discovered[]>([]);
  const [scanning, setScanning] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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

  async function save(connector: Connector) {
    try {
      setConnectors(await upsertConnector(connector));
    } catch (e) {
      notify(errMessage(e), { tone: "error" });
    }
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

  async function importOne(candidate: Discovered) {
    await save({
      id: candidate.id,
      label: candidate.label,
      server: candidate.server,
      enabled: true,
      origin: candidate.origin,
    });
    await rescan();
  }

  const importable = useMemo(() => found.filter((f) => !f.alreadyAdded), [found]);
  const busy = connectors.some((c) => checks[c.id]?.state === "checking");
  const hasGithub = connectors.some(isGithub);

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
          <div {...ledger.listProps}>
            <GlideHighlight glide={ledger.glide} />
            {!hasGithub && (
              <GithubSuggestion
                login={githubLogin}
                connecting={connectingGithub}
                onConnect={() => void connectGithub()}
                rowProps={ledger.rowProps}
                last={connectors.length === 0}
              />
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
                  rowProps={ledger.rowProps}
                />
            ))}
          </div>
        </Panel>
        <FootNote>
          In Plan and Goal, the assistant can use every enabled connector. Tools
          a server marks read-only run as asked; anything that can change
          something — open a PR, comment on an issue — asks you first. Klide's
          own <InlineCode>klide mcp coordination</InlineCode> server is the opposite
          direction: what delegate CLIs use to reach back into Klide.
        </FootNote>
      </section>

      <section className="klide-primitive-section">
        <Head
          index="02"
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
          <div {...offers.listProps}>
            <GlideHighlight glide={offers.glide} />
            {importable.map((candidate, i) => (
              <div
                key={`${candidate.origin}:${candidate.id}`}
                className="klide-connector-offer"
                style={{ animationDelay: `${Math.min(i, 8) * 22}ms` }}
                {...offers.rowProps}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="klide-row-title">{candidate.label}</div>
                  <div className="klide-connector-command">{commandLine(candidate.server)}</div>
                  <div className="klide-connector-meta">
                    <span>{ORIGIN_LABEL[candidate.origin] ?? candidate.origin}</span>
                    <span style={{ opacity: 0.75 }}>{candidate.sourcePath}</span>
                  </div>
                </div>
                <div className="klide-connector-verbs">
                  <Verb onClick={() => void importOne(candidate)}>Import</Verb>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="klide-primitive-section">
        <Head
          index="03"
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
          <RowTitle mark={isGithub(connector)}>{connector.label}</RowTitle>
          <div className="klide-connector-command">{commandLine(connector.server)}</div>
          <div className="klide-connector-meta">
            <span>{ORIGIN_LABEL[connector.origin] ?? connector.origin}</span>
            {scope ? (
              <span style={{ opacity: 0.75 }}>{scope}</span>
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
function RowTitle({ mark, children }: { mark: boolean; children: ReactNode }) {
  return (
    <div className="klide-row-title" style={{ display: "flex", alignItems: "center", gap: 7 }}>
      {mark && <LinkMark site="github" size={14} />}
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

/** GitHub, before it is connected: the one connector most people want, offered
 *  where connectors live rather than as a link in a heading. Its verb is always
 *  shown — this row exists to be clicked, unlike a row's Check / Remove. */
function GithubSuggestion({
  login,
  connecting,
  onConnect,
  rowProps,
  last,
}: {
  login: string | null | undefined;
  connecting: boolean;
  onConnect: () => void;
  rowProps: { onMouseEnter: (e: { currentTarget: HTMLElement }) => void; onFocus: (e: { currentTarget: HTMLElement }) => void };
  last: boolean;
}) {
  const who =
    login === undefined ? "Signs in as your GitHub account"
      : login === null ? "Needs a GitHub login first — run gh auth login"
        : `Signs in as ${login} — nothing to paste`;
  return (
    <div className="klide-connector-row" style={last ? { borderBottom: "none" } : undefined} {...rowProps}>
      <div style={{ minWidth: 0 }}>
        <RowTitle mark>GitHub</RowTitle>
        <div className="klide-connector-meta" style={{ fontSize: 12.5, color: "var(--fg-subtle)" }}>
          Repositories, issues, pull requests and Actions
        </div>
        <div className="klide-connector-meta">{who}</div>
      </div>
      <Verb onClick={onConnect} disabled={connecting || login === null}>
        {connecting ? "Connecting…" : "Connect"}
      </Verb>
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
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
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
