// Delegate CLI accounts — identity display + the account snapshot switcher
// (save the current login / activate a saved one) for subscription CLIs.
// Extracted from SettingsPanel.tsx.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Z } from "../../zLayers";
import { ChevronDown } from "../ai/icons";
import { LinkButton } from "./controls";

// Account snapshots (mirrors `accounts::Account*` serde camelCase output).
export type AccountIdentity = {
  authMode?: string;
  accountId?: string;
  keyFingerprint?: string;
  email?: string;
  detail?: string;
};
export type AccountRow = {
  name: string;
  savedMs: number;
  identity: AccountIdentity;
  active: boolean;
};
export type AccountsView = {
  provider: string;
  accounts: AccountRow[];
  currentUnsaved?: AccountIdentity;
  present: boolean;
};

// A short human label for a login: "email · detail" when an email is known,
// "API key ••fingerprint" for key-based logins, else the detail/auth mode.
export function identityLabel(id: AccountIdentity): string {
  if (id.email) return id.detail ? `${id.email} · ${id.detail}` : id.email;
  if (id.keyFingerprint) return `API key ••${id.keyFingerprint.slice(0, 4)}`;
  return id.detail || id.authMode || "Unrecognised login";
}

// A line icon for an account, picked from its name so "work" vs "home/personal"
// read at a glance — no color dot. Falls back to a neutral person. Stroke style
// matches the rest of the app's icons (24-grid, round caps, currentColor).
export function AccountIcon({ name, size = 15 }: { name: string; size?: number }) {
  const n = name.toLowerCase();
  const glyph = /(work|job|office|corp|company|client)/.test(n) ? (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ) : /(home|personal|perso|me|self|side)/.test(n) ? (
    <>
      <path d="M3 10.5 12 4l9 6.5" />
      <path d="M5 10v10h14V10" />
    </>
  ) : (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-3.5 3.6-5.5 8-5.5s8 2 8 5.5" />
    </>
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {glyph}
    </svg>
  );
}

// One provider's account switcher, inline in its connection row: a compact
// pill showing the active account that opens a menu to switch between saved
// accounts or snapshot the current login. Self-contained — loads its own view.
export function AccountControl({
  provider,
  title,
  connected,
}: {
  provider: string;
  title: string;
  connected: boolean;
}) {
  const [view, setView] = useState<AccountsView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // name being activated
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string | null>(null); // inline save name
  const [err, setErr] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Anchor rect captured when the menu opens, so the portalled menu can be
  // fixed-positioned over everything (it would otherwise be clipped by the
  // settings panel's own overflow / stacking context).
  const [rect, setRect] = useState<DOMRect | null>(null);

  async function refresh() {
    try {
      setView(await invoke<AccountsView>("accounts_list", { provider }));
    } catch {
      setView(null);
    }
  }

  async function activate(name: string) {
    setBusy(name);
    setErr(null);
    try {
      await invoke("account_activate", { provider, name });
      await refresh();
      setOpen(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function save(rawName: string) {
    const name = rawName.trim();
    if (!name) return;
    setSaving(true);
    setErr(null);
    try {
      await invoke("account_save_current", { provider, name });
      setDraft(null);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const accounts = view?.accounts ?? [];
  const active = accounts.find((a) => a.active);
  const unsaved = view?.currentUnsaved;
  const claudeNote = provider === "claude-code";

  // Trigger label: active account name, else the unsaved login, else a prompt.
  const triggerLabel = active
    ? active.name
    : unsaved
    ? identityLabel(unsaved)
    : connected
    ? "Save login"
    : "Not connected";

  function openMenu() {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen(true);
  }
  function closeMenu() {
    setOpen(false);
    setDraft(null);
    setErr(null);
  }

  const menuItemBase: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    textAlign: "left",
    padding: "7px 10px",
    borderRadius: "var(--radius-sm)",
    border: "none",
    background: "transparent",
    color: "var(--fg)",
  };

  const menuWidth = 280;

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? closeMenu() : openMenu())}
        disabled={!connected && accounts.length === 0}
        title={active ? identityLabel(active.identity) : triggerLabel}
        className="klide-button klide-button-secondary"
        style={{
          height: 32,
          maxWidth: 220,
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 10px",
          opacity: !connected && accounts.length === 0 ? 0.55 : 1,
        }}
      >
        {active && <AccountIcon name={active.name} size={14} />}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 170,
            fontWeight: active ? 600 : 500,
          }}
        >
          {triggerLabel}
        </span>
        <ChevronDown />
      </button>

      {open && rect &&
        createPortal(
          <>
            <div onMouseDown={closeMenu} style={{ position: "fixed", inset: 0, zIndex: Z.contextMenu }} />
            <div
              className="klide-surface"
              style={{
                position: "fixed",
                top: rect.bottom + 6,
                left: Math.max(8, rect.right - menuWidth),
                zIndex: Z.contextMenu + 1,
                width: menuWidth,
                padding: 6,
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--panel-shadow)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
            {accounts.length === 0 && !unsaved && (
              <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--fg-dim)" }}>
                {connected ? "No saved accounts yet." : `${title} isn't logged in.`}
              </div>
            )}

            {accounts.map((acc) => (
              <button
                key={acc.name}
                type="button"
                onClick={() => !acc.active && void activate(acc.name)}
                disabled={busy !== null}
                style={{
                  ...menuItemBase,
                  background: acc.active ? "var(--bg-hover)" : "transparent",
                  cursor: acc.active || busy ? "default" : "pointer",
                }}
                onMouseEnter={(e) => { if (!acc.active && !busy) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!acc.active) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ flexShrink: 0, display: "flex", color: "var(--fg-dim)" }}>
                  <AccountIcon name={acc.name} size={16} />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {acc.name}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {identityLabel(acc.identity)}
                  </div>
                </span>
                {busy === acc.name ? (
                  <span style={{ fontSize: 11, color: "var(--fg-dim)", flexShrink: 0 }}>switching…</span>
                ) : acc.active ? (
                  <span style={{ fontSize: 10.5, color: "var(--fg-subtle)", flexShrink: 0 }}>active</span>
                ) : null}
              </button>
            ))}

            {(accounts.length > 0 || unsaved) && (
              <div style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} />
            )}

            {draft !== null ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px" }}>
                <input
                  autoFocus
                  value={draft}
                  placeholder={unsaved ? "Name this login" : "e.g. work, personal"}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save(draft);
                    if (e.key === "Escape") setDraft(null);
                  }}
                  aria-label={`New ${title} account name`}
                  autoComplete="off"
                  spellCheck={false}
                  className="klide-field"
                  style={{ flex: 1, minWidth: 0, height: 32, padding: "0 10px", fontSize: 12.5 }}
                />
                <LinkButton onClick={() => void save(draft)} disabled={saving || !draft.trim()}>
                  {saving ? "…" : "Save"}
                </LinkButton>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setDraft(""); setErr(null); }}
                disabled={!connected}
                style={{
                  ...menuItemBase,
                  cursor: connected ? "pointer" : "not-allowed",
                  color: connected ? "var(--fg)" : "var(--fg-subtle)",
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
                onMouseEnter={(e) => { if (connected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ width: 14, flexShrink: 0, color: "var(--fg-dim)" }}>＋</span>
                {unsaved ? "Save current login as…" : "Save current login…"}
              </button>
            )}

            {claudeNote && draft !== null && (
              <div style={{ padding: "2px 12px 6px", fontSize: 10.5, color: "var(--fg-subtle)", lineHeight: 1.4 }}>
                Reads Claude Code's keychain — you may see a one-time macOS prompt.
              </div>
            )}

            {err && (
              <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--danger)", lineHeight: 1.4 }}>
                {err}
              </div>
            )}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

