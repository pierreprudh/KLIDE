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

import { useCallback, useEffect, useRef, useState } from "react";
import { cliVersions, runCliUpdate, type CliVersion } from "../../ipc/cliUpdates";
import { ProviderLogo } from "../ai/icons";
import type { ProviderId } from "../../agent/types";
import { errMessage } from "../../errors";
import { notify } from "../../toast";
import { CenteredLoader, LinkButton, Panel } from "./controls";

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

/** What the row says under its title once a version is known. */
function versionLine(row: CliVersion): string {
  if (!row.installed) return row.detail ?? `${row.binary} is not installed or not on PATH`;
  if (row.version) return `${row.binary} ${row.version}`;
  return row.detail ?? `${row.binary} is installed`;
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
            <div
              className="klide-row-description"
              style={{
                fontFamily: row.version ? "var(--font-mono)" : undefined,
                opacity: row.installed ? 1 : 0.75,
              }}
            >
              {versionLine(row)}
            </div>
          </div>
        </div>
        {row.updateCommand ? (
          <LinkButton onClick={() => void update()} disabled={running}>
            {running ? "Updating…" : "Update"}
          </LinkButton>
        ) : null}
      </div>
      {output !== null && <OutputStrip text={terminalText(output)} />}
    </>
  );
}

export function CliVersionsBlock() {
  const [rows, setRows] = useState<CliVersion[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await cliVersions());
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (rows === null) return <CenteredLoader label="Reading CLI versions…" />;

  return (
    <Panel>
      {rows.map((row) => (
        <CliRow
          key={row.provider}
          row={row}
          onUpdated={(next) =>
            setRows((current) =>
              (current ?? []).map((r) => (r.provider === next.provider ? next : r)),
            )
          }
        />
      ))}
    </Panel>
  );
}
