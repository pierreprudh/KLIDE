// Connectors — the Settings surface for MCP servers Klide connects *to*.
//
// Three blocks, in the order a first visit needs them:
//
//   1. Your connectors     — what Klide has, and whether each one starts.
//   2. Available to import — the servers already configured in Claude Code,
//                            Codex and OpenCode, read from their own config.
//   3. Add a connector     — the escape hatch for a server no other tool knows.
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
// One honesty rule runs through it: a connector's tools are *listed*, not yet
// callable — the Harness tool registry is the next slice — and the page says so
// once, plainly, rather than implying a capability that isn't wired.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  discoverConnectors,
  listConnectors,
  probeConnector,
  removeConnector,
  upsertConnector,
  type Connector,
  type Discovered,
  type Probe,
  type StdioServer,
} from "../../ipc/connectors";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { CodeText, GhostButton, LinkButton, Panel, Toggle } from "./controls";

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
  "claude-code": "From Claude Code",
  codex: "From Codex",
  opencode: "From OpenCode",
  workspace: "From this project",
};

/** `npx -y linear-mcp` — the same thing a config file would hold. Display
 *  only; the split that produced it happened when the connector was saved. */
function commandLine(server: StdioServer): string {
  return [server.command, ...server.args].join(" ");
}

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
      const probe = await probeConnector(connector.server);
      setChecks((prev) => ({ ...prev, [connector.id]: { state: "ok", probe } }));
    } catch (e) {
      setChecks((prev) => ({
        ...prev,
        [connector.id]: { state: "failed", error: errMessage(e) },
      }));
    } finally {
      inFlight.current.delete(connector.id);
    }
  }, []);

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
          note={summary ?? "MCP servers Klide can start."}
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
            {connectors.length === 0 ? (
              <Empty>
                None yet. Klide reads the MCP servers you already configured in
                Claude Code, Codex and OpenCode — import one below.
              </Empty>
            ) : (
              connectors.map((connector, i) => (
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
              ))
            )}
          </div>
        </Panel>
        <FootNote>
          A connector's tools are listed here, but the assistant can't call them
          yet — wiring them into the Rust harness is the next step. Klide's own{" "}
          <CodeText>klide mcp coordination</CodeText> server is the opposite
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
          note="Any stdio MCP server — the command runs directly, never through a shell."
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
  const env = Object.keys(connector.server.env);
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
          <div className="klide-row-title">{connector.label}</div>
          <div className="klide-connector-command">{commandLine(connector.server)}</div>
          <div className="klide-connector-meta">
            <span>{ORIGIN_LABEL[connector.origin] ?? connector.origin}</span>
            {env.length > 0 && <span style={{ opacity: 0.75 }}>{env.join(" · ")}</span>}
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
        <span>started in {(probe.elapsedMs / 1000).toFixed(1)}s</span>
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

  function submit() {
    const { command, args } = splitCommand(line);
    if (!label.trim() || !command) {
      notify("A connector needs a name and a command", { tone: "warn" });
      return;
    }
    onAdd({
      id: label,
      label: label.trim(),
      server: { command, args, env: parseEnv(env), cwd: null },
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
        <Field label="Command">
          <Input value={line} onChange={setLine} placeholder="npx -y linear-mcp" mono />
        </Field>
        <Field label="Environment" hint="one KEY=value per line, optional">
          <textarea
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="LINEAR_API_KEY=lin_api_…"
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
