// FocusMode — Klide's chat-first workspace, blending the project/thread
// command-centre pattern with an artifact-first agent home. A quiet left rail
// groups conversations by project; the main canvas pairs a centered start /
// resume stage with a persistent bottom composer. A live conversation reuses
// the fully-wired AiPanel in its fullscreen "focus" design variant — centered
// reading column, roomier type — passed in via `renderChat`.
//
// Identity rules honoured here: bone surfaces, hairline borders, sage accent
// only, no chips/pills/status dots. Motion is choreography, not decoration:
// the rail settles from its hairline, hero elements and task cards arrive in
// short beats, the composer springs up once, and home ⇄ chat crossfades as one
// surface. All of it collapses under prefers-reduced-motion.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  listProviderModels,
  modelReflectionLevels as queryModelReflectionLevels,
  modelSupportsTools as queryModelSupportsTools,
  modelSupportsVision as queryModelSupportsVision,
  readLocalProviderStatus,
  readProviderKeyStatus,
  startLocalProvider,
} from "../ipc/aiProviders";
import {
  reflectionBarLevel,
  reflectionCaption,
  sortReflectionLevels,
} from "../reflectionLevels";
import { Z } from "../zLayers";
import {
  AttachIcon,
  GitIcon,
  SendIcon,
} from "../icons";
// The rail itself is the host's now (App.tsx renders the app's one instance);
// these two are pure helpers Focus's hero shares with it.
import { railProjectRoots, retrievableConversation } from "./WorkspaceRail";
import { useUserInfo, initialsOf } from "../hooks/useUserInfo";
import { usePortalMenu } from "../hooks/usePortalMenu";
import { useCustomProviders } from "../hooks/useCustomProviders";
import {
  CONVERSATIONS_CHANGED_EVENT,
  loadConversations,
} from "./ai/storedConversations";
import { relativeTime, isSubsequence } from "./ai/utils";
import type { Conversation } from "./ai/types";
import type { AgentAttachment as Attachment, AgentMode, ProviderId } from "../agent/types";
import { stageFiles, stagedImageBytes } from "./ai/attachments";
import { AttachmentTray } from "./ai/AttachmentTray";
import { SlashMenu } from "./ai/SlashMenu";
import {
  EXPLAIN_PREFIX,
  SLASH_DESC,
  SLASH_PROMPTS,
  currentModeText,
  filterSlashCommands,
  slashKeyAction,
  slashQueryOf,
  stepSlashIndex,
  type SlashCommand,
} from "./ai/slashCommands";
import { notify } from "../toast";
import { GOAL_POLICIES, MODE_CHOICES, effectiveMode as effectiveModeFor, goalPolicyOf } from "./ai/autonomyLadder";
import {
  PROVIDER_GROUPS,
  defaultModelForProvider,
  isDelegateProvider,
  isManagedLocalProvider,
  normalizeAgentMode,
  providerGroupsWithCustom,
  providerName,
  providerNeedsApiKey,
} from "../agent/providers";
import { isCustomProvider, type CustomProvider } from "../customProviders";
import { ModelPicker } from "./ai/ModelPicker";
import { KlideMark, ProviderLogo } from "./ai/icons";
import { conversationMark } from "../modelIdentity";
import {
  canonicalWorkspaceRoot,
  linkedProjectForPath,
} from "../projectPaths";
import { listWorkspaceFiles } from "./ai/workspaceFiles";
import { FocusGitIsland } from "./FocusGitIsland";

type Props = {
  workspaceRoot: string | null;
  branch: string | null;
  gitChangeCount: number;
  gitRefreshToken: string;
  /** Recent project roots (the same list the activity-bar popover shows). */
  projects: string[];
  chatActive: boolean;
  /** Back to the hero home — the next submit starts a fresh conversation. */
  onNewChat: () => void;
  /** Resume a saved conversation in the same live Focus chat surface. */
  onOpenConversation: (convo: Conversation) => void;
  onSubmit: FocusSubmit;
  /** The apology the canvas shows in place of a conversation local history no
   *  longer holds. The host owns it because the sidebar that navigates there
   *  is the host's. */
  conversationOpenError: { title: string } | null;
  /** A hero resume card pointed at a conversation that is gone. */
  onConversationUnavailable: (convo: Conversation) => void;
  /** Drop the apology and any rail selection — the way back to the hero. */
  onClearConversationNavigation: () => void;
  /** The rail's shared destinations — the same handler the free-mode activity
   *  bar calls, so Focus opens the identical Git view / Memory / Skills /
   *  Settings / Profile surfaces instead of parallel ones. */
  onOpenPanel: (panel: "git" | "memory" | "skills" | "settings" | "profile" | "orchestrator") => void;
  /** Open Settings straight on one section. The composer's provider picker
   *  sends keyless providers to "api" (API keys) instead of dead-ending on a
   *  row you can't run. */
  onOpenSettingsSection: (section: string) => void;
  renderChat: () => ReactNode;
  /** Terminal — the native shell docked under the canvas. It stands beneath the
   *  home/chat surface rather than replacing it, so the conversation keeps its
   *  mount (run subscriptions are mount-tied) and keeps streaming while you
   *  work in the shell. One shell app-wide: the same PTY the workbench drawer
   *  shows, at the same remembered height, so opening it here doesn't start a
   *  second one. The parent renders the whole dock; this is the slot. */
  renderTerminal: () => ReactNode;
  /** Composer run settings — the same per-panel / per-model state the AI
   *  panel and Settings read (provider → model → effort → context). */
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  model: string;
  onModelChange: (model: string) => void;
  effort: string | undefined;
  onEffortChange: (effort: string | undefined) => void;
  contextWindow: number | undefined;
  onContextWindowChange: (window: number | undefined) => void;
  requireDiffReview: boolean;
  onRequireDiffReviewChange: (required: boolean) => void;
  autoApproveCommands: boolean;
  onAutoApproveCommandsChange: (enabled: boolean) => void;
};

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/* ------------------------------------------------------------------ icons */

const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/* ----------------------------------------------------------------- screen */

export function FocusMode({
  workspaceRoot,
  branch,
  gitChangeCount,
  gitRefreshToken,
  projects,
  chatActive,
  onNewChat,
  onOpenConversation,
  onSubmit,
  conversationOpenError,
  onConversationUnavailable,
  onClearConversationNavigation,
  onOpenPanel,
  onOpenSettingsSection,
  renderChat,
  renderTerminal,
  provider,
  onProviderChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  contextWindow,
  onContextWindowChange,
  requireDiffReview,
  onRequireDiffReviewChange,
  autoApproveCommands,
  onAutoApproveCommandsChange,
}: Props) {
  // Conversation groups + the hero footer name self-hosted endpoints through
  // providerName(); subscribing keeps those labels live across a rename.
  useCustomProviders();
  const activeProjectRoot = canonicalWorkspaceRoot(workspaceRoot);
  // The same roots the rail lists — the hero's recents have to be drawn from
  // the project the rail says is open, not from a second reading of `projects`.
  const focusProjects = useMemo(
    () => railProjectRoots(projects, activeProjectRoot),
    [activeProjectRoot, projects],
  );

  const { username, avatarUrl } = useUserInfo();
  // Bumped when the composer strip's branch is clicked, so the git island can
  // pulse. A counter rather than a boolean: every click has to land, including
  // two in a row, and the island only cares that the value moved.
  const [gitPing, setGitPing] = useState(0);

  // The hero's "Continue where you left off" needs this project's recents. The
  // rail keeps its own copy for the tree — one read each, both from the same
  // durable index, rather than threading the rail's internals back out here.
  const [convos, setConvos] = useState<Conversation[]>(
    () => loadConversations<Conversation>(),
  );

  // Same-window localStorage writes do not emit the browser's `storage` event.
  // AiPanel publishes this focused index event after the first durable
  // snapshot, so a brand-new conversation reaches the hero while Focus stays
  // mounted. Leaving the chat reloads too, as a defensive fallback.
  useEffect(() => {
    const reload = () => setConvos(loadConversations<Conversation>());
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
  }, []);
  useEffect(() => {
    setConvos(loadConversations<Conversation>());
  }, [chatActive]);

  const projectName = activeProjectRoot ? basename(activeProjectRoot) : null;
  const projectConvos = useMemo(() => {
    if (!activeProjectRoot) return [];
    return convos
      .filter((c) => linkedProjectForPath(c.cwd, focusProjects) === activeProjectRoot)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [activeProjectRoot, convos, focusProjects]);
  // The dispatch settings the composer edits, wherever it is mounted. Both the
  // start stage and the live Focus chat read and write this same set.
  const composerControls = useMemo<FocusComposerControls>(
    () => ({
      workspaceRoot,
      provider,
      onProviderChange,
      model,
      onModelChange,
      effort,
      onEffortChange,
      contextWindow,
      onContextWindowChange,
      requireDiffReview,
      onRequireDiffReviewChange,
      autoApproveCommands,
      onAutoApproveCommandsChange,
      onOpenSettingsSection,
    }),
    [
      workspaceRoot,
      provider,
      onProviderChange,
      model,
      onModelChange,
      effort,
      onEffortChange,
      contextWindow,
      onContextWindowChange,
      requireDiffReview,
      onRequireDiffReviewChange,
      autoApproveCommands,
      onAutoApproveCommandsChange,
      onOpenSettingsSection,
    ]
  );
  /** Open a conversation from the hero's resume cards. The rail resolves its
   *  own rows; this is the same guard for the cards, which read the same
   *  possibly-stale snapshot. */
  function openHistoryConversation(conversation: Conversation) {
    const resolved = retrievableConversation(
      conversation.id,
      loadConversations<Conversation>(),
    );
    if (!resolved) {
      onConversationUnavailable(conversation);
      return;
    }
    onOpenConversation(resolved);
  }

  // The rows above the tree. Focus opens surfaces; it has no floating panels of
  // its own, so it lists no panel tools — that is the one place the two shells'
  // rails legitimately differ, and it is a difference in this array, not in two
  // components. Everything both shells *can* reach sits in the same slot in
  // both, so the rail does not rearrange itself when you switch layouts.

  return (
    <div className="klide-focus-shell">
      {/* No rail here. The host renders the app's one sidebar for every
          surface (App.tsx) — Focus drawing its own copy meant a mode change
          unmounted one rail and mounted another, which replayed its entrance
          animation and lost the tree's state. Focus supplies its own `nav`,
          its own conversation handlers and its own foot controls from up
          there; this shell is the canvas beside it. */}

      {/* ── Canvas ────────────────────────────────────────────────── */}
      {/* Its top inset is the title-bar band, so that strip drags the window
          too — the canvas below it keeps its own clicks. */}
      <main className="klide-focus-main" data-tauri-drag-region>
        {workspaceRoot && !chatActive && !conversationOpenError ? (
          <FocusGitIsland
            workspaceRoot={workspaceRoot}
            branch={branch}
            changeCount={gitChangeCount}
            avatarUrl={avatarUrl}
            profileInitials={initialsOf(username || "?")}
            refreshToken={gitRefreshToken}
            pingToken={gitPing}
            onOpen={() => onOpenPanel("git")}
          />
        ) : null}
        <div className="klide-focus-current-surface">
        {conversationOpenError ? (
          <ConversationRetrievalError
            title={conversationOpenError.title}
            onBack={() => {
              onClearConversationNavigation();
              onNewChat();
            }}
          />
        ) : chatActive ? (
          <div
            className="klide-focus-chat-in"
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* A race renders with no chrome of its own here: the racers sit
                side by side in `renderChat`, and everything race-wide — the
                shared composer, the way out — lives in the floating pilot box
                the parent draws over the split. */}
            {renderChat()}
          </div>
        ) : (
          <FocusHome
            projectName={projectName}
            branch={branch}
            onPingGit={() => setGitPing((n) => n + 1)}
            // Four: `.klide-focus-card-grid` is a four-column grid that the
            // starter set fills, so three resume cards left a hole in the row.
            recent={projectConvos.slice(0, 4)}
            onOpenConversation={openHistoryConversation}
            onSubmit={onSubmit}
            controls={composerControls}
          />
        )}
        </div>
        {/* Terminal — a bottom dock under the canvas, not a replacement for it:
            the conversation (or the home hero) stays put above and keeps its
            mount, so a running turn is never interrupted by reaching for a
            shell. The parent owns the whole dock — height, drag handle, slide —
            because the drawer's height is remembered app-wide; this is only
            the slot it lands in. */}
        {renderTerminal()}
      </main>
    </div>
  );
}

function ConversationRetrievalError({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <section
      className="klide-focus-conversation-error"
      aria-labelledby="klide-focus-conversation-error-title"
    >
      <pre aria-hidden="true">{String.raw`       .--------.
      /        /|
     +--------+ |
     |  404   | |
     |  ...   | /
     +--------+`}</pre>
      <h1 id="klide-focus-conversation-error-title">Conversation unavailable</h1>
      <p>
        <span>“{title}”</span> is no longer in local history. It may have been
        removed, or its saved record may be damaged.
      </p>
      <button type="button" onClick={onBack}>Back to new task</button>
    </section>
  );
}

/* ------------------------------------------------------------ inline menu */

type MenuOption = {
  label: string;
  value: string | number | undefined;
  /** Non-clickable section eyebrow inside the menu (provider groups). */
  heading?: boolean;
  /** Per-row mark, in the ModelPicker idiom (provider logo, effort bars). */
  icon?: ReactNode;
  /** Quiet second line under the label. */
  caption?: string;
  /** Quiet the row (or a whole stack's eyebrow): it exists but isn't usable
   *  yet — a provider with no API key resolved, for instance. */
  dimmed?: boolean;
  /** Turns the row into a way out instead of a choice: it grows a trailing ↗
   *  and clicking anywhere on it runs this rather than selecting the value.
   *  Focus uses it to send keyless providers to Settings → API keys. */
  resolve?: { title: string; run: () => void };
};

/** Reasoning-effort glyph — the AI panel's reflection-bars language: five
 *  bars, filled up to the chosen level; Auto shows them all at rest. */
function EffortBars({ level, size = 16 }: { level: number; size?: number }) {
  const heights = [5, 7, 9, 11, 13];
  return (
    <svg width={size} height={size * 0.875} viewBox="0 0 16 14" aria-hidden>
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * 3 + 0.5}
          y={13.5 - h}
          width="2"
          height={h}
          rx="1"
          fill="currentColor"
          opacity={level > 0 && i < level ? 0.9 : 0.28}
        />
      ))}
    </svg>
  );
}

/** The "this leads out of here" mark — a small arrow to the top-right, the
 *  same stroke language as the rail glyphs. Sits at the end of a menu row that
 *  opens Settings instead of selecting a value. */
function ArrowUpRightIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

/** Context-window glyph — a simple gauge arc in the same stroke language. */
function ContextGaugeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M5 17a8 8 0 1 1 14 0" />
      <path d="M12 13l3.5-3.5" />
    </svg>
  );
}

/** A flat text trigger opening the AI panel's picker surface — the same
 *  design as the ModelPicker dropdown: glass card, framed-icon header with a
 *  caption, hairline dividers, icon rows with the accent-tint active state.
 *  Portalled to <body> so no ancestor clip can swallow it. */
function InlineMenu({
  label,
  display,
  options,
  selected,
  onSelect,
  mono = false,
  leading,
  header,
  width = 236,
  variant = "text",
  ringRatio = 0,
}: {
  label: string;
  display: string;
  options: MenuOption[];
  selected: string | number | undefined;
  onSelect: (value: string | number | undefined) => void;
  mono?: boolean;
  /** Optional glyph before the value (the provider trigger's logo). */
  leading?: ReactNode;
  /** The picker header: framed icon + title + quiet caption. Omit it when the
   *  trigger already names what the menu is — the provider picker opens right
   *  under a logo and a provider name, so a "Provider / where this runs" block
   *  is a sentence you've already read. Skipping it also lets the glass show
   *  through the whole card instead of being capped by a tinted bar. */
  header?: { icon: ReactNode; title: string; caption: string };
  width?: number;
  /** "ring" renders the AI panel's context-meter circle as the trigger —
   *  28px round button, border track ring, accent arc — instead of text.
   *  `ringRatio` (0..1) drives the arc; the panel floors it at 2 so the glyph
   *  always reads as a meter.
   *
   *  **A ring means "this much of the window is used".** The context-window
   *  menu used to render one from `contextWindow / 131072` — the size the user
   *  had *chosen*, divided by the largest option. Picking 128K read as 100%
   *  full, 32K as 25%, and the default "Auto" sat on the 2% floor forever,
   *  while the visually identical ring in the AI panel showed real measured
   *  usage. There is no usage to show on the start stage — no conversation
   *  exists yet — so a setting gets a label, not a gauge. Only pass `ringRatio`
   *  a measured fraction. */
  variant?: "text" | "ring";
  ringRatio?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Portalled to <body> (fixed, measured from the trigger) so it escapes the
  // composer card's `overflow: hidden` clip — the same reason the AI panel
  // portals its ModelPicker and mode menus.
  const [menuPos, setMenuPos] = useState<{ bottom: number; left: number } | null>(null);

  function toggleMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - width - 8));
    setMenuPos({ bottom: Math.round(window.innerHeight - r.top + 8), left });
    setFocusIdx(-1);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasIcons = options.some((o) => !o.heading && o.icon);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", minWidth: 0 }}>
      {variant === "ring" ? (
        /* The AI panel's context-meter circle, verbatim: 28px round button,
           `--border` track ring, accent arc floored at 2% so the glyph
           always reads as a meter. */
        <button
          type="button"
          onClick={toggleMenu}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-label={`${label} — ${display}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={`${label} · ${display}`}
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            border: "none",
            borderRadius: "50%",
            background: open || hover ? "var(--bg-hover)" : "transparent",
            color: "var(--accent)",
            cursor: "pointer",
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-med) var(--ease-out)",
          }}
        >
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="7.5" fill="none" stroke="var(--border)" strokeWidth="1.6" />
            <circle
              cx="11"
              cy="11"
              r="7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              pathLength="100"
              strokeDasharray={`${Math.max(2, Math.round(ringRatio * 100))} 100`}
              transform="rotate(-90 11 11)"
              style={{
                transition:
                  "stroke-dasharray var(--motion-med) var(--ease-out), stroke var(--motion-med) var(--ease-out)",
              }}
            />
          </svg>
        </button>
      ) : (
      <button
        type="button"
        onClick={toggleMenu}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 24,
          border: "1px solid transparent",
          background: open ? "var(--bg-hover)" : "transparent",
          padding: "0 5px",
          borderRadius: "var(--radius-sm)",
          fontSize: 11,
          fontWeight: 500,
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          color: open || hover ? "var(--fg-strong)" : "var(--fg-subtle)",
          cursor: "pointer",
          minWidth: 0,
          transition:
            "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
      >
        {leading && <span style={{ display: "flex", flexShrink: 0 }}>{leading}</span>}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 170,
          }}
        >
          {display}
        </span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{
            flexShrink: 0,
            color: "var(--fg-dim)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform var(--motion-fast) var(--ease-out)",
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      )}
      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="popover-enter menu-glass"
          style={{
            position: "fixed",
            bottom: menuPos.bottom,
            left: menuPos.left,
            width,
            maxHeight: 340,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: Z.popover,
          }}
        >
          {/* Header — same frame as the ModelPicker's: a bordered icon tile,
              the menu's name, and a quiet caption. Menus whose trigger already
              names them go without, and open straight onto their options. */}
          {header && (
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "10px 12px 9px",
              borderBottom: "1px solid var(--panel-border)",
              background: "color-mix(in srgb, var(--panel-highlight) 30%, transparent)",
            }}
          >
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 26,
                height: 26,
                borderRadius: 8,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                color: "var(--fg-subtle)",
                flexShrink: 0,
              }}
            >
              {header.icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--fg-strong)",
                  letterSpacing: "-0.005em",
                }}
              >
                {header.title}
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 1 }}>
                {header.caption}
              </div>
            </div>
          </div>
          )}
          <div className="menu-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 5 }}>
            {options.map((o, idx) => {
              if (o.heading) {
                return (
                  <div
                    key={`h-${o.label}`}
                    style={{
                      padding: "7px 9px 3px",
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      color: "var(--fg-dim)",
                      opacity: o.dimmed ? 0.5 : 1,
                    }}
                  >
                    {o.label}
                  </div>
                );
              }
              const active = o.value === selected;
              const focused = idx === focusIdx;
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  role="option"
                  aria-selected={active}
                  title={o.resolve?.title}
                  onClick={() => {
                    setOpen(false);
                    if (o.resolve) {
                      o.resolve.run();
                      return;
                    }
                    onSelect(o.value);
                  }}
                  onMouseEnter={() => setFocusIdx(idx)}
                  onMouseLeave={() => setFocusIdx((i) => (i === idx ? -1 : i))}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "7px 9px",
                    border: "none",
                    borderRadius: "var(--radius-sm)",
                    background: active
                      ? "var(--menu-row-active)"
                      : focused
                        ? "var(--menu-row-hover)"
                        : "transparent",
                    color: "var(--fg-strong)",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "background var(--motion-fast) var(--ease-out)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {hasIcons && (
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          flexShrink: 0,
                          display: "grid",
                          placeItems: "center",
                          color: "var(--fg-subtle)",
                          opacity: o.dimmed ? 0.4 : 1,
                          transition: "opacity var(--motion-fast) var(--ease-out)",
                        }}
                      >
                        {o.icon}
                      </span>
                    )}
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                        fontWeight: active ? 550 : 500,
                        fontFamily: mono ? "var(--font-mono)" : "inherit",
                        opacity: o.dimmed ? 0.45 : 1,
                        transition: "opacity var(--motion-fast) var(--ease-out)",
                      }}
                    >
                      {o.label}
                    </span>
                    {o.resolve && (
                      <span
                        className="menu-leadout"
                        style={{ flexShrink: 0, display: "grid", placeItems: "center" }}
                      >
                        <ArrowUpRightIcon />
                      </span>
                    )}
                  </div>
                  {o.caption && (
                    <div
                      style={{
                        marginTop: 2,
                        marginLeft: hasIcons ? 26 : 0,
                        fontSize: 10,
                        color: "var(--fg-dim)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {o.caption}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Providers the hero can start a conversation on — the same groups the AI
// panel's picker shows, minus the not-yet-available rows. Each row carries
// its provider mark, ModelPicker-style.
//
// `custom` adds the "Self-hosted" stack, so an endpoint configured in Settings
// can start a Focus conversation without going through a standard AI panel
// first. Those rows are never quieted: a self-hosted endpoint may need no auth
// at all, and the ones that do resolve a `${VAR}` reference outside the
// keychain — "no key" there is not the same signal it is for a hosted API.
//
// A provider in `keyless` has no key Rust can resolve, so it can't run: the row
// is quieted and routes to Settings → API keys instead of being selectable, and
// a stack whose every row is keyless is quieted along with them.
export function buildProviderOptions(
  custom: CustomProvider[],
  keyless: ReadonlySet<string>,
  onOpenKeySettings: () => void,
): MenuOption[] {
  return providerGroupsWithCustom(custom).flatMap((group) => {
    // Delegate CLIs belong here too. They run on the subscription you already
    // pay for — no API key anywhere in Klide — and the canvas mounts their
    // session instead of a message list, which is a different surface but the
    // same conversation. They are never quieted: a delegate authenticates
    // through its own login, so `keyless` has nothing to say about it.
    const items = group.items.filter((item) => item.available);
    if (items.length === 0) return [];
    const rows: MenuOption[] = items.map((item) => {
      // A delegate is exempt by construction, not by luck: it authenticates
      // through its own CLI login, so "no API key" is not a statement about it.
      const missingKey =
        keyless.has(item.id) && !isCustomProvider(item.id) && !isDelegateProvider(item.id);
      return {
        label: item.name,
        value: item.id,
        icon: <ProviderLogo id={item.id} size={17} />,
        dimmed: missingKey,
        // No caption: the quieted row plus its ↗ already say "not set up, and
        // here's the way out". A sentence under every hosted provider would
        // turn a glance into a read.
        resolve: missingKey
          ? { title: `${item.name} has no API key — open Settings`, run: onOpenKeySettings }
          : undefined,
      };
    });
    return [
      {
        label: group.label,
        value: `__heading_${group.label}`,
        heading: true,
        dimmed: rows.every((row) => row.dimmed),
      },
      ...rows,
    ];
  });
}

/** Hosted providers offered in the picker — the rows worth probing for a key. */
const KEYED_PROVIDERS = PROVIDER_GROUPS.flatMap((group) => group.items).filter(
  (item) => item.available && providerNeedsApiKey(item.id),
);

/** The effort menu for one model's own set of levels. The set is a backend
 *  fact (see `src/reflectionLevels.ts`) — Codex publishes a different one per
 *  model — so the rows are built per pair, never from a fixed table. */
function effortOptionsFor(levels: readonly string[]): MenuOption[] {
  return [
    {
      label: "Auto",
      value: undefined,
      caption: "The model's own default",
      icon: <EffortBars level={0} />,
    },
    ...levels.map((level) => ({
      label: level,
      value: level,
      caption: reflectionCaption(level),
      icon: <EffortBars level={reflectionBarLevel(level, levels)} />,
    })),
  ];
}

const CONTEXT_OPTIONS: MenuOption[] = [
  { label: "Auto", value: undefined, caption: "Detected from the model" },
  { label: "8K", value: 8192 },
  { label: "16K", value: 16384 },
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
];

function contextLabel(window: number | undefined): string {
  if (window === undefined) return "auto ctx";
  return `${Math.round(window / 1024)}K ctx`;
}

/* ------------------------------------------------------------------- home */

type StarterKind = "explore" | "build" | "review" | "fix" | "resume";

const STARTERS: { title: string; sub: string; prompt: string; kind: StarterKind }[] = [
  {
    title: "Explore the codebase",
    sub: "Understand the architecture and key decisions",
    prompt: "Give me a tour of this codebase: the structure, the key modules, and how they fit together.",
    kind: "explore",
  },
  {
    title: "Build a feature",
    sub: "Turn an idea into a working implementation",
    prompt: "Help me build a feature. Start by asking what outcome I want, then inspect the codebase and propose a focused implementation.",
    kind: "build",
  },
  {
    title: "Review changes",
    sub: "Find risks and improvements before commit",
    prompt: "Review my uncommitted changes and point out bugs, risks, and cleanups before I commit.",
    kind: "review",
  },
  {
    title: "Fix a problem",
    sub: "Diagnose a bug, failure, or regression",
    prompt: "Help me diagnose and fix a problem. Ask for the symptoms, reproduce it, and propose the smallest reliable fix.",
    kind: "fix",
  },
];

function StarterIcon({ kind }: { kind: StarterKind }) {
  if (kind === "build") {
    return (
      <svg {...iconProps} width={17} height={17}>
        <path d="m14 4 6 6-10 10H4v-6z" />
        <path d="m12 6 6 6" />
      </svg>
    );
  }
  if (kind === "review") {
    return (
      <svg {...iconProps} width={17} height={17}>
        <path d="M4 5h10" />
        <path d="M4 10h8" />
        <path d="M4 15h6" />
        <path d="m15 16 2 2 4-5" />
      </svg>
    );
  }
  if (kind === "fix") {
    return (
      <svg {...iconProps} width={17} height={17}>
        <path d="m14 6 4-4 4 4-4 4" />
        <path d="M18 6h-7a7 7 0 1 0 7 7" />
      </svg>
    );
  }
  if (kind === "resume") {
    return (
      <svg {...iconProps} width={17} height={17}>
        <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" />
        <path d="M4 4v4.6h4.6" />
      </svg>
    );
  }
  return (
    <svg {...iconProps} width={17} height={17}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
      <path d="M8 11h6" />
      <path d="M11 8v6" />
    </svg>
  );
}


/** Focus home's counterpart to the live AI panel's + menu. It persists the
 *  selected mode before the first message hands off to AiPanel, so the first
 *  run and every later turn share one mode/review setting.
 *
 *  The Goal policy lives in here too, as rows rather than as the foot bar's
 *  cycling note: before a run exists there is nothing for a standing note to
 *  report on, and the start stage should read as one line of intent. Once the
 *  first message lands, AiPanel's foot bar carries the note as usual. */
function FocusAddMenu({
  workspaceRoot,
  mode,
  supportsTools,
  providerDelegatesWork,
  onModeChange,
  onAddFile,
  canAttachFiles,
  supportsVision,
  onAttachFiles,
  requireDiffReview,
  autoApproveCommands,
  onRequireDiffReviewChange,
  onAutoApproveCommandsChange,
  openFilesRequest = 0,
}: {
  workspaceRoot: string | null;
  mode: AgentMode;
  supportsTools: boolean;
  /** A delegate CLI does its own editing, so Goal mode never depends on the
   *  tool-support probe Klide runs for wire providers. */
  providerDelegatesWork: boolean;
  onModeChange: (mode: AgentMode) => void;
  onAddFile: (path: string) => void;
  /** False for a delegate CLI, which takes text on its stdin and nothing else. */
  canAttachFiles: boolean;
  /** Whether the chosen model can see a photo — decides what this row promises. */
  supportsVision: boolean;
  onAttachFiles: (files: File[]) => void;
  requireDiffReview: boolean;
  autoApproveCommands: boolean;
  onRequireDiffReviewChange: (v: boolean) => void;
  onAutoApproveCommandsChange: (v: boolean) => void;
  /** Bumped by the composer when a command wants the file list open — `/explain`
   *  has nothing to explain until a file is picked. Zero means never asked. */
  openFilesRequest?: number;
}) {
  const [view, setView] = useState<"actions" | "files">("actions");
  // The OS file picker, for a photo or document that isn't in the workspace.
  const pickerRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const {
    open,
    pos,
    triggerRef,
    menuRef,
    openMenu,
    close,
  } = usePortalMenu({
    closeOnOutsideClick: true,
    computePos: (rect) => {
      const width = 238;
      // Bottom-anchored above the trigger, so the room it has is whatever sits
      // above it minus the two 8px margins — not a fixed number. Goal's policy
      // rows take the stack past 350px, which a fixed cap simply cut off; the
      // ceiling only bites on a short window, and then the body scrolls.
      return {
        bottom: Math.round(window.innerHeight - rect.top + 8),
        left: Math.round(Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)),
        maxHeight: Math.max(160, Math.min(560, Math.round(rect.top - 16))),
      };
    },
  });

  useEffect(() => {
    setFiles(null);
    setFileQuery("");
    setView("actions");
    close();
  }, [workspaceRoot, close]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  async function showFiles() {
    if (!workspaceRoot) return;
    setView("files");
    setFileQuery("");
    requestAnimationFrame(() => fileSearchRef.current?.focus());
    if (files !== null) return;
    try {
      setFiles(await listWorkspaceFiles(workspaceRoot));
    } catch {
      setFiles([]);
    }
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    setView("actions");
    openMenu();
  }

  useEffect(() => {
    if (openFilesRequest === 0) return;
    openMenu();
    void showFiles();
    // showFiles is a plain function of this render; the request counter is
    // the one signal this effect answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFilesRequest]);

  // Through the shared ladder. A delegate CLI does its own editing, so Goal
  // mode stays open to it even though Klide never probed its tool support —
  // the same exemption the AI panel applies.
  const effectiveMode = effectiveModeFor({
    mode,
    modelSupportsTools: supportsTools,
    providerDelegatesWork,
  });
  const activePolicy = goalPolicyOf(requireDiffReview, autoApproveCommands);
  const matchingFiles = (files ?? [])
    .filter((path) => !fileQuery || isSubsequence(fileQuery, path))
    .slice(0, 12);

  return (
    <div style={{ display: "flex", flexShrink: 0 }}>
      <input
        ref={pickerRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ""; // so picking the same file twice still fires
          close();
          if (files.length) onAttachFiles(files);
        }}
      />
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        title="Add files and more"
        aria-label="Add files and choose a mode"
        aria-haspopup="menu"
        aria-expanded={open}
        className="klide-focus-add"
        data-open={open || undefined}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={view === "files" ? "Add a file" : "Add files and choose a mode"}
          className="popover-enter menu-glass klide-focus-add-menu"
          style={{ left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight, zIndex: Z.popover }}
        >
          {view === "files" ? (
            <>
              <div className="klide-focus-add-menu-header">
                <button type="button" onClick={() => setView("actions")} aria-label="Back to actions">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <input
                  ref={fileSearchRef}
                  value={fileQuery}
                  onChange={(e) => setFileQuery(e.target.value)}
                  placeholder="Find a workspace file…"
                  aria-label="Find a workspace file"
                />
              </div>
              <div className="klide-focus-add-file-list menu-scroll">
                {files === null ? (
                  <div className="klide-focus-add-empty">Loading files…</div>
                ) : matchingFiles.length === 0 ? (
                  <div className="klide-focus-add-empty">No matching files</div>
                ) : matchingFiles.map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="menuitem"
                    title={path}
                    onClick={() => {
                      close();
                      onAddFile(path);
                    }}
                  >
                    {path}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="klide-focus-add-menu-scroll menu-scroll">
              <button
                type="button"
                role="menuitem"
                className="klide-focus-add-menu-row"
                disabled={!workspaceRoot}
                onClick={() => void showFiles()}
              >
                <span>Add file</span>
                <span className="klide-focus-add-menu-meta">@</span>
              </button>
              {/* A photo or document from anywhere — the workspace row above
                  attaches by path, this one attaches the file itself. */}
              <button
                type="button"
                role="menuitem"
                className="klide-focus-add-menu-row"
                disabled={!canAttachFiles}
                title={
                  canAttachFiles
                    ? supportsVision
                      ? "Attach a photo or a text document"
                      : "This model can't see images — attach a text document"
                    : "This CLI takes text only"
                }
                onClick={() => pickerRef.current?.click()}
              >
                <span>
                  {supportsVision ? "Photo or document" : "Document"}
                  <small>{supportsVision ? "Attach an image or text file" : "Attach a text file"}</small>
                </span>
                <AttachIcon size={14} />
              </button>
              <div className="klide-focus-add-menu-divider" />
              {MODE_CHOICES.map((choice) => {
                const disabled = choice.mode === "goal" && !supportsTools;
                const active = choice.mode === effectiveMode;
                return (
                  <button
                    key={choice.mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={disabled}
                    title={disabled ? "This model cannot use edit tools" : choice.description}
                    className="klide-focus-add-menu-row"
                    onClick={() => {
                      if (disabled) return;
                      onModeChange(choice.mode);
                      close();
                    }}
                  >
                    <span>
                      {choice.label}
                      <small>{choice.description}</small>
                    </span>
                    {active ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : null}
                  </button>
                );
              })}
              {/* Only Goal has gates to set, so the policy rows appear only
                  when Goal is what the first run will actually be. */}
              {effectiveMode === "goal" && (
                <>
                  <div className="klide-focus-add-menu-divider" />
                  <div className="klide-focus-add-menu-caption">When it edits</div>
                  {GOAL_POLICIES.map((policy) => {
                    const active = policy.key === activePolicy.key;
                    return (
                      <button
                        key={policy.key}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        title={policy.description}
                        className="klide-focus-add-menu-row"
                        onClick={() => {
                          onRequireDiffReviewChange(policy.review);
                          onAutoApproveCommandsChange(policy.commands);
                          close();
                        }}
                      >
                        <span>
                          {policy.label}
                          <small>{policy.description}</small>
                        </span>
                        {active ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        ) : null}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

/** A first turn leaving the start stage. `mode` is set only when a slash
 *  command pinned one (/init → goal, /interview → plan); a typed task rides in
 *  whatever mode the composer's + menu shows. */
export type FocusSubmit = (
  text: string,
  attachments: Attachment[],
  opts?: { mode?: AgentMode },
) => void;

/** Everything the start-stage composer needs beyond its own draft. Keeping the
 *  dispatch controls bundled leaves FocusHome's boundary readable. */
export type FocusComposerControls = {
  workspaceRoot: string | null;
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
  model: string;
  onModelChange: (model: string) => void;
  effort: string | undefined;
  onEffortChange: (effort: string | undefined) => void;
  contextWindow: number | undefined;
  onContextWindowChange: (window: number | undefined) => void;
  requireDiffReview: boolean;
  onRequireDiffReviewChange: (required: boolean) => void;
  /** The full-auto rung's command half: shell commands run without a
   *  permission prompt. Per-conversation and never persisted. */
  autoApproveCommands: boolean;
  onAutoApproveCommandsChange: (enabled: boolean) => void;
  onOpenSettingsSection: (section: string) => void;
};

/** The bottom-anchored task dock: context strip, textarea, and the provider /
 *  model / effort / context controls that decide how a new run is dispatched. */
function FocusComposer({
  controls,
  branch,
  onPingGit,
  onSubmit,
  placeholder = "Describe a task or ask a question…",
  autoFocus = true,
}: {
  controls: FocusComposerControls;
  branch?: string | null;
  onPingGit?: () => void;
  onSubmit: FocusSubmit;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const {
    workspaceRoot,
    provider,
    onProviderChange,
    model,
    onModelChange,
    effort,
    onEffortChange,
    contextWindow,
    onContextWindowChange,
    requireDiffReview,
    onRequireDiffReviewChange,
    autoApproveCommands,
    onAutoApproveCommandsChange,
    onOpenSettingsSection,
  } = controls;
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  // Photos and documents staged on the first turn. They ride the handoff into
  // the AI panel with the text, so a Focus task can start from a screenshot.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const [supportsVision, setSupportsVision] = useState(false);
  const [agentMode, setAgentMode] = useState<AgentMode>(
    () => normalizeAgentMode(localStorage.getItem("klide.agentMode"))
  );
  const [supportsTools, setSupportsTools] = useState(true);
  // The reasoning efforts this provider+model accepts. Empty means the pair
  // has no such dial (a Klide-wire model that doesn't reason, claude-code /
  // opencode / omp), and the control stays off the composer entirely rather
  // than offering a knob nothing reads.
  const [effortLevels, setEffortLevels] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The `/` menu: open while the draft is a lone `/word`, closed otherwise.
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  // A mode one command pinned to the next send (/explain reads → plan). Cleared
  // when the turn leaves or the draft is emptied, so it never outlives its
  // command.
  const [nextSendMode, setNextSendMode] = useState<AgentMode | null>(null);
  // Counter the + menu watches to open straight onto the file list.
  const [openFilesRequest, setOpenFilesRequest] = useState(0);
  // The model list for the chosen provider — the same discovery command the
  // AI panel and Settings use. Falls back to the provider's default so the
  // menu is never empty while a server is down.
  const [models, setModels] = useState<string[]>([]);
  // Hosted providers with no key Rust can resolve. Probed once per mount —
  // opening Settings unmounts Focus, so coming back re-probes and a provider
  // you just configured stops reading as keyless. A failed probe leaves the
  // row alone rather than quieting a provider that might work.
  const [keylessProviders, setKeylessProviders] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      KEYED_PROVIDERS.map(async (item) => {
        try {
          const status = await readProviderKeyStatus(item.id);
          return status.hasKey ? null : item.id;
        } catch {
          return null;
        }
      }),
    ).then((probed) => {
      if (!cancelled) setKeylessProviders(new Set(probed.filter((id): id is ProviderId => !!id)));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Self-hosted endpoints, from the shared store — it refreshes on mount and
  // republishes on add/rename/remove, so the stack here matches Settings
  // without leaving Focus.
  const customProviders = useCustomProviders();
  const providerMenuOptions = useMemo(
    () => buildProviderOptions(customProviders, keylessProviders, () => onOpenSettingsSection("api")),
    [customProviders, keylessProviders, onOpenSettingsSection],
  );

  useEffect(() => {
    let cancelled = false;
    // defaultModelForProvider resolves a self-hosted id through the custom
    // store, so an endpoint's pinned default is offered even if /models is
    // unreachable.
    const fallback = [model, defaultModelForProvider(provider)].filter(Boolean) as string[];
    setModels(Array.from(new Set(fallback)));
    listProviderModels(provider)
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) setModels(list);
      })
      .catch(() => {
        /* server down / no key — keep the fallback */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    queryModelSupportsTools(provider, model)
      .then((supported) => {
        if (!cancelled) setSupportsTools(supported);
      })
      .catch(() => {
        if (!cancelled) setSupportsTools(true);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, model]);

  useEffect(() => {
    let cancelled = false;
    queryModelReflectionLevels(provider, model)
      .then((levels) => {
        if (cancelled) return;
        const sorted = sortReflectionLevels(levels);
        setEffortLevels(sorted);
        // A level saved for another model can be one this one never offers
        // (`minimal` on a Codex model, say). Drop it rather than send a level
        // the CLI rejects.
        if (effort && !sorted.includes(effort)) onEffortChange(undefined);
      })
      .catch(() => {
        if (!cancelled) setEffortLevels([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, model]);

  // Vision is a per-model fact, so switching models can strand a staged photo.
  // Drop the photos when that happens (documents are text — they still travel)
  // rather than sending an image somewhere it can't be seen.
  useEffect(() => {
    let cancelled = false;
    queryModelSupportsVision(provider, model)
      .then((supported) => {
        if (cancelled) return;
        setSupportsVision(supported);
        if (!supported) setAttachments((prev) => prev.filter((a) => !a.dataUri));
      })
      .catch(() => {
        if (!cancelled) setSupportsVision(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, model]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  // A delegate CLI takes text on its stdin only — the same rule the AI panel
  // composer applies.
  const canAttachFiles = !isDelegateProvider(provider);

  function submit() {
    const text = draft.trim();
    // An attachment-only first turn is valid: a dropped screenshot is a task.
    if (!text && attachments.length === 0) return;
    const mode = nextSendMode ?? undefined;
    setDraft("");
    setAttachments([]);
    setSlash(null);
    setNextSendMode(null);
    onSubmit(text, attachments, mode ? { mode } : undefined);
  }

  function changeDraft(value: string) {
    setDraft(value);
    if (value.length === 0) setNextSendMode(null);
    const query = slashQueryOf(value);
    if (query !== null) {
      setSlash({ query });
      setSlashIdx(0);
    } else if (slash !== null) {
      setSlash(null);
    }
  }

  async function addFiles(files: File[]) {
    if (!canAttachFiles || files.length === 0) return;
    const staged = await stageFiles(files, {
      allowPhotos: supportsVision,
      alreadyStaged: attachments.length,
      alreadyImageBytes: stagedImageBytes(attachments),
    });
    for (const notice of staged.notices) notify(notice.text, { tone: notice.tone });
    if (staged.attachments.length) setAttachments((prev) => [...prev, ...staged.attachments]);
  }

  function selectAgentMode(next: AgentMode) {
    setAgentMode(next);
    localStorage.setItem("klide.agentMode", next);
  }

  // The start-stage `/` menu. Same vocabulary as the AI panel's, minus the
  // commands that need a conversation to act on (/clear, /compact, /handoff):
  // nothing exists yet to clear, compact, or hand off. A command that sends
  // leaves through `onSubmit` like a typed task, so the handoff into the
  // panel is the one path a first turn takes.
  const providerDelegatesWork = isDelegateProvider(provider);
  const goalOrPlan = (): AgentMode => (supportsTools || providerDelegatesWork ? "goal" : "plan");
  const clearDraft = () => { setDraft(""); setSlash(null); };
  const SLASH_COMMANDS: SlashCommand[] = [
    { name: "chat", desc: SLASH_DESC.chat, run: () => { selectAgentMode("chat"); clearDraft(); } },
    { name: "plan", desc: SLASH_DESC.plan, run: () => { selectAgentMode("plan"); clearDraft(); } },
    { name: "goal", desc: SLASH_DESC.goal, run: () => { selectAgentMode(goalOrPlan()); clearDraft(); } },
    { name: "mode", desc: SLASH_DESC.mode, run: () => {
      clearDraft();
      notify(currentModeText({
        effectiveMode: effectiveModeFor({ mode: agentMode, modelSupportsTools: supportsTools, providerDelegatesWork }),
        requireDiffReview,
        autoApproveCommands,
      }));
    } },
    { name: "auto-mode", desc: SLASH_DESC.autoMode, run: () => {
      clearDraft(); selectAgentMode(goalOrPlan()); onRequireDiffReviewChange(false); onAutoApproveCommandsChange(false);
    } },
    { name: "review-mode", desc: SLASH_DESC.reviewMode, run: () => {
      clearDraft(); selectAgentMode(goalOrPlan()); onRequireDiffReviewChange(true); onAutoApproveCommandsChange(false);
    } },
    { name: "start", desc: SLASH_DESC.start, run: async () => {
      clearDraft();
      if (!isManagedLocalProvider(provider)) {
        notify(`${providerName(provider)} runs in the cloud — there's no local server to start.`);
        return;
      }
      // No conversation surface to animate into yet, so the toast bus carries
      // the three beats the AI panel's DotGridLoader row would.
      try {
        if (await readLocalProviderStatus(provider)) {
          notify(`${providerName(provider)} is already running.`);
          return;
        }
      } catch {
        // Fall through and try to start it.
      }
      notify(`Starting ${providerName(provider)}…`);
      try {
        const started = await startLocalProvider({ provider, model });
        notify(started ? `${providerName(provider)} is ready.` : `${providerName(provider)} did not start.`, { tone: started ? "success" : "error" });
      } catch (e) {
        notify(String(e), { tone: "error" });
      }
    } },
    { name: "explain", desc: SLASH_DESC.explain, run: () => {
      setSlash(null);
      setDraft(EXPLAIN_PREFIX);
      setNextSendMode("plan");
      setOpenFilesRequest((n) => n + 1);
    } },
    { name: "init", desc: SLASH_DESC.init, run: () => {
      clearDraft();
      onSubmit(SLASH_PROMPTS.init.text, [], { mode: SLASH_PROMPTS.init.mode });
    } },
    { name: "interview", desc: SLASH_DESC.interview, run: () => {
      clearDraft();
      onSubmit(SLASH_PROMPTS.interview.text, [], { mode: SLASH_PROMPTS.interview.mode });
    } },
  ];
  const slashMatches = slash !== null ? filterSlashCommands(SLASH_COMMANDS, slash.query) : [];
  function acceptSlash(idx: number) {
    const cmd = slashMatches[idx];
    setSlash(null);
    if (cmd) void cmd.run();
  }

  function addFile(path: string) {
    const textarea = taRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const prefix = before.length === 0 || before.endsWith(" ") ? "" : " ";
    const inserted = `${before}${prefix}@${path} `;
    const next = inserted + after;
    setDraft(next);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(inserted.length, inserted.length);
    });
  }

  const canSend = draft.trim().length > 0 || attachments.length > 0;

  // The persistent task dock combines Codex's context ribbon with Claude's
  // bottom-anchored composer.
  return (
    <div className="klide-focus-composer-dock">
      {branch && onPingGit && (
        <div className="klide-focus-context-strip" role="group" aria-label="Task context">
          <button
            type="button"
            onClick={onPingGit}
            title={`On ${branch} — show me the git panel`}
          >
            <GitIcon size={13} />
            {branch}
          </button>
        </div>
      )}

      {/* The card clips (`overflow: hidden` for its glass), so the `/` menu
          anchors to this wrapper and floats above the card instead. */}
      <div style={{ position: "relative" }}>
      {slash !== null && (
        <SlashMenu matches={slashMatches} activeIdx={slashIdx} onHover={setSlashIdx} onAccept={acceptSlash} />
      )}
      <div
        className="klide-focus-composer"
        data-focused={focused || undefined}
        data-dropping={dropping || undefined}
        onDragOver={(e) => {
          if (!canAttachFiles) return;
          if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          if (!canAttachFiles) return;
          e.preventDefault();
          setDropping(false);
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length) void addFiles(files);
        }}
      >
        <AttachmentTray
          attachments={attachments}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
          padding="12px 14px 0"
        />
        {dropping && attachments.length === 0 && (
          <div className="klide-focus-composer-drop-hint" aria-hidden="true">
            {supportsVision ? "Drop a photo or document" : "Drop a document"}
          </div>
        )}
        <textarea
          ref={taRef}
          className="klide-composer-textarea"
          name="task-prompt"
          aria-label={placeholder}
          autoComplete="off"
          value={draft}
          onChange={(e) => changeDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); setSlash(null); }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length && canAttachFiles) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (slash !== null && slashMatches.length > 0) {
              const action = slashKeyAction(e.key);
              if (action) {
                e.preventDefault();
                if (action === "next") setSlashIdx((i) => stepSlashIndex(i, 1, slashMatches.length));
                else if (action === "prev") setSlashIdx((i) => stepSlashIndex(i, -1, slashMatches.length));
                else if (action === "accept") acceptSlash(slashIdx);
                else setSlash(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={2}
        />

        <div className="klide-focus-composer-footer">
          <div className="klide-focus-provider-control">
            <FocusAddMenu
              workspaceRoot={workspaceRoot}
              mode={agentMode}
              supportsTools={supportsTools}
              providerDelegatesWork={isDelegateProvider(provider)}
              onModeChange={selectAgentMode}
              onAddFile={addFile}
              canAttachFiles={canAttachFiles}
              supportsVision={supportsVision}
              onAttachFiles={(files) => void addFiles(files)}
              requireDiffReview={requireDiffReview}
              autoApproveCommands={autoApproveCommands}
              onRequireDiffReviewChange={onRequireDiffReviewChange}
              onAutoApproveCommandsChange={onAutoApproveCommandsChange}
              openFilesRequest={openFilesRequest}
            />
            <InlineMenu
              label="Provider"
              display={providerName(provider)}
              leading={<ProviderLogo id={provider} size={13} />}
              options={providerMenuOptions}
              selected={provider}
              onSelect={(v) => {
                if (typeof v === "string" && !v.startsWith("__heading_")) {
                  onProviderChange(v as ProviderId);
                }
              }}
            />
          </div>

          <div className="klide-focus-model-controls">
            <ModelPicker
              provider={provider}
              model={model}
              availableModels={models}
              disabled={false}
              bareHover
              onChange={onModelChange}
            />
            {effortLevels.length > 0 && (
              <InlineMenu
                label="Reasoning effort"
                display={effort ?? "auto"}
                leading={<EffortBars level={reflectionBarLevel(effort, effortLevels)} size={13} />}
                header={{
                  icon: <EffortBars level={reflectionBarLevel(effort, effortLevels)} />,
                  title: "Reasoning effort",
                  caption: "The levels this model accepts",
                }}
                width={216}
                options={effortOptionsFor(effortLevels)}
                selected={effort}
                onSelect={(v) => onEffortChange(v === undefined ? undefined : String(v))}
              />
            )}
            <InlineMenu
              label="Context window"
              display={contextLabel(contextWindow)}
              header={{
                icon: <ContextGaugeIcon />,
                title: "Context window",
                // Klide can't set the window on a self-hosted OpenAI-wire
                // endpoint — the server owns it (num_ctx in a Modelfile, and
                // so on). Say so here rather than let the override read as
                // if it reached the server. Same signal the AI panel gives.
                caption: isCustomProvider(provider)
                  ? "Set server-side for a self-hosted endpoint"
                  : "Override the auto-detected window",
              }}
              width={200}
              options={CONTEXT_OPTIONS}
              selected={contextWindow}
              onSelect={(v) => onContextWindowChange(typeof v === "number" ? v : undefined)}
            />
            <button
              type="button"
              onClick={submit}
              aria-label="Send task"
              disabled={!canSend}
              className="klide-focus-send"
              data-ready={canSend || undefined}
            >
              <SendIcon size={14} />
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

function FocusHome({
  projectName,
  branch,
  onPingGit,
  recent,
  onOpenConversation,
  onSubmit,
  controls,
}: {
  projectName: string | null;
  branch: string | null;
  /** Draw the eye to the git island — the branch in the context strip is the
   *  one thing in there that has somewhere to point. */
  onPingGit: () => void;
  recent: Conversation[];
  onOpenConversation: (convo: Conversation) => void;
  onSubmit: FocusSubmit;
  controls: FocusComposerControls;
}) {
  return (
    <div className="klide-focus-home">
      <section className="klide-focus-stage" aria-labelledby="klide-focus-title">
        <div className="klide-focus-rise klide-focus-hero-mark" aria-hidden="true">
          <KlideMark size={24} />
        </div>
        <h1 id="klide-focus-title" className="klide-focus-rise">
          {projectName ? `What should we build in ${projectName}?` : "What should we build?"}
        </h1>

        <div className="klide-focus-rise klide-focus-card-area" data-beat="1">
          <div className="klide-focus-card-label">
            {recent.length > 0 ? "Continue where you left off" : "Start with a direction"}
          </div>
          <div className="klide-focus-card-grid">
            {(recent.length > 0
              ? recent.map((c) => ({
                  key: c.id,
                  title: c.title || "Untitled conversation",
                  sub: relativeTime(c.updatedAt),
                  kind: "resume" as StarterKind,
                  model: c.model,
                  provider: c.provider,
                  onClick: () => onOpenConversation(c),
                }))
              : STARTERS.map((s) => ({
                  key: s.title,
                  title: s.title,
                  sub: s.sub,
                  kind: s.kind,
                  model: undefined,
                  provider: undefined,
                  onClick: () => onSubmit(s.prompt, []),
                }))
            ).map((card, index) => (
              <HomeCard
                key={card.key}
                title={card.title}
                sub={card.sub}
                kind={card.kind}
                model={card.model}
                provider={card.provider}
                index={index}
                onClick={card.onClick}
              />
            ))}
          </div>
        </div>
      </section>

      <FocusComposer
        controls={controls}
        branch={branch}
        onPingGit={onPingGit}
        onSubmit={onSubmit}
      />
    </div>
  );
}

/** What ran a conversation, drawn as one mark. `bare` marks a brand logo that
 *  carries its own shape and color, as opposed to a line glyph, which wants the
 *  boxed tile the starter icons use. */
type ResumeMark = { node: ReactNode; label: string; bare: boolean };

/**
 * The mark for a resumable conversation: `conversationMark`'s precedence (the
 * CLI that ran it, else the model's maker, else the provider that hosted it),
 * plus the arm only a home card needs — Klide's own mark for a conversation
 * saved before the provider was recorded. A run this app drove is
 * still a Klide run, and an empty corner reads as a card that failed to load.
 */
export function resumeMark(
  model: string | null | undefined,
  provider: ProviderId | null | undefined,
): ResumeMark {
  // Steps 1-3 are `conversationMark`, shared with the rail so the same thread
  // does not wear one mark on the home card and none in the tree.
  const mark = conversationMark(model, provider, 24);
  if (mark) return { ...mark, bare: true };
  // Klide's own mark, worn bare like every other brand logo: the app has a
  // logo, and a thread it drove itself should wear that logo rather than a
  // hand-typed initial in a tile.
  return { node: <KlideMark size={22} />, label: "Klide", bare: true };
}

function HomeCard({
  title,
  sub,
  kind,
  model,
  provider,
  index,
  onClick,
}: {
  title: string;
  /** One quiet line under the title — for a resume card, just when it last
   *  moved. It used to read "3 hours ago · Resume": the middot separated two
   *  facts, and the second one was already said by the card being there. */
  sub: string;
  kind: StarterKind;
  model?: string | null;
  provider?: ProviderId | null;
  index: number;
  onClick: () => void;
}) {
  const mark = kind === "resume" ? resumeMark(model, provider) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="klide-focus-home-card"
      style={{ "--focus-card-delay": `${index * 35}ms` } as CSSProperties}
    >
      {mark ? (
        <span
          className="klide-focus-home-card-icon"
          data-bare={mark.bare ? "true" : undefined}
          title={mark.label}
          aria-hidden="true"
        >
          {mark.node}
        </span>
      ) : (
        <span className="klide-focus-home-card-icon" aria-hidden="true">
          <StarterIcon kind={kind} />
        </span>
      )}
      <span className="klide-focus-home-card-title">{title}</span>
      <span className="klide-focus-home-card-sub">{sub}</span>
      <span className="klide-focus-home-card-arrow" aria-hidden="true">↗</span>
    </button>
  );
}
