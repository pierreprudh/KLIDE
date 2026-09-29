// Compact account popover above the bottom edge of the workspace.
import { useEffect, useRef } from "react";
import { AccountControl } from "./settings/accounts";
import { GitHubAccountRow } from "./GitHubAccountRow";
import { Z } from "../zLayers";
import { initialsOf, useUserInfo } from "../hooks/useUserInfo";
import "./profileMenu.css";

type Props = {
  open: boolean;
  workspaceRoot: string | null;
  onClose: () => void;
};

export function ProfileModal({ open, onClose }: Props) {
  const { username, avatarUrl } = useUserInfo();
  const menuRef = useRef<HTMLDivElement>(null);

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
          <AccountControl provider="codex" title="Codex" connected={false} compact />
          <AccountControl provider="claude-code" title="Claude Code" connected={false} compact />
          <AccountControl provider="opencode" title="OpenCode" connected={false} compact />
        </div>
      </div>
    </div>
  );
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
