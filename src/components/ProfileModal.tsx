// Compact account popover above the bottom edge of the workspace.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AccountControl } from "./settings/accounts";
import { DELEGATES } from "../delegates";
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
const CLIS = DELEGATES.filter((d) => d.supportsAccounts).map((d) => ({
  provider: d.id, title: d.label,
}));

// The Claude reading is a network call; opening the menu twice in a minute
// should not make it twice.
const FRESH_MS = 60_000;
/** How long the menu takes to leave — matches `profile-menu-leave`. */
const LEAVE_MS = 150;
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
  // Stay on screen for the leave animation after the parent closes us,
  // whoever closed it — Escape, the backdrop, or the rail button again.
  const [leaving, setLeaving] = useState(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      setLeaving(true);
      const t = window.setTimeout(() => setLeaving(false), LEAVE_MS);
      wasOpen.current = open;
      return () => window.clearTimeout(t);
    }
    wasOpen.current = open;
    setLeaving(false);
  }, [open]);

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

  if (!open && !leaving) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: Z.modal, pointerEvents: open ? undefined : "none" }}
      onClick={onClose}
    >
      <div ref={menuRef} role="dialog" aria-modal="true" aria-label="Accounts" tabIndex={-1}
        className="profile-account-menu" data-leaving={!open || undefined}
        onClick={(event) => event.stopPropagation()}>
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
  const [collapsed, setStoredCollapsed] = useCollapsed(provider);
  const sectionRef = useRef<HTMLElement>(null);
  const firstRects = useRef<Map<string, DOMRect> | null>(null);
  // Fold or unfold, remembering where the shared pieces stood so they can
  // glide to where they land (see `morphFrom`).
  const setCollapsed = (next: boolean) => {
    if (sectionRef.current) firstRects.current = morphRects(sectionRef.current, collapsed);
    setStoredCollapsed(next);
  };
  useLayoutEffect(() => {
    const first = firstRects.current;
    firstRects.current = null;
    if (first && sectionRef.current) morphFrom(sectionRef.current, collapsed, first);
  }, [collapsed]);
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <section ref={sectionRef} aria-label={`${title} account`} className="profile-account-cli" data-provider={provider}>
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
          <span className="profile-account-swap-in" key="compact">
            <UsageLines usage={usage} loading={loading} collapsed />
          </span>
        ) : (
          <span className="profile-account-controls" onClick={stop} onKeyDown={stop}>
            <AccountControl provider={provider} title={title} connected={false} compact />
          </span>
        )}
        {/* Always drawn, empty when the CLI names no plan, so every row keeps
            the same right edge. */}
        <span className="profile-account-plan">{usage?.plan ?? ""}</span>
      </div>
      {/* Kept mounted and folded by height, so opening and closing an
          account slides rather than jumps. */}
      <div className="profile-usage-fold" data-open={!collapsed || undefined} aria-hidden={collapsed || undefined}>
        <div className="profile-usage-fold-inner">
          <UsageLines usage={usage} loading={loading} collapsed={false} />
        </div>
      </div>
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
            <Bar percent={clamp(session.percent)} morph="bar" />
            <span className="profile-usage-value" data-morph="value">{Math.round(clamp(session.percent))}%</span>
          </span>
        )}
        {spend && <span className="profile-usage-spend" data-morph="spend">{spend}</span>}
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
            <Bar percent={percent} morph={w.label === "Session" ? "bar" : undefined} />
            <span className="profile-usage-value" data-morph={w.label === "Session" ? "value" : undefined}>
              {Math.round(percent)}%
            </span>
            <span className="profile-usage-reset">{resetShort(w)}</span>
          </div>
        );
      })}
      {spend && (
        <div className="profile-usage-line">
          <span className="profile-usage-label">This week</span>
          <span className="profile-usage-spend" data-morph="spend">{spend}</span>
        </div>
      )}
    </div>
  );
}

/** A thin bar in the CLI's own colour, red once the window is nearly spent. */
function Bar({ percent, morph }: { percent: number; morph?: string }) {
  return (
    <span className="profile-usage-track" aria-hidden data-morph={morph}>
      <span className="profile-usage-fill" data-tone={usageTone(percent)} style={{ width: `${percent}%` }} />
    </span>
  );
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

// ── Morph ────────────────────────────────────────────────────────────────
//
// Folding moves the session bar, its figure and OpenCode's spend between the
// open view and the account's own row. Each is drawn in both places, tagged
// `data-morph`; a fold measures where the visible copy stands, lets React
// swap, then flies a copy of the new one from the old place to the new
// (FLIP). The copy rides above the menu, so the open view shrinking by
// height never clips it, and the real element waits hidden until it lands.

const MORPH_MS = 280;

/** The visible copy of each morphing piece: in the row when folded, in the
 *  open view otherwise. */
function morphTargets(section: HTMLElement, collapsed: boolean): Map<string, HTMLElement> {
  const scope = section.querySelector<HTMLElement>(
    collapsed ? ".profile-account-head" : ".profile-usage-fold"
  );
  const found = new Map<string, HTMLElement>();
  scope?.querySelectorAll<HTMLElement>("[data-morph]").forEach((el) => {
    found.set(el.dataset.morph!, el);
  });
  return found;
}

function morphRects(section: HTMLElement, collapsed: boolean): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  morphTargets(section, collapsed).forEach((el, key) => rects.set(key, el.getBoundingClientRect()));
  return rects;
}

function morphFrom(section: HTMLElement, collapsed: boolean, first: Map<string, DOMRect>) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  morphTargets(section, collapsed).forEach((target, key) => {
    const from = first.get(key);
    if (!from || from.width === 0 || target.getBoundingClientRect().width === 0) return;
    const ghost = target.cloneNode(true) as HTMLElement;
    const style = getComputedStyle(target);
    Object.assign(ghost.style, {
      position: "fixed",
      left: "0",
      top: "0",
      margin: "0",
      zIndex: String(Z.modal + 1),
      pointerEvents: "none",
      transformOrigin: "left top",
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      fontVariantNumeric: style.fontVariantNumeric,
      color: style.color,
      textAlign: style.textAlign,
      whiteSpace: "nowrap",
    });
    ghost.style.setProperty("--usage-color", style.getPropertyValue("--usage-color"));
    document.body.appendChild(ghost);
    target.style.visibility = "hidden";
    // The menu is anchored by its bottom, so it moves while the open view
    // grows or shrinks: the copy chases where the real piece is *now*, every
    // frame, rather than where it was when the fold began.
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / MORPH_MS);
      const e = easeOutQuint(t);
      const to = target.getBoundingClientRect();
      const left = from.left + (to.left - from.left) * e;
      const top = from.top + (to.top - from.top) * e;
      // Text keeps its size and only travels; a bar also stretches to length.
      const width = key === "bar" ? from.width + (to.width - from.width) * e : to.width;
      ghost.style.width = `${width}px`;
      ghost.style.height = `${to.height}px`;
      ghost.style.transform = `translate(${left}px, ${top}px)`;
      if (t < 1 && ghost.isConnected) {
        requestAnimationFrame(step);
      } else {
        ghost.remove();
        target.style.visibility = "";
      }
    };
    requestAnimationFrame(step);
  });
}

function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

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
