// Four ways to lay out Settings › Subscription, side by side in one tab.
//
// The page today asks the same five providers four separate questions —
// Connections & Accounts, CLI versions, Connection Options, Model Options —
// so Codex's logo is drawn four times and you read down the page to assemble
// one CLI in your head. Twenty-two rows to say six things.
//
// Every variant below keeps the same facts and moves the unit of the page from
// *the question* to *the CLI*. Switch with the tabs, or ?v=now|a|b|c.
//
//   npx vite --port 1421  →  http://localhost:1421/preview/subscription.html
//   ?theme=dark | klide-light | sage-garden | cursor-dark | …
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { ProviderLogo } from "../src/components/ai/icons";
import type { ProviderId } from "../src/agent/types";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

// ── The facts, exactly as this machine reports them ──────────────────────────

type Cli = {
  id: string;
  title: string;
  account: string | null;
  /** The auth line `ai_subscription_status` returns. */
  detail: string;
  path: string | null;
  version: string | null;
  latest: string | null;
  login: string[];
  models: string[];
  modelNote: string;
};

const CLIS: Cli[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    account: "personal",
    detail: "Subscription login · pierre@ontraak.com",
    path: "~/.local/bin/claude",
    version: "2.1.274",
    latest: "2.1.274",
    login: ["claude setup-token", "claude login"],
    models: ["opus-5", "sonnet-5", "haiku-4.5"],
    modelNote: "Loaded from Claude Code's local model usage cache.",
  },
  {
    id: "codex",
    title: "Codex",
    account: "work",
    detail: "ChatGPT login · pierre@ontraak.com",
    path: "~/.local/bin/codex",
    version: "0.154.0",
    latest: "0.154.0",
    login: ["codex login", "codex login --api-key"],
    models: ["gpt-6-astra", "gpt-5.3-codex", "o5-mini"],
    modelNote: "Loaded from the current Codex model cache when available.",
  },
  {
    id: "opencode",
    title: "OpenCode",
    account: null,
    detail: "opencode CLI is installed.",
    path: "~/.opencode/bin/opencode",
    version: "1.18.31",
    latest: "1.18.31",
    login: ["opencode auth login"],
    models: [],
    modelNote: "OpenCode chooses models inside its own interactive CLI.",
  },
  {
    id: "omp",
    title: "Oh My Pi",
    account: null,
    detail: "Provider keys come from your shell environment.",
    path: "~/.nvm/…/bin/omp",
    version: "15.13.3",
    latest: "18.2.4",
    login: ["omp"],
    models: ["claude-opus-5", "gpt-6-astra", "gemini-4-pro", "grok-5"],
    modelNote: "Loaded from omp's model cache (providers it could actually reach).",
  },
];

const behind = (c: Cli) => !!c.version && !!c.latest && c.version !== c.latest;

// ── Shared scaffolding ───────────────────────────────────────────────────────

const Heading = ({ children }: { children: React.ReactNode }) => (
  <h2 className="klide-settings-heading" style={{ margin: "0 0 10px" }}>
    {children}
  </h2>
);

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="klide-surface">{children}</div>
);

/** The app's secondary button, at the two sizes these layouts use. */
function Button({
  children,
  small,
  onClick,
}: {
  children: React.ReactNode;
  small?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="klide-button klide-button-secondary"
      style={{ height: small ? 26 : 32, padding: small ? "0 10px" : "0 12px", fontSize: small ? 11.5 : 12.5 }}
    >
      {children}
    </button>
  );
}

const Mono = ({ children, dim }: { children: React.ReactNode; dim?: boolean }) => (
  <span
    style={{
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: dim ? "var(--fg-subtle)" : "var(--fg-dim)",
    }}
  >
    {children}
  </span>
);

/** A version, with what a check found appended. Emphasis is colour, never
 *  weight — Atkinson is single-weight. */
function Version({ cli }: { cli: Cli }) {
  if (!cli.version) return <Mono dim>not installed</Mono>;
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-subtle)" }}>
      {cli.version}
      {behind(cli) && (
        <>
          <span style={{ opacity: 0.5 }}> → </span>
          <span style={{ color: "var(--fg-strong)" }}>{cli.latest}</span>
        </>
      )}
    </span>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// NOW — what ships today. Here for comparison, not as a proposal.
// ═════════════════════════════════════════════════════════════════════════════

function Now() {
  const row = (cli: Cli, right: React.ReactNode, description: string) => (
    <div key={cli.id} className="klide-settings-row">
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
        <ProviderLogo id={cli.id as ProviderId} />
        <div style={{ minWidth: 0 }}>
          <div className="klide-row-title">{cli.title}</div>
          <div className="klide-row-description">{description}</div>
        </div>
      </div>
      {right}
    </div>
  );
  return (
    <>
      <section style={{ marginBottom: 28 }}>
        <Heading>Connections &amp; Accounts</Heading>
        <Surface>
          {CLIS.map((c) =>
            row(c, <Button>{c.account ?? "Save login"}</Button>, c.detail),
          )}
        </Surface>
      </section>
      <section style={{ marginBottom: 28 }}>
        <Heading>CLI versions</Heading>
        <Surface>{CLIS.map((c) => row(c, <Button>Update</Button>, `${c.id} ${c.version}`))}</Surface>
      </section>
      <section style={{ marginBottom: 28 }}>
        <Heading>Connection Options</Heading>
        <Surface>
          {CLIS.map((c) => row(c, <Mono dim>{c.login.join("  ")}</Mono>, `CLI path: ${c.path}`))}
        </Surface>
      </section>
      <section style={{ marginBottom: 28 }}>
        <Heading>Model Options</Heading>
        <Surface>
          {CLIS.map((c) =>
            row(
              c,
              <Mono dim>{c.models.length ? c.models.slice(0, 3).join("  ") : "Unavailable"}</Mono>,
              c.modelNote,
            ),
          )}
        </Surface>
      </section>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// A — One row per CLI, the rest behind a disclosure.
//
// The page is six rows. Everything that was a separate block is still there,
// one click down, and you never read four sections to assemble one CLI.
// ═════════════════════════════════════════════════════════════════════════════

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "88px minmax(0, 1fr)", gap: 12 }}>
      <div style={{ fontSize: 12, color: "var(--fg-subtle)", paddingTop: 1 }}>{label}</div>
      <div style={{ minWidth: 0, fontSize: 12.5, color: "var(--fg-dim)" }}>{children}</div>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        color: "var(--fg-subtle)",
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

function VariantA() {
  const [open, setOpen] = useState<string | null>("omp");
  return (
    <section style={{ marginBottom: 28 }}>
      <Heading>Coding CLIs</Heading>
      <Surface>
        {CLIS.map((cli) => {
          const isOpen = open === cli.id;
          return (
            <div key={cli.id}>
              <div
                className="klide-settings-row"
                style={{ cursor: "pointer", borderBottom: isOpen ? "none" : undefined }}
                onClick={() => setOpen(isOpen ? null : cli.id)}
              >
                <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                  <Chevron open={isOpen} />
                  <ProviderLogo id={cli.id as ProviderId} />
                  <div style={{ minWidth: 0 }}>
                    <div className="klide-row-title">{cli.title}</div>
                    <div className="klide-row-description">{cli.detail}</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <Version cli={cli} />
                  <Button onClick={() => {}}>{cli.account ?? "Save login"}</Button>
                </div>
              </div>
              {isOpen && (
                <div
                  className="klide-fade-swap"
                  style={{
                    padding: "2px 18px 18px 50px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    borderBottom: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
                  }}
                >
                  <Fact label="Binary">
                    <Mono>{cli.path}</Mono>
                  </Fact>
                  <Fact label="Sign in">
                    <Mono>{cli.login.join("   ")}</Mono>
                  </Fact>
                  <Fact label="Models">
                    {cli.models.length ? (
                      <Mono>{cli.models.join("   ")}</Mono>
                    ) : (
                      <span style={{ color: "var(--fg-subtle)" }}>{cli.modelNote}</span>
                    )}
                  </Fact>
                  <Fact label="Version">
                    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Version cli={cli} />
                      <Button small>{behind(cli) ? `Update to ${cli.latest}` : "Update"}</Button>
                    </span>
                  </Fact>
                </div>
              )}
            </div>
          );
        })}
      </Surface>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// B — Two columns: the CLIs on the left, one CLI's everything on the right.
//
// Nothing repeats and nothing scrolls. The most "design tool" of the three,
// and the one that scales when a fifth and sixth CLI arrive.
// ═════════════════════════════════════════════════════════════════════════════

function VariantB() {
  const [selected, setSelected] = useState("omp");
  const cli = CLIS.find((c) => c.id === selected)!;
  return (
    <section style={{ marginBottom: 28 }}>
      <Heading>Coding CLIs</Heading>
      <Surface>
        <div style={{ display: "grid", gridTemplateColumns: "196px minmax(0, 1fr)", minHeight: 300 }}>
          <div style={{ borderRight: "1px solid var(--border)", padding: 8 }}>
            {CLIS.map((c) => {
              const active = c.id === selected;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelected(c.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 10px",
                    border: "none",
                    borderRadius: "var(--radius-sm)",
                    background: active ? "var(--bg-hover)" : "transparent",
                    color: active ? "var(--fg-strong)" : "var(--fg-dim)",
                    cursor: "pointer",
                  }}
                >
                  <ProviderLogo id={c.id as ProviderId} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13 }}>{c.title}</div>
                    <div style={{ fontSize: 11.5, color: "var(--fg-subtle)" }}>
                      {c.account ?? (c.version ? "installed" : "not installed")}
                    </div>
                  </span>
                  {behind(c) && (
                    <span style={{ fontSize: 11, color: "var(--fg-strong)" }}>{c.latest}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <div>
                <div style={{ fontSize: 16, color: "var(--fg-strong)", marginBottom: 3 }}>
                  {cli.title}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--fg-subtle)" }}>{cli.detail}</div>
              </div>
              <Button>{cli.account ?? "Save login"}</Button>
            </div>

            <div style={{ height: 1, background: "var(--border)" }} />

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Fact label="Binary">
                <Mono>{cli.path}</Mono>
              </Fact>
              <Fact label="Version">
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Version cli={cli} />
                  <Button small>{behind(cli) ? `Update to ${cli.latest}` : "Update"}</Button>
                </span>
              </Fact>
              <Fact label="Sign in">
                <Mono>{cli.login.join("   ")}</Mono>
              </Fact>
              <Fact label="Models">
                {cli.models.length ? (
                  <Mono>{cli.models.join("   ")}</Mono>
                ) : (
                  <span style={{ color: "var(--fg-subtle)" }}>{cli.modelNote}</span>
                )}
              </Fact>
            </div>
          </div>
        </div>
      </Surface>
    </section>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// C — One card per CLI, nothing hidden.
//
// No clicking, no scanning across sections: each CLI is a block that holds its
// own facts. Taller than A collapsed, but it answers every question at once.
// ═════════════════════════════════════════════════════════════════════════════

function VariantC() {
  return (
    <section style={{ marginBottom: 28 }}>
      <Heading>Coding CLIs</Heading>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {CLIS.map((cli) => (
          <div key={cli.id} className="klide-surface" style={{ padding: "16px 18px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 14,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <ProviderLogo id={cli.id as ProviderId} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: "var(--fg-strong)" }}>{cli.title}</div>
                  <div style={{ fontSize: 12.5, color: "var(--fg-subtle)" }}>{cli.detail}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                <Version cli={cli} />
                {behind(cli) && <Button small>Update to {cli.latest}</Button>}
                <Button>{cli.account ?? "Save login"}</Button>
              </div>
            </div>
            <div
              style={{
                borderTop: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
                paddingTop: 12,
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: "10px 24px",
              }}
            >
              <Fact label="Binary">
                <Mono>{cli.path}</Mono>
              </Fact>
              <Fact label="Sign in">
                <Mono>{cli.login.join("   ")}</Mono>
              </Fact>
              <Fact label="Models">
                {cli.models.length ? (
                  <Mono>{cli.models.slice(0, 3).join("   ")}</Mono>
                ) : (
                  <span style={{ color: "var(--fg-subtle)" }}>inside its own CLI</span>
                )}
              </Fact>
              <Fact label="Updater">
                <Mono>{cli.id === "opencode" ? "opencode upgrade" : `${cli.id} update`}</Mono>
              </Fact>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

const VARIANTS = [
  { id: "now", label: "Now", note: "4 blocks × 4 CLIs — 22 rows, every logo drawn four times." },
  { id: "a", label: "A · Disclosure", note: "One row per CLI; the other three blocks live one click down." },
  { id: "b", label: "B · Two columns", note: "A list and a detail pane. Nothing repeats, nothing scrolls." },
  { id: "c", label: "C · Cards", note: "One card per CLI with every fact on it. No clicking, one section." },
];

function Page() {
  const [variant, setVariant] = useState(params.get("v") ?? "a");
  const note = VARIANTS.find((v) => v.id === variant)?.note ?? "";
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--fg)",
        fontFamily: "var(--font-ui)",
        padding: "44px 0 80px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 32px" }}>
        <h1 style={{ margin: "0 0 6px", fontSize: 24, color: "var(--fg-strong)" }}>Subscription</h1>
        <p style={{ margin: "0 0 20px", fontSize: 13.5, color: "var(--fg-subtle)", lineHeight: 1.5 }}>
          The CLI logins Klide dispatches into.
        </p>

        {/* The switcher is the harness, not the design. */}
        <div style={{ display: "flex", gap: 2, marginBottom: 6 }}>
          {VARIANTS.map((v) => {
            const active = v.id === variant;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setVariant(v.id)}
                style={{
                  height: 28,
                  padding: "0 10px",
                  border: "none",
                  borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
                  background: "transparent",
                  color: active ? "var(--fg-strong)" : "var(--fg-subtle)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {v.label}
              </button>
            );
          })}
        </div>
        <p style={{ margin: "0 0 26px", fontSize: 12, color: "var(--fg-subtle)", minHeight: 18 }}>
          {note}
        </p>

        {variant === "now" && <Now />}
        {variant === "a" && <VariantA />}
        {variant === "b" && <VariantB />}
        {variant === "c" && <VariantC />}

        {/* Every variant keeps these two below it, unchanged. */}
        <section style={{ marginBottom: 28 }}>
          <Heading>Identity</Heading>
          <Surface>
            <div className="klide-settings-row">
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                <img src="./github-invertocat.svg" alt="" width={18} height={18} />
                <div>
                  <div className="klide-row-title">GitHub</div>
                  <div className="klide-row-description">
                    Klide always acts as pierreprudh — identity, avatars, PRs and pushes.
                  </div>
                </div>
              </div>
              <Button>pierreprudh</Button>
            </div>
            <div className="klide-settings-row">
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                <ProviderLogo id={"ollama" as ProviderId} />
                <div>
                  <div className="klide-row-title">Ollama</div>
                  <div className="klide-row-description">
                    Sign in to ollama.com for cloud models and model pushes.
                  </div>
                </div>
              </div>
              <Button>Sign in</Button>
            </div>
          </Surface>
        </section>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
