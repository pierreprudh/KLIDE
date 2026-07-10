// Hover-revealed per-message action row. Quiet by design — icon-only chips,
// no toolbar chrome, no separators. The row fades in on hover of the
// enclosing bubble; the opacity transition lives on `.ai-msg-actions`.
//
// Visible chip set, per role:
//   assistant → Copy · Retry · Branch · Branch in worktree
//   user      → Edit · Copy · Retry · Branch · Branch in worktree · Delete
//
// Anything that would race with an in-flight run (Edit / Retry / Delete /
// Branch) is rendered disabled while `streaming` is true.

import { type MouseEventHandler, type ReactNode } from "react";

type ChipProps = {
  title: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  tone?: "default" | "danger";
  children: ReactNode;
};

function Chip({ title, onClick, disabled, tone = "default", children }: ChipProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        padding: 0,
        borderRadius: "var(--radius-sm)",
        border: "none",
        background: "transparent",
        color: disabled ? "var(--fg-dim)" : "var(--fg-subtle)",
        cursor: disabled ? "default" : "pointer",
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        // Highlight only the icon (color) — no container background box.
        e.currentTarget.style.color = tone === "danger" ? "var(--danger)" : "var(--fg-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--fg-subtle)";
      }}
    >
      {children}
    </button>
  );
}

const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
  </svg>
);

const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const RetryIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

const EditIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const BranchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="9" r="2.2" />
    <path d="M6 8.2v7.6" />
    <path d="M6 12h6a3 3 0 0 0 3-3v-.6" />
  </svg>
);

const WorktreeBranchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="9" r="2.2" />
    <path d="M6 8.2v7.6" />
    <path d="M6 12h6a3 3 0 0 0 3-3v-.6" />
    <path d="M15 18h6" />
    <path d="M18 15v6" />
  </svg>
);

const RevertIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </svg>
);

const TrashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

type Props = {
  role: "user" | "assistant";
  copied: boolean;
  disabled?: boolean;
  onCopy: () => void;
  onRetry: () => void;
  onBranch: () => void;
  onBranchInWorktree?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Run outcome, shown right-aligned in the same row on the final answer:
   *  "N files changed · Revert". Lives here instead of as its own strip so
   *  the conversation ends with one quiet meta row, not three. */
  revert?: { files: number; busy: boolean; onRevert: () => void };
};

export function MessageActions({
  role,
  copied,
  disabled = false,
  onCopy,
  onRetry,
  onBranch,
  onBranchInWorktree,
  onEdit,
  onDelete,
  revert,
}: Props) {
  return (
    <div
      className="ai-msg-actions"
      style={{
        marginTop: 6,
        display: "flex",
        alignItems: "center",
        gap: 2,
        height: 22,
      }}
    >
      {role === "user" && (
        <Chip title="Edit and resend" onClick={() => onEdit?.()} disabled={disabled}>
          <EditIcon />
        </Chip>
      )}
      <Chip title={copied ? "Copied" : "Copy message"} onClick={onCopy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Chip>
      <Chip title="Retry from here" onClick={onRetry} disabled={disabled}>
        <RetryIcon />
      </Chip>
      <Chip title="Branch into a new chat" onClick={onBranch} disabled={disabled}>
        <BranchIcon />
      </Chip>
      {onBranchInWorktree && (
        <Chip title="Branch into a new worktree" onClick={onBranchInWorktree} disabled={disabled}>
          <WorktreeBranchIcon />
        </Chip>
      )}
      {role === "user" && onDelete && (
        <Chip
          title="Delete this message and everything after"
          onClick={onDelete}
          disabled={disabled}
          tone="danger"
        >
          <TrashIcon />
        </Chip>
      )}
      {revert && revert.files > 0 && (
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--fg-dim)",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ opacity: revert.busy ? 0.6 : 1 }}>
            {revert.files} file{revert.files === 1 ? "" : "s"} changed
          </span>
          <Chip
            title={
              revert.busy
                ? "Reverting…"
                : "Undo every file change this run made"
            }
            onClick={revert.onRevert}
            disabled={revert.busy}
            tone="danger"
          >
            <RevertIcon />
          </Chip>
        </span>
      )}
    </div>
  );
}
