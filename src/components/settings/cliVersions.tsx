// CLI versions — which build of each delegate CLI this machine launches, and
// the CLI's own updater when it's the wrong one.
//
// Klide launches `claude` / `codex` / `opencode` / `omp` from the login-shell
// PATH and never used to look at the version. A stale CLI then surfaced as a
// provider error with nothing to explain it — `400: The 'gpt-6-astra' model
// requires a newer version of Codex` — so the version lives on the row that
// already says the CLI is installed.
//
// Updating is always the user's word. The row runs the CLI's own updater in a
// real PTY and shows its output as it arrives, because an installer that
// prints nothing is indistinguishable from one that hung.

import { useEffect, useRef, useState } from "react";
import {
  checkCliUpdates,
  cliVersions,
  runCliUpdate,
  type CliVersion,
} from "../../ipc/cliUpdates";
import { ProviderLogo } from "../ai/icons";
import type { ProviderId } from "../../agent/types";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { CenteredLoader, LinkButton, Panel, SettingBlock } from "./controls";

/** Title per delegate id — the same words the Connections rows use. */
const TITLES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  omp: "Oh My Pi",
};

/**
 * An installer's output through a PTY carries escape sequences and progress
 * bars that redraw a line with `\r`. Rendering it as plain text means honouring
 * both: drop the escapes, and let a carriage return win the line the way a
 * terminal would.
 */
export function terminalText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const withoutAnsi = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g, "");
  return withoutAnsi
    .split("\n")
    .map((line) => {
      const redrawn = line.split("\r");
      return redrawn[redrawn.length - 1];
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * What the row says under its title. The installed version is the constant;
 * what a check added — a newer release, or the reason there's no answer — is
 * a tail on the same line, told with type weight rather than a badge.
 */
function VersionLine({ row }: { row: CliVersion }) {
  if (!row.installed) {
    return (
      <span style={{ opacity: 0.75 }}>
        {row.detail ?? `${row.binary} is not installed or not on PATH`}
      </span>
    );
  }
  if (!row.version) return <span>{row.detail ?? `${row.binary} is installed`}</span>;
  return (
    <span style={{ fontFamily: "var(--font-mono)" }}>
      {row.binary} {row.version}
      {row.updateAvailable && row.latest ? (
        <>
          <span style={{ opacity: 0.55 }}> → </span>
          <span style={{ color: "var(--fg-strong)", fontWeight: 600 }}>{row.latest}</span>
          <span style={{ fontFamily: "var(--font-ui)" }}> available</span>
        </>
      ) : row.latestError ? (
        <span style={{ fontFamily: "var(--font-ui)", opacity: 0.8 }}> · {row.latestError}</span>
      ) : row.latest ? (
        <span style={{ fontFamily: "var(--font-ui)", opacity: 0.8 }}> · latest</span>
      ) : null}
    </span>
  );
}

function OutputStrip({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  // Follow the tail the way a terminal does — an installer's interesting line
  // is always the last one.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      style={{
        margin: 0,
        padding: "10px 18px 14px 18px",
        maxHeight: 180,
        overflowY: "auto",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        lineHeight: 1.55,
        color: "var(--fg-dim)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        borderBottom: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
      }}
      className="klide-fade-swap"
    >
      {text || "Starting…"}
    </pre>
  );
}

function CliRow({
  row,
  onUpdated,
}: {
  row: CliVersion;
  onUpdated: (next: CliVersion) => void;
}) {
  const [output, setOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const title = TITLES[row.provider] ?? row.provider;

  async function update() {
    if (running || !row.updateCommand) return;
    setRunning(true);
    setOutput("");
    const before = row.version;
    try {
      const next = await runCliUpdate(row.provider, (chunk) =>
        setOutput((current) => (current ?? "") + chunk),
      );
      onUpdated(next);
      notify(
        next.version && next.version !== before
          ? `${title} updated to ${next.version}.`
          : `${title} is already up to date${next.version ? ` (${next.version})` : ""}.`,
        { tone: "success" },
      );
    } catch (e) {
      notify(`${title} update failed: ${errMessage(e)}`, { tone: "error" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <div className="klide-settings-row">
        <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
            <ProviderLogo id={row.provider as ProviderId} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="klide-row-title">{title}</div>
            <div className="klide-row-description">
              <VersionLine row={row} />
            </div>
          </div>
        </div>
        {row.updateCommand ? (
          <LinkButton onClick={() => void update()} disabled={running}>
            {running
              ? "Updating…"
              : row.updateAvailable && row.latest
              ? `Update to ${row.latest}`
              : "Update"}
          </LinkButton>
        ) : null}
      </div>
      {output !== null && <OutputStrip text={terminalText(output)} />}
    </>
  );
}

/**
 * Fold an update's result into the row it replaces.
 *
 * An updater that installed nothing leaves the earlier check standing — the
 * comparison it made is still about this exact build. An updater that moved
 * the version invalidates it, and the row goes back to saying only what it
 * knows rather than carrying a stale "up to date".
 */
export function afterUpdate(before: CliVersion, after: CliVersion): CliVersion {
  if (before.version && after.version === before.version) {
    return {
      ...after,
      latest: before.latest,
      updateAvailable: before.updateAvailable,
      latestError: before.latestError,
    };
  }
  return after;
}

/** A quiet circular arrow — the one place in this block an icon says something
 *  a word would say slower. It turns while the check is running. */
function RefreshMark({ spinning }: { spinning: boolean }) {
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
      className={spinning ? "klide-spin" : undefined}
      style={{ flexShrink: 0 }}
    >
      <path d="M20 11a8 8 0 0 0-13.7-5.3L3 9" />
      <path d="M4 13a8 8 0 0 0 13.7 5.3L21 15" />
      <path d="M3 4v5h5" />
      <path d="M21 20v-5h-5" />
    </svg>
  );
}

/**
 * The block. It opens with the local read — four `--version` calls, no
 * network — and asks the registry only when the user presses the button,
 * because opening Settings should not phone anywhere.
 */
export function CliVersionsBlock() {
  const [rows, setRows] = useState<CliVersion[] | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    cliVersions().then(
      (next) => !cancelled && setRows(next),
      () => !cancelled && setRows([]),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function check() {
    if (checking) return;
    setChecking(true);
    try {
      const next = await checkCliUpdates();
      setRows(next);
      const behind = next.filter((row) => row.updateAvailable);
      notify(
        behind.length === 0
          ? "Every CLI is on its latest release."
          : behind.length === 1
          ? `${TITLES[behind[0].provider] ?? behind[0].provider} has ${behind[0].latest}.`
          : `${behind.length} CLIs have a newer release.`,
        { tone: behind.length === 0 ? "success" : "info" },
      );
    } catch (e) {
      notify(`Update check failed: ${errMessage(e)}`, { tone: "error" });
    } finally {
      setChecking(false);
    }
  }

  const action = (
    <button
      type="button"
      onClick={() => void check()}
      disabled={checking || rows === null}
      className="klide-button klide-button-secondary"
      style={{
        height: 26,
        padding: "0 10px",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11.5,
        ...(checking || rows === null ? { opacity: 0.55, cursor: "default" } : null),
      }}
    >
      <RefreshMark spinning={checking} />
      {checking ? "Checking…" : "Check for updates"}
    </button>
  );

  return (
    <SettingBlock title="CLI versions" action={action}>
      {rows === null ? (
        <CenteredLoader label="Reading CLI versions…" />
      ) : (
        <Panel>
          {rows.map((row) => (
            <CliRow
              key={row.provider}
              row={row}
              onUpdated={(next) =>
                setRows((current) =>
                  (current ?? []).map((r) =>
                    r.provider === next.provider ? afterUpdate(r, next) : r,
                  ),
                )
              }
            />
          ))}
        </Panel>
      )}
    </SettingBlock>
  );
}
