// ProfileModal — a centered, SkillsModal-style overlay that surfaces
// "you, the person using this IDE" with the smallest possible surface:
// avatar + username + hostname + whether a workspace is active. Intentionally
// a *local* profile — no account stuff, no sign out, no actions. This is
// a desktop tool, not a web app.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Z } from "../zLayers";

type AppUserInfo = {
  username: string;
  hostname: string;
  homeDir: string;
};

type Props = {
  open: boolean;
  workspaceRoot: string | null;
  onClose: () => void;
};

/* ------------------------------------------------------------------ icons */

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/* ------------------------------------------------------------------ helpers */

function initialsOf(name: string): string {
  if (!name) return "?";
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ============================================================ the modal ===*/

export function ProfileModal({ open, workspaceRoot, onClose }: Props) {
  const [user, setUser] = useState<AppUserInfo | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const u = await invoke<AppUserInfo>("app_user_info");
        if (!cancelled) setUser(u);
      } catch {
        if (!cancelled) setUser({ username: "", hostname: "", homeDir: "" });
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const username = user?.username || "you";
  const hostname = user?.hostname || "";
  const hasWorkspace = Boolean(workspaceRoot);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Profile"
      onClick={onClose}
      className="skills-tab-in"
      style={{
        position: "fixed", inset: 0, zIndex: Z.modal,
        display: "grid", placeItems: "center",
        background: "var(--modal-scrim)",
        backdropFilter: "blur(3px)",
      }}
    >
      <div
        className="floating-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, calc(100vw - 80px))",
          borderRadius: "var(--radius-lg)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Centered hero — avatar + identity + workspace line. No
            sections, no lists, no actions. The point is to confirm
            "you, on this machine" with the smallest possible surface. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "22px 24px 18px",
            position: "relative",
          }}
        >
          <Avatar name={username} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-strong)", letterSpacing: "-0.014em" }}>
              {username}
              {hostname && (
                <span style={{ color: "var(--fg-dim)", fontSize: 12, fontWeight: 400, marginLeft: 8, fontFamily: "var(--font-mono)" }}>
                  · {hostname}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-subtle)", marginTop: 4, letterSpacing: "-0.005em" }}>
              {hasWorkspace
                ? <>Workspace open</>
                : <>No workspace open</>}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="klide-button klide-button-ghost"
            style={{ minHeight: 28, padding: "0 8px", color: "var(--fg-subtle)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}
          >
            <CloseIcon />
          </button>
        </div>

        <div
          style={{
            padding: "0 24px 16px",
            fontSize: 10.5,
            fontFamily: "var(--font-mono)",
            color: "var(--fg-dim)",
            letterSpacing: "0.04em",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>Klide · local</span>
          <span style={{ flex: 1 }} />
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ pieces ===*/

function Avatar({ name, size }: { name: string; size: number }) {
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
        width: size,
        height: size,
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
        position: "relative",
      }}
    >
      {initials}
      <span
        style={{
          position: "absolute",
          right: -1,
          bottom: -1,
          width: Math.max(8, size * 0.22),
          height: Math.max(8, size * 0.22),
          borderRadius: "50%",
          background: "var(--success)",
          border: `2px solid var(--bg-elevated)`,
        }}
      />
    </div>
  );
}
