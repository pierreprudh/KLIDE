// Compact account popover above the bottom edge of the workspace.
import { useEffect, useRef, useState } from "react";
import { AccountControl } from "./settings/accounts";
import { GitHubAccountRow } from "./GitHubAccountRow";
import { ProviderLogo } from "./ai/icons";
import { Z } from "../zLayers";
import { initialsOf, useUserInfo } from "../hooks/useUserInfo";
import {
  humanTokens,
  resetLabel,
  resetShort,
  usageSnapshot,
  usageTone,
  type ToolUsage,
} from "../ipc/usage";
import "./profileMenu.css";

/** The CLIs the menu lists, in order. */
const CLIS = [
  { provider: "claude-code", title: "Claude Code" },
  { provider: "codex", title: "Codex" },
  { provider: "opencode", title: "OpenCode" },
] as const;

// The Claude reading is a network call; opening the menu twice in a minute
// should not make it twice.
const FRESH_MS = 60_000;
let lastUsage: { at: number; tools: ToolUsage[] } | null = null;

function useUsage(open: boolean): ToolUsage[] | null {
  const [tools, setTools] = useState<ToolUsage[] | null>(lastUsage?.tools ?? null);
  useEffect(() => {
    if (!open) return;
    if (lastUsage && Date.now() - lastUsage.at < FRESH_MS) {
      setTools(lastUsage.tools);
      return;
    }
    let cancelled = false;
    usageSnapshot()
      .then((next) => {
        lastUsage = { at: Date.now(), tools: next };
        if (!cancelled) setTools(next);
      })
      .catch(() => {
        if (!cancelled) setTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  return tools;
}

type Props = {
  open: boolean;
  workspaceRoot: string | null;
  onClose: () => void;
};

export function ProfileModal({ open, onClose }: Props) {
  const { username, avatarUrl } = useUserInfo();
  const menuRef = useRef<HTMLDivElement>(null);
  const tools = useUsage(open);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (!buttons.length) { event.preventDefault(); return; }
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.shiftKey && index <= 0) {
          event.preventDefault(); buttons[buttons.length - 1].focus();
        } else if (!event.shiftKey && (index === -1 || index === buttons.length - 1)) {
          event.preventDefault(); buttons[0].focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: Z.modal }} onClick={onClose}>
      <div ref={menuRef} role="dialog" aria-modal="true" aria-label="Accounts" tabIndex={-1}
        className="profile-account-menu" onClick={(event) => event.stopPropagation()}>
        <div className="profile-account-menu-header">
          <Avatar name={username || "you"} avatarUrl={avatarUrl} size={28} />
          <span>{username || "Local profile"}</span>
        </div>
        <div className="profile-account-menu-rows">
          <GitHubAccountRow compact />
          {CLIS.map((cli) => (
            <CliAccount
              key={cli.provider}
              {...cli}
              usage={tools?.find((t) => t.provider === cli.provider)}
              loading={tools === null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One CLI: who it is signed in as, and how much of its allowance is spent. */
function CliAccount({
  provider,
  title,
  usage,
  loading,
}: {
  provider: (typeof CLIS)[number]["provider"];
  title: string;
  usage: ToolUsage | undefined;
  loading: boolean;
}) {
  const [collapsed, setCollapsed] = useCollapsed(provider);
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <section aria-label={`${title} account`} className="profile-account-cli" data-provider={provider}>
      {/* The whole row folds the usage into one line; its own controls keep
          their clicks. */}
      <div
        className="profile-account-menu-row profile-account-head"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setCollapsed(!collapsed);
          }
        }}
      >
        <ProviderLogo id={provider} size={16} />
        <span className="profile-account-title">{title}</span>
        {collapsed ? (
          <UsageLines usage={usage} loading={loading} collapsed />
        ) : (
          <span className="profile-account-controls" onClick={stop} onKeyDown={stop}>
            <AccountControl provider={provider} title={title} connected={false} compact />
          </span>
        )}
        {/* Always drawn, empty when the CLI names no plan, so every row keeps
            the same right edge. */}
        <span className="profile-account-plan">{usage?.plan ?? ""}</span>
      </div>
      {!collapsed && <UsageLines usage={usage} loading={loading} collapsed={false} />}
    </section>
  );
}

const COLLAPSED_KEY = "klide.accountMenu.collapsed";

/** Which accounts are folded to one line — remembered per viewer. */
function useCollapsed(provider: string): [boolean, (next: boolean) => void] {
  const read = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    } catch {
      return [];
    }
  };
  const [collapsed, setState] = useState(() => read().includes(provider));
  return [
    collapsed,
    (next) => {
      setState(next);
      try {
        const others = read().filter((p) => p !== provider);
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next ? [...others, provider] : others));
      } catch {
        /* storage unavailable — the fold just isn't remembered */
      }
    },
  ];
}

function UsageLines({
  usage,
  loading,
  collapsed,
}: {
  usage: ToolUsage | undefined;
  loading: boolean;
  collapsed: boolean;
}) {
  if (loading) return <div className="profile-usage-note">Reading usage…</div>;
  if (!usage) return null;
  if (usage.error) return <div className="profile-usage-note">{usage.error}</div>;
  const spend = usage.spend
    ? `$${usage.spend.costUsd.toFixed(2)} · ${humanTokens(usage.spend.tokens)} tokens`
    : null;
  if (collapsed) {
    // Folded into the account's own row: only the 5-hour session window, the
    // one that runs out first.
    const session = usage.windows.find((w) => w.label === "Session");
    return (
      <div className="profile-usage-compact">
        {session && (
          <span className="profile-usage-compact-item" title={`Session · ${resetLabel(session)}`}>
            <Bar percent={clamp(session.percent)} />
            <span className="profile-usage-value">{Math.round(clamp(session.percent))}%</span>
          </span>
        )}
        {spend && <span className="profile-usage-spend">{spend}</span>}
      </div>
    );
  }
  return (
    <div className="profile-usage">
      {usage.windows.map((w) => {
        const percent = clamp(w.percent);
        return (
          <div key={w.label} className="profile-usage-line" title={resetLabel(w)}>
            <span className="profile-usage-label">{w.label}</span>
            <Bar percent={percent} />
            <span className="profile-usage-value">{Math.round(percent)}%</span>
            <span className="profile-usage-reset">{resetShort(w)}</span>
          </div>
        );
      })}
      {spend && (
        <div className="profile-usage-line">
          <span className="profile-usage-label">This week</span>
          <span className="profile-usage-spend">{spend}</span>
        </div>
      )}
    </div>
  );
}

/** A thin bar in the CLI's own colour, red once the window is nearly spent. */
function Bar({ percent }: { percent: number }) {
  return (
    <span className="profile-usage-track" aria-hidden>
      <span className="profile-usage-fill" data-tone={usageTone(percent)} style={{ width: `${percent}%` }} />
    </span>
  );
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

function Avatar({ name, avatarUrl, size }: { name: string; avatarUrl: string; size: number }) {
  const initials = initialsOf(name);
  // Deterministic hue from the name so the same user always gets the
  // same colour, but it's a quiet hue (saturated very low) so it
  // doesn't compete with the rest of the UI.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return (
    <div
      aria-hidden
      style={{
        position: "relative",
        width: size,
        height: size,
        overflow: "hidden",
        borderRadius: "50%",
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        background: `linear-gradient(140deg, oklch(0.78 0.10 ${hue}), oklch(0.62 0.12 ${(hue + 40) % 360}))`,
        color: "var(--bg-elevated)",
        fontFamily: "var(--font-ui)",
        fontSize: size * 0.36,
        fontWeight: 600,
        letterSpacing: "-0.01em",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
      }}
    >
      {initials}
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          onError={(event) => { event.currentTarget.style.display = "none"; }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            borderRadius: "inherit",
            objectFit: "cover",
          }}
        />
      ) : null}
    </div>
  );
}
