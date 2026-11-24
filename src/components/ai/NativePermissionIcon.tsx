import type { ProviderId } from "../../agent/types";
import { ProviderLogo } from "./icons";

const VIBE_MODE_ICONS: Readonly<Record<string, string>> = {
  ask: "/vibe-permissions/ask.svg",
  "accept-edits": "/vibe-permissions/accept-edits.svg",
  "smart-approve": "/vibe-permissions/smart-approve.svg",
  "auto-approve": "/vibe-permissions/auto-approve.svg",
};

// Claude Code's native status-line symbols. KLIDE's empty selection launches
// Claude with acceptEdits, so it wears that mode's double arrow too.
const CLAUDE_MODE_MARKS: Readonly<Record<string, { symbol: string; color: string }>> = {
  "": { symbol: "⏵⏵", color: "var(--accent)" },
  acceptEdits: { symbol: "⏵⏵", color: "var(--accent)" },
  manual: { symbol: "⏸︎", color: "var(--fg-dim)" },
  default: { symbol: "⏸︎", color: "var(--fg-dim)" },
  plan: { symbol: "⏸︎", color: "var(--fg-subtle)" },
  auto: { symbol: "⏵⏵", color: "var(--warning)" },
  dontAsk: { symbol: "⏵⏵", color: "var(--danger)" },
  bypassPermissions: { symbol: "⏵⏵", color: "var(--danger)" },
};

/** Native mode marks, with the agent logo as the fallback. */
export function NativePermissionIcon({ provider, mode, size = 16 }: {
  provider: ProviderId; mode: string; size?: number;
}) {
  const mark = provider === "claude-code" ? CLAUDE_MODE_MARKS[mode] : undefined;
  if (mark) return <span aria-hidden="true" style={{
    width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: size, lineHeight: 1,
    letterSpacing: "-0.12em", color: mark.color,
  }}>{mark.symbol}</span>;
  const src = provider === "vibe" ? VIBE_MODE_ICONS[mode] : undefined;
  return src
    ? <img src={src} width={size} height={size} alt="" aria-hidden="true" style={{ display: "block", flexShrink: 0 }} />
    : <ProviderLogo id={provider} size={size} />;
}
