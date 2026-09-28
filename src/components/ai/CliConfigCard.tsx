import { useEffect, useMemo, useRef, useState } from "react";

import { claudeCodeSettings } from "../../ipc/delegateCommands";
import { Select, Toggle } from "../settings/controls";
import { configCommand, currentConfigValue, sendableConfigChanges, settleAppliedConfig, type ConfigOption } from "./cliConfig";

type Props = {
  options: ConfigOption[];
  workspaceRoot: string | null;
  /** Sends the one `/config key=value …` message; the CLI's reply confirms. */
  onApply: (message: string) => void;
  disabled?: boolean;
};

const UNKNOWN = "—";

/** Claude Code's `/config` answer drawn as the menu its terminal app shows:
 *  one row per setting the CLI printed, the current value where its files
 *  say, and one Apply that sends every change in a single message. */
export function CliConfigCard({ options, workspaceRoot, onApply, disabled = false }: Props) {
  const [current, setCurrent] = useState<Record<string, unknown>>({});
  const [staged, setStaged] = useState<Record<string, string>>({});
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const [filter, setFilter] = useState("");
  // The edits the last Apply sent, until the turn after it settles them; and
  // the ones the files keep under a name Klide cannot read back.
  const sent = useRef<Record<string, string> | null>(null);
  const [assumed, setAssumed] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!workspaceRoot || disabled) return;
    let alive = true;
    // A settled turn triggers a fresh read. Sending the command is not taking
    // effect: an Apply's edits clear only against what the files say after.
    void claudeCodeSettings(workspaceRoot).then((settings) => {
      if (!alive) return;
      setCurrent(settings);
      const applied = sent.current;
      if (!applied) return;
      sent.current = null;
      const settled = settleAppliedConfig(stagedRef.current, applied, settings);
      setStaged(settled.staged);
      setAssumed((prev) => ({ ...prev, ...settled.assumed }));
    }).catch(() => {});
    return () => { alive = false; };
  }, [workspaceRoot, disabled]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? options.filter((o) => o.key.toLowerCase().includes(q)) : options;
  }, [filter, options]);

  // What a setting is now: the files first, then an Apply they cannot show.
  const valueOf = (key: string) => currentConfigValue(current, key) ?? assumed[key] ?? null;
  const stage = (key: string, value: string) => setStaged((prev) => {
    const next = { ...prev };
    if (value === (valueOf(key) ?? "")) delete next[key];
    else next[key] = value;
    return next;
  });
  const message = configCommand(staged);
  const count = Object.keys(staged).length;

  return (
    <section
      aria-label="Claude Code settings"
      style={{ border: "1px solid var(--border)", borderRadius: 12, background: "color-mix(in srgb, var(--bg-elevated) 45%, transparent)", margin: "2px 0 4px", overflow: "hidden" }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 600 }}>Claude Code settings</div>
          <div style={{ color: "var(--fg-subtle)", fontSize: 12 }}>Changes are confirmed from Claude Code's config</div>
        </div>
        <input
          className="klide-field"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          aria-label="Filter settings"
          style={{ width: 150, height: 28, padding: "0 10px", fontSize: 12 }}
        />
      </header>
      <div style={{ maxHeight: 360, overflowY: "auto", padding: "4px 0" }}>
        {shown.map((option) => {
          const known = valueOf(option.key);
          const value = staged[option.key] ?? known ?? "";
          const changed = option.key in staged;
          return (
            <div key={option.key} className="cli-config-row" style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 38, padding: "3px 14px" }}>
              <div className="cli-config-name" data-changed={changed || undefined} style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12.5, overflowWrap: "anywhere" }}>{option.key}</div>
              {!option.settable ? (
                <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Terminal only</span>
              ) : option.choices === null ? (
                <input
                  className="klide-field"
                  value={value}
                  disabled={disabled}
                  onChange={(e) => stage(option.key, e.target.value)}
                  aria-label={option.key}
                  style={{ width: 180, height: 28, padding: "0 10px", fontSize: 12 }}
                />
              ) : isBoolean(option.choices) && (known !== null || changed) ? (
                <Toggle checked={value === "true"} onChange={(on) => stage(option.key, String(on))} label={option.key} />
              ) : (
                <Select
                  value={value || UNKNOWN}
                  onChange={(next) => { if (next !== UNKNOWN) stage(option.key, next); }}
                  options={value ? option.choices : [UNKNOWN, ...option.choices]}
                  label={option.key}
                />
              )}
            </div>
          );
        })}
        {shown.length === 0 && <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--fg-subtle)" }}>No setting matches.</div>}
      </div>
      <footer style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 14, padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
        {count > 0 && (
          <button type="button" onClick={() => setStaged({})} style={textButton("var(--fg-subtle)")}>Reset</button>
        )}
        <button
          type="button"
          disabled={disabled || !message}
          onClick={() => { if (message) { sent.current = sendableConfigChanges(staged); onApply(message); } }}
          style={textButton(message && !disabled ? "var(--accent)" : "var(--fg-dim)", !!message && !disabled)}
        >
          {count > 0 ? `Apply ${count} change${count === 1 ? "" : "s"}` : "Apply"}
        </button>
      </footer>
    </section>
  );
}

function isBoolean(choices: string[]): boolean {
  return choices.length === 2 && choices.includes("true") && choices.includes("false");
}

function textButton(color: string, enabled = true) {
  return { font: "inherit", fontSize: 12, fontWeight: 500, border: 0, background: "none", padding: "4px 0", color, cursor: enabled ? "pointer" : "default" } as const;
}
