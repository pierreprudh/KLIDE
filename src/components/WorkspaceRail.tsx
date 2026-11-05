// WorkspaceRail — the app's one sidebar.
//
// There used to be two. Focus drew a full-height rail (actions over a project
// tree of conversations, identity at the foot); the free/anchored workbench drew
// a separate ActivityBar (icon tools, a collapse pebble, hover flyouts). They
// shared a destinations module and a set of `.klide-rail-*` classes and drifted
// apart anyway — the same workspace looked like two different apps depending on
// which layout you were in, and the conversation history simply did not exist
// outside Focus.
//
// This is Focus's rail, generalised — and there is now exactly one instance of
// it, rendered by App.tsx for every surface. The shells differ only in what
// they hand it:
//
//   newTask    the first row, sharing its line with the search button.
//   nav        the rows under it — Git, Mission Control, Library; the
//              workbench adds Explorer, which unfolds beneath its row.
//   footActions the icon buttons on the identity row — the terminal toggle and
//              the way out to the other shell. Both are filled in both shells,
//              so the foot never gains or loses a button on a mode change.
//   onOpenConversation  where a click on a conversation lands. Focus resumes
//              it on its own canvas; the workbench resumes it into an AI panel.
//
// Top to bottom it reads: the folder you are in (a card that switches it), what
// you can do (new task, search, the destinations), the folder's conversations,
// and you. The conversations are one list seen two ways — in sections (Needs
// you, across every folder; Pinned; Recent) or grouped by the agent each began
// on. It used to be a tree of every recent folder, each a tree of providers,
// and the one row that needed you was the palest thing in it (2026-11-05).
//
// The `klide-focus-*` class names are historical: this markup was Focus's.
// Read them as "the rail's".

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  MoreIcon,
  NeedsYouIcon,
  PinIcon,
  SearchIcon,
  SidebarIcon,
  SuccessIcon,
  SwitcherIcon,
} from "../icons";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import {
  forgetPinnedConversation,
  orderPinnedFirst,
  pinnedConversationIds,
  subscribePinnedConversations,
  togglePinnedConversation,
} from "../pinnedConversations";
import { Z } from "../zLayers";
import { beginDragSession } from "../dragSession";
import { SETTINGS, getSetting, useSetting } from "../settingsStore";
import { railDestination } from "../railDestinations";
import { useUserInfo, initialsOf } from "../hooks/useUserInfo";
import {
  CONVERSATIONS_CHANGED_EVENT,
  forgetStoredConversation,
  loadConversations,
  type ConversationChangedDetail,
} from "./ai/storedConversations";
import { deleteKlideConvo, renameKlideConvo } from "../klideConvos";
import { InlineNameInput } from "./InlineNameInput";
import { relativeTime, isSubsequence } from "./ai/utils";
import type { Conversation } from "./ai/types";
import type { ProviderId } from "../agent/types";
import { providerName } from "../agent/providers";
import { DotGridLoader, ProviderLogo } from "./ai/icons";
import { conversationMark, makerMark, modelIdentity } from "../modelIdentity";
import { setConversationDrag } from "../conversationDrag";
import { useIsConversationRunning } from "../runningConversations";
import { useHasLiveWorker } from "../workerStatus";
import { needsYouSummary, useFinishedUnseen, useNeedsYou, useNeedsYouIds } from "../runAttention";
import { orderProviderHistory } from "../focusHistory";
import { canonicalWorkspaceRoot, linkedProjectForPath } from "../projectPaths";
import { errMessage } from "../errors";

/** A row above the conversations. `onClick` receives the meta/ctrl modifier so
 *  the workbench can keep ⌘+click stacking on its sidebar tools. */
export type RailNavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  /** When defined, the row is a disclosure — a chevron turns with it. Explorer
   *  uses it: the tree unfolds under the row rather than opening a surface. */
  expanded?: boolean;
  /** A few words at the row's trailing edge when the destination has
   *  something waiting — the Library's "3 to review". Absent otherwise. */
  note?: string;
  onClick: (meta: boolean) => void;
};

type Props = {
  workspaceRoot: string | null;
  /** Recent project roots (the same list the Projects menu shows). */
  projects: string[];
  /** The first row. It shares its line with the search button, which takes
   *  the line over while you search. */
  newTask?: RailNavItem;
  nav: RailNavItem[];
  /** The conversations the host is actually showing — usually one, two in a
   *  race watch. They wear the selected surface. */
  selectedConversationIds?: readonly string[];
  /** Every conversation loaded somewhere right now. In Focus that is the
   *  selected one and nothing else; over the workbench's floating panels it is
   *  one per open AI panel, and the rail is the only surface that can say so.
   *  These read as strong text — present, but not where you are looking. */
  openConversationIds?: readonly string[];
  onSwitchProject: (root: string) => void;
  /** The folder card's "Open folder…" — the system folder picker. */
  onOpenFolder?: () => void;
  /** The folder card's "Clone…", with the URL typed into it. Rejects with a
   *  readable reason, shown under the field. */
  onCloneRepo?: (url: string) => Promise<void> | void;
  /** A row was opened. The conversation has already been re-resolved against
   *  durable history, so this is a record that exists. */
  onOpenConversation: (convo: Conversation) => void;
  /** The row pointed at a conversation local history no longer holds. */
  onConversationUnavailable?: (convo: Conversation) => void;
  /** A row's second action: inspect this conversation as a Run in Mission
   *  Control — its transcript, evidence and hand-offs — instead of resuming
   *  it into a panel. Absent, the row offers only open and delete. */
  onOpenConversationInMissionControl?: (convo: Conversation) => void;
  /** A row's delete action removed the conversation from local history. The
   *  panels showing it have already let go of it; this is for canvas state the
   *  rail cannot see — Focus goes back to its start stage when the thread it
   *  was showing is the one that went. */
  onConversationDeleted?: (convo: Conversation) => void;
  /** Fired before any rail navigation, so a host can drop transient canvas
   *  state (Focus clears its "conversation unavailable" screen). */
  onNavigateAway?: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  /** Icon buttons on the identity row, before the Settings gear. */
  footActions?: ReactNode;
  /** Bump to re-read local history — for host events the rail cannot see
   *  (Focus leaving its live chat). The changed-conversations event covers
   *  the rest. */
  reloadKey?: string | number | boolean;
};

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Build the workspace roots the rail lists. */
export function railProjectRoots(
  projects: readonly string[],
  activeWorkspaceRoot: string | null | undefined,
): string[] {
  const activeProjectRoot = canonicalWorkspaceRoot(activeWorkspaceRoot);
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const project of projects) {
    const normalized = canonicalWorkspaceRoot(project);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }
  if (activeProjectRoot && !seen.has(activeProjectRoot)) roots.push(activeProjectRoot);
  return roots;
}

/* Glyphs come from ../icons — one vocabulary for the whole app. This file only
   decides density: rail rows at 15px. */
const RAIL_GLYPH = 15;

/** How wide the rail may be dragged. The floor is the tree's own minimum: any
 *  narrower and a nested conversation title has no room left after the two
 *  indentation steps. The same numbers clamp the persisted setting. */
export const RAIL_MIN_WIDTH = 200;
export const RAIL_MAX_WIDTH = 460;
/** Drag the edge inside this and the rail folds away instead of getting
 *  narrower — the gap between it and the floor is what makes the fold feel
 *  like a decision rather than a slip. */
const RAIL_FOLD_AT = 168;
/** …but a drag that *starts* folded reopens as soon as it means it. The two
 *  thresholds are a hysteresis, and the asymmetry is the whole point: made to
 *  answer the fold distance, a reopen drag would sit dead for its first 167px
 *  and read as a rail that cannot be brought back. */
const RAIL_OPEN_AT = 24;

/**
 * What a drag of the rail's edge means, from where the edge now is and which
 * state the gesture began in.
 *
 * `width: null` means "leave the stored width alone" — folding must not
 * overwrite the width you folded from, or the rail would come back at its
 * minimum every time.
 */
export function railFromEdge(
  edgeX: number,
  startedCollapsed = false,
): { collapsed: boolean; width: number | null } {
  if (edgeX < (startedCollapsed ? RAIL_OPEN_AT : RAIL_FOLD_AT)) {
    return { collapsed: true, width: null };
  }
  return {
    collapsed: false,
    width: Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(edgeX))),
  };
}

/**
 * Adds a small physical detent at the normal minimum rail width while an open
 * rail is being narrowed. Once the pointer passes the fold threshold, the rail
 * releases smoothly toward zero. A drag that starts collapsed stays directly
 * under the pointer so reopening never jumps to the minimum width.
 */
export function railDragWidth(edgeX: number, startedCollapsed = false): number {
  const clampedEdge = Math.min(RAIL_MAX_WIDTH, Math.max(0, Math.round(edgeX)));
  if (startedCollapsed || clampedEdge >= RAIL_MIN_WIDTH) return clampedEdge;
  if (clampedEdge >= RAIL_FOLD_AT) return RAIL_MIN_WIDTH;
  return Math.round((clampedEdge / RAIL_FOLD_AT) * RAIL_MIN_WIDTH);
}

/** The rail's inner edge, as a control.
 *
 *  Visually it is the hairline that was always there; what is new is the wider
 *  invisible band around it that catches the pointer, because a 1px drag target
 *  is unhittable (the same trick `SideSplitter` plays in the workbench). Drag it
 *  to set the width, drag it past the fold point to put the rail away, and drag
 *  it back off the window edge to bring the rail back. Double-click toggles,
 *  for anyone who would rather not aim — as does ⌘B. */
function RailEdge({
  collapsed,
  width,
  onEdgeMoved,
  onEdgeReleased,
  onToggle,
}: {
  collapsed: boolean;
  width: number;
  onEdgeMoved: (edgeX: number, startedCollapsed: boolean) => void;
  onEdgeReleased: (edgeX: number, startedCollapsed: boolean) => void;
  onToggle: () => void;
}) {
  return (
    <>
      <div
        className="klide-rail-edge"
        role="separator"
        aria-orientation="vertical"
        aria-label={collapsed ? "Show the sidebar" : "Resize the sidebar"}
        title={collapsed ? "Drag to show the sidebar" : "Drag to resize · double-click to fold"}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          // The edge's own x is the whole state a drag needs: a folded rail's
          // edge is at 0, so both directions are the one subtraction.
          const startEdge = collapsed ? 0 : width;
          const startX = e.clientX;
          const startedCollapsed = collapsed;
          // Where the drag left the edge. The release decides what that *means*
          // — the move only ever reports a position.
          let edgeX = startEdge;
          beginDragSession({
            cursor: "col-resize",
            onMove: (ev) => {
              edgeX = startEdge + (ev.clientX - startX);
              onEdgeMoved(edgeX, startedCollapsed);
            },
            onDone: () => onEdgeReleased(edgeX, startedCollapsed),
          });
        }}
        onDoubleClick={onToggle}
      />
      {/* Codex keeps this control in the app header rather than inside the
          collapsing panel. KIDE's titlebar band is already reserved by every
          shell, so fixing the button there gives it the same stable hand-off:
          the rail moves underneath while the control never moves and can never
          cover a tab, panel header, or overlay title. The 98px leading inset is
          the macOS traffic-light safe area. */}
      <button
        type="button"
        className="klide-rail-reveal"
        data-collapsed={collapsed || undefined}
        aria-label={collapsed ? "Show the sidebar" : "Hide the sidebar"}
        title={`${collapsed ? "Show" : "Hide"} the sidebar (⌘B)`}
        onClick={onToggle}
      >
        <SidebarIcon size={15} collapsed={collapsed} />
      </button>
    </>
  );
}


/* Settings + Profile come from ../railDestinations — one definition of what
   the app's destinations are. */
const settingsDest = railDestination("settings");
const profileDest = railDestination("profile");

// One shared rail row for navigation and workspace disclosure. Hover/focus
// styling lives in CSS so pointer movement does not trigger React renders.
function NavRow({
  icon,
  label,
  onClick,
  active = false,
  expanded,
  note,
}: {
  icon: ReactNode;
  label: string;
  onClick: (meta: boolean) => void;
  active?: boolean;
  /** When defined, the row is a disclosure — a small chevron turns with it. */
  expanded?: boolean;
  /** Something waiting there, in words. */
  note?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => onClick(e.metaKey || e.ctrlKey)}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
      className="klide-focus-nav-row"
      data-sound="tap"
      data-active={active || undefined}
    >
      <span className="klide-focus-nav-icon">{icon}</span>
      <span className="klide-focus-nav-label">{label}</span>
      {note ? <span className="klide-focus-nav-note">{note}</span> : null}
      {expanded !== undefined && (
        <span className="klide-focus-nav-chevron" data-expanded={expanded || undefined} aria-hidden>
          <svg
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      )}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────── folder card ──
   The folder you are in, and the way to another one. It wears the
   notification card's surface (ToastHost: the elevated sheet, 12px radius,
   panel hairline and shadow) because it is the one thing in the rail that is
   about the whole window rather than a row in it. Name only — the branch and
   the changes are Git's to say. */

/** `/Users/name/…` → `~/…`, for a path read in a narrow menu. */
function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function FolderMark({ name }: { name: string }) {
  return (
    <span className="klide-rail-folder-mark" aria-hidden="true">
      {(name.trim()[0] ?? "·").toUpperCase()}
    </span>
  );
}

/** How many folders the card's menu lists. The rest are File ▸ Open Recent's. */
const FOLDER_MENU_LIMIT = 8;

function FolderCard({
  root,
  folders,
  waitingByFolder,
  onSwitch,
  onOpenFolder,
  onCloneRepo,
}: {
  root: string | null;
  folders: readonly string[];
  /** folder → how many of its conversations wait on you. */
  waitingByFolder: ReadonlyMap<string, number>;
  onSwitch: (root: string) => void;
  onOpenFolder?: () => void;
  onCloneRepo?: (url: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = root ? basename(root) : "Open a folder";

  function close(refocus: boolean) {
    setOpen(false);
    setCloning(false);
    setCloneUrl("");
    setCloneError(null);
    if (refocus) buttonRef.current?.focus();
  }

  // A menu: the first entry takes focus when it opens, a press outside or
  // Escape puts it away.
  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role^='menuitem']")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  function onMenuKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  async function clone() {
    const url = cloneUrl.trim();
    if (!url || !onCloneRepo || busy) return;
    setBusy(true);
    setCloneError(null);
    try {
      await onCloneRepo(url);
      close(false);
    } catch (error) {
      setCloneError(errMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="klide-rail-folder-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="klide-rail-folder"
        data-sound="tap"
        aria-haspopup="menu"
        aria-expanded={open}
        title={root ? shortPath(root) : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <FolderMark name={name} />
        <span className="klide-rail-folder-name">{name}</span>
        <SwitcherIcon size={12} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Folders"
          className="klide-rail-folder-menu popover-enter"
          onKeyDown={onMenuKey}
        >
          {folders.slice(0, FOLDER_MENU_LIMIT).map((folder) => {
            const here = folder === root;
            const waiting = waitingByFolder.get(folder) ?? 0;
            return (
              <button
                key={folder}
                type="button"
                role="menuitemradio"
                aria-checked={here}
                className="klide-rail-folder-row"
                onClick={() => {
                  close(false);
                  if (!here) onSwitch(folder);
                }}
              >
                <FolderMark name={basename(folder)} />
                <span className="klide-rail-folder-text">
                  <span className="klide-rail-folder-row-name">{basename(folder)}</span>
                  {waiting > 0 ? (
                    <span className="klide-rail-folder-detail" data-waiting="true">
                      <NeedsYouIcon size={11} /> {waiting} {waiting === 1 ? "needs" : "need"} you
                    </span>
                  ) : (
                    <span className="klide-rail-folder-detail">{shortPath(folder)}</span>
                  )}
                </span>
                {here ? <CheckIcon size={13} /> : null}
              </button>
            );
          })}
          {cloning ? (
            <form
              className="klide-rail-folder-clone"
              onSubmit={(event) => {
                event.preventDefault();
                void clone();
              }}
            >
              <input
                autoFocus
                className="klide-focus-brand-search"
                type="url"
                aria-label="Repository URL"
                placeholder="Repository URL"
                spellCheck={false}
                autoComplete="off"
                value={cloneUrl}
                disabled={busy}
                onChange={(event) => setCloneUrl(event.target.value)}
              />
              {cloneError ? <p className="klide-rail-folder-error" role="alert">{cloneError}</p> : null}
            </form>
          ) : (
            <div className="klide-rail-folder-actions">
              {onOpenFolder ? (
                <button
                  type="button"
                  role="menuitem"
                  className="klide-rail-folder-action"
                  onClick={() => {
                    close(false);
                    onOpenFolder();
                  }}
                >
                  Open folder…
                </button>
              ) : null}
              {onCloneRepo ? (
                <button
                  type="button"
                  role="menuitem"
                  className="klide-rail-folder-action"
                  onClick={() => setCloning(true)}
                >
                  Clone…
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────── conversation row ──
   One line: what is happening at the lead, the name, its age. The lead says
   the one state you would act on — waiting on you (amber hand), working (the
   panel's own loader), finished while you were away (accent check) — and
   otherwise the mark of the agent the conversation began on. A row waiting on
   you is bold and takes a second line saying what it waits on. */

function ConvoRow({
  convo,
  onOpen,
  onInspect,
  onDelete,
  onRename,
  pinned = false,
  showPin = false,
  onTogglePin,
  markBy = "agent",
  revealDelay,
  where,
  selected = false,
  open = false,
}: {
  convo: Conversation;
  onOpen: () => void;
  /** Remove this conversation from local history. Behind the row's ⋯. */
  onDelete?: () => void;
  /** Give this conversation the name typed into the row. Behind the ⋯; the
   *  title itself becomes the input. */
  onRename?: (title: string) => void;
  /** Open this conversation in Mission Control rather than a panel. */
  onInspect?: () => void;
  pinned?: boolean;
  /** Say so with a pin where the age goes. In the Pinned section the section
   *  already says it. */
  showPin?: boolean;
  onTogglePin?: () => void;
  /** Which mark leads when nothing is happening: the agent's (its first
   *  run's), or — under an agent's own heading, which already says whose it
   *  is — the model it ran on. */
  markBy?: "agent" | "model";
  /** Where this row falls in its list's entrance cascade. Read once, when the
   *  row arrives — a re-sort must not replay it. Absent: the row just appears
   *  (search results). */
  revealDelay?: string;
  /** The folder it belongs to, when that is not the one you are in. */
  where?: string;
  selected?: boolean;
  /** Loaded in a panel, but not the one being shown. Strong text, no
   *  surface — a step below `selected`. */
  open?: boolean;
}) {
  // What ran this thread: the CLI if a delegate ran it, else the model's
  // maker, else the provider that hosted it — its first run's, always.
  const mark = markBy === "model"
    ? (() => {
        const node = makerMark(convo.model, convo.provider, 15);
        const name = modelIdentity(convo.model)?.name ?? convo.model ?? undefined;
        return node ? { node, label: name && name !== "default" ? name : "Default model" } : null;
      })()
    : conversationMark(convo.model, convo.provider, 15);
  // A background worker it dispatched counts: the conversation is still
  // getting work done, and may be waiting on you (src/workerStatus.ts).
  const hasLiveWorker = useHasLiveWorker(convo.id);
  const [entranceDelay] = useState(revealDelay);
  const running = useIsConversationRunning(convo.id) || hasLiveWorker;
  // Waiting on you outranks working: it is the one row state you act on.
  const needsYou = useNeedsYou(convo.id);
  const finishedUnseen = useFinishedUnseen(convo.id) && !running && !needsYou;
  // A name giving way to another — the CLI naming the session a few seconds
  // into the first turn, or a rename — cross-fades at reading speed. The
  // first render is not a change, and an outgoing layer that finished is
  // dropped.
  const [swap, setSwap] = useState<{ from: string; key: number } | null>(null);
  const previousTitle = useRef(convo.title);
  useEffect(() => {
    if (previousTitle.current === convo.title) return;
    const from = previousTitle.current;
    previousTitle.current = convo.title;
    if (from && convo.title) setSwap((s) => ({ from, key: (s?.key ?? 0) + 1 }));
  }, [convo.title]);
  // Where the ⋯ menu is open, if it is. Anchored under the button it came
  // from, or at the pointer for a right-click on the row.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; align: "start" | "end" } | null>(null);
  // The title is being typed over. The open button steps aside for the input,
  // because an <input> may not live inside a <button>.
  const [renaming, setRenaming] = useState(false);
  const menuItems: MenuItem[] = [];
  if (onRename) menuItems.push({ type: "item", label: "Rename", onSelect: () => setRenaming(true) });
  if (onTogglePin) menuItems.push({ type: "item", label: pinned ? "Unpin" : "Pin", onSelect: onTogglePin });
  if (onInspect) menuItems.push({ type: "item", label: "Open in Mission Control", onSelect: onInspect });
  if (onDelete) {
    if (menuItems.length > 0) menuItems.push({ type: "separator" });
    menuItems.push({ type: "item", label: "Delete", danger: true, onSelect: onDelete });
  }
  const hasMenu = menuItems.length > 0 && !running && !renaming;
  const displayTitle = convo.title || "Untitled";
  const asked = needsYou ? needsYouSummary(convo.id) : undefined;
  // The folder first: in a narrow rail the end of the line is what gets cut.
  const detail = needsYou
    ? [where, asked ?? "Waiting for you"].filter(Boolean).join(" — ")
    : where;

  const lead = needsYou ? (
    <span className="klide-rail-convo-lead" data-tone="needs" aria-hidden="true">
      <NeedsYouIcon size={15} />
    </span>
  ) : running ? (
    <span className="klide-rail-convo-lead" aria-hidden="true">
      <DotGridLoader size={11} color="var(--accent)" label="Running" />
    </span>
  ) : finishedUnseen ? (
    <span className="klide-rail-convo-lead" data-tone="done" aria-hidden="true">
      <SuccessIcon size={15} />
    </span>
  ) : (
    <span className="klide-rail-convo-lead" title={mark?.label} aria-hidden="true">
      {mark?.node}
    </span>
  );

  return (
    /* The row is a plain box around two buttons, because a button cannot hold
       another: the open action is the whole row, the ⋯ is a small target at
       its trailing edge. */
    <div
      className="klide-focus-convo-row"
      data-selected={selected || undefined}
      data-open={(open && !selected) || undefined}
      data-unseen={needsYou || finishedUnseen || undefined}
      data-two-line={detail ? true : undefined}
      data-menu-open={menuAt ? true : undefined}
      /* How the slide finds this row again after the list re-sorts. */
      data-convo-id={convo.id}
      data-reveal={entranceDelay !== undefined || undefined}
      style={
        entranceDelay !== undefined
          ? ({ "--rail-reveal-delay": entranceDelay } as CSSProperties)
          : undefined
      }
      onContextMenu={
        hasMenu
          ? (e) => {
              e.preventDefault();
              setMenuAt({ x: e.clientX, y: e.clientY, align: "start" });
            }
          : undefined
      }
    >
      {renaming ? (
        <div className="klide-focus-convo-open" data-renaming="true">
          {lead}
          <InlineNameInput
            defaultValue={convo.title}
            select="all"
            ariaLabel={`Rename “${displayTitle}”`}
            style={{ fontSize: "inherit", padding: "0 3px" }}
            onCommit={(title) => {
              setRenaming(false);
              const next = title.replace(/\s+/g, " ").trim();
              if (next && next !== convo.title) onRename?.(next);
            }}
            onCancel={() => setRenaming(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          className="klide-focus-convo-open"
          onClick={onOpen}
          /* Draggable as well as clickable: a drag lets you say *which half*
             of a split canvas it lands in. HTML drag only starts once the
             pointer actually moves, so the click stays a click. */
          draggable
          onDragStart={(e) => {
            if (e.dataTransfer) setConversationDrag(e.dataTransfer, convo.id);
          }}
          /* One line, most urgent fact first — what the lead says in a glyph,
             said in words for a screen reader and a hovering pointer. */
          title={
            needsYou
              ? `${displayTitle} — needs you`
              : finishedUnseen
              ? `${displayTitle} — finished`
              : running
              ? `${displayTitle} — running`
              : open && !selected
                ? `${displayTitle} — open in a panel`
                : displayTitle
          }
          aria-label={
            needsYou ? `${displayTitle}, needs you`
            : finishedUnseen ? `${displayTitle}, finished`
            : running ? `${displayTitle}, running`
            : undefined
          }
          aria-current={selected ? "page" : undefined}
        >
          {lead}
          <span className="klide-rail-convo-text">
            <span className="klide-rail-convo-line">
              <span className="klide-focus-convo-title" data-swapping={swap ? true : undefined}>
                {swap ? (
                  <span
                    key={`out-${swap.key}`}
                    className="klide-focus-convo-title-out"
                    aria-hidden="true"
                    onAnimationEnd={() => setSwap((s) => (s?.key === swap.key ? null : s))}
                  >
                    {swap.from}
                  </span>
                ) : null}
                <span key={swap ? `in-${swap.key}` : "in"} className="klide-focus-convo-title-in">
                  {displayTitle}
                </span>
              </span>
              {pinned && showPin ? (
                <span className="klide-focus-convo-time klide-focus-convo-pinned" title="Pinned" aria-label="Pinned">
                  <PinIcon size={11} />
                </span>
              ) : (
                <span className="klide-focus-convo-time">{relativeTime(convo.updatedAt)}</span>
              )}
            </span>
            {detail ? <span className="klide-rail-convo-detail">{detail}</span> : null}
          </span>
        </button>
      )}
      {/* Same slot, on hover: the age steps aside and one ⋯ takes its place,
          holding the rest — rename, pin, inspect, delete. Not offered while
          the run is live: its snapshot is still being written. */}
      {hasMenu ? (
        <button
          type="button"
          className="klide-focus-convo-more"
          title="More"
          aria-label={`More actions for “${displayTitle}”`}
          aria-haspopup="menu"
          aria-expanded={menuAt ? true : undefined}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuAt({ x: rect.right, y: rect.bottom + 4, align: "end" });
          }}
        >
          <MoreIcon size={15} />
        </button>
      ) : null}
      {menuAt ? (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          align={menuAt.align}
          items={menuItems}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────── grouping, pure ── */

type ProviderHistory = {
  provider: ProviderId;
  conversations: Conversation[];
  updatedAt: number;
};

function groupHistoryByProvider(conversations: Conversation[]): ProviderHistory[] {
  const groups = new Map<ProviderId, Conversation[]>();

  for (const conversation of conversations) {
    const conversationProvider = conversation.provider ?? "ollama";
    const existing = groups.get(conversationProvider);
    if (existing) existing.push(conversation);
    else groups.set(conversationProvider, [conversation]);
  }

  return Array.from(groups, ([groupProvider, groupedConversations]) => {
    groupedConversations.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      provider: groupProvider,
      conversations: groupedConversations,
      updatedAt: groupedConversations[0]?.updatedAt ?? 0,
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The entrance cascade: each row starts a beat after the one above, so a
 *  list opening reads as one wave down the rail. Capped, so a long list
 *  lands in a fraction of a second rather than a queue. */
const REVEAL_STEP_MS = 22;
const REVEAL_STAGGER_CAP = 12;
function revealDelay(index: number): string {
  return `${Math.min(Math.max(index, 0), REVEAL_STAGGER_CAP) * REVEAL_STEP_MS}ms`;
}

/** Rows an agent's group shows before "More". */
const CONVERSATION_ROW_LIMIT = 5;
/** Rows Recent shows before "More" — one list, so it can afford more. */
const RECENT_ROW_LIMIT = 10;

/** The rows a folded list shows.
 *
 *  The newest few, plus any conversation that is loaded in a panel right now:
 *  the rail is what tells you what is open, so an open conversation must never
 *  be the thing hiding behind "More". Kept rows take the tail slots and keep
 *  their place in the newest-first order, and the window never grows past the
 *  limit — a folded list is a fixed height by design. */
export function visibleProviderConversations(
  conversations: Conversation[],
  showAll: boolean,
  keepIds: ReadonlySet<string> = new Set(),
  limit = CONVERSATION_ROW_LIMIT,
): Conversation[] {
  if (showAll || conversations.length <= limit) return conversations;
  // Kept rows claim their slots first, wherever they sit in the history —
  // taking the newest few and then patching the kept ones into the tail
  // drops any kept row that happened to be recent enough to already be there.
  const kept = conversations
    .filter((conversation) => keepIds.has(conversation.id))
    .slice(0, limit);
  const newestFill = conversations
    .filter((conversation) => !keepIds.has(conversation.id))
    .slice(0, limit - kept.length);
  const keep = new Set([...kept, ...newestFill].map((conversation) => conversation.id));
  // Filtered from the source, so the window keeps newest-first order rather
  // than the order the two groups happened to be assembled in.
  return conversations.filter((conversation) => keep.has(conversation.id));
}

/** The Sections view of a folder's conversations.
 *
 *  Needs you spans every folder — a question asked in another project is
 *  still yours to answer, and the folder card is too far away to say so. A
 *  row appears once: a conversation that needs you leaves Pinned and Recent
 *  while it does. Each list is newest first. */
export function railConversationSections(
  conversations: readonly Conversation[],
  folderOf: (conversation: Conversation) => string | null,
  folder: string | null,
  needsYou: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
): { needs: Conversation[]; pinned: Conversation[]; recent: Conversation[] } {
  const newest = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const needs = newest.filter((c) => needsYou.has(c.id));
  const here = folder
    ? newest.filter((c) => !needsYou.has(c.id) && folderOf(c) === folder)
    : [];
  return {
    needs,
    pinned: here.filter((c) => pinned.has(c.id)),
    recent: here.filter((c) => !pinned.has(c.id)),
  };
}

/** Re-resolve a rail snapshot at click time; rendered history can be stale if
 * another panel pruned or rewrote the local index between render and click. */
export function retrievableConversation(
  conversationId: string,
  conversations: Conversation[],
): Conversation | null {
  return conversations.find(
    (conversation) =>
      conversation.id === conversationId && Array.isArray(conversation.msgs),
  ) ?? null;
}

/** Slide rows to their new positions instead of teleporting them.
 *
 *  Standard FLIP: remember where each row was, and after the DOM moves it,
 *  start it from the offset it just left and let it travel to zero. Only rows
 *  that actually moved animate. `translateY` only — transform and opacity
 *  are the two properties that don't touch layout. */
function useRowSlide(
  containerRef: React.RefObject<HTMLDivElement | null>,
  order: string,
): void {
  const previousTops = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-convo-id]"),
    );
    const containerTop = container.getBoundingClientRect().top;
    const previous = previousTops.current;
    const next = new Map<string, number>();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    for (const row of rows) {
      const id = row.dataset.convoId;
      if (!id) continue;
      const top = row.getBoundingClientRect().top - containerTop;
      next.set(id, top);
      const was = previous.get(id);
      if (still || was === undefined || Math.abs(was - top) < 0.5) continue;
      row.animate(
        [{ transform: `translateY(${was - top}px)` }, { transform: "translateY(0)" }],
        // The rail's own easing token, spelled out: the Web Animations API
        // resolves no custom properties. Keep it equal to `--ease-soft`.
        { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
      );
    }
    previousTops.current = next;
  }, [containerRef, order]);
}

/* ─────────────────────────────────────────────────────────── sections ── */

/** A folding heading over a list: a few dim words, a count, a caret. */
function RailSection({
  label,
  icon,
  count,
  open,
  onToggle,
  tone,
  children,
}: {
  label: string;
  icon?: ReactNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  /** Needs you's heading speaks in the waiting tone. */
  tone?: "needs";
  children: ReactNode;
}) {
  return (
    <section className="klide-rail-section">
      <button
        type="button"
        className="klide-rail-section-head"
        aria-expanded={open}
        data-tone={tone}
        onClick={onToggle}
      >
        {icon ? <span className="klide-rail-section-icon" aria-hidden="true">{icon}</span> : null}
        <span>{label}</span>
        {count !== undefined ? <span className="klide-rail-section-count">{count}</span> : null}
        <span className="klide-rail-section-caret" data-open={open || undefined} aria-hidden="true">
          <ChevronIcon size={9} />
        </span>
      </button>
      {open ? children : null}
    </section>
  );
}

/** A list of rows that slide when they re-sort, with its "More" under it. */
function RowList({
  rows,
  limit,
  keepIds,
  label,
  render,
}: {
  rows: Conversation[];
  limit: number;
  keepIds: ReadonlySet<string>;
  /** What "More" shows more of, for its accessible name. */
  label: string;
  /** `delay` is the row's place in the entrance cascade. */
  render: (conversation: Conversation, delay: string) => ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const startHeight = useRef<number | null>(null);
  const visible = visibleProviderConversations(rows, showAll, keepIds, limit);
  useRowSlide(ref, visible.map((c) => c.id).join());

  /* `height: auto` cannot transition, so More / Less measures the list before
     and after and lets the browser travel between the two, while the rows
     that arrive cascade in inside it. */
  useLayoutEffect(() => {
    const list = ref.current;
    const from = startHeight.current;
    startHeight.current = null;
    if (!list || from === null) return;
    const to = list.getBoundingClientRect().height;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(to - from) < 1) return;
    list.style.overflow = "hidden";
    const animation = list.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      // `--ease-soft`, spelled out: the Web Animations API reads no variables.
      { duration: showAll ? 420 : 340, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
    );
    const release = () => list.style.removeProperty("overflow");
    animation.addEventListener("finish", release, { once: true });
    animation.addEventListener("cancel", release, { once: true });
    return () => animation.cancel();
  }, [showAll]);

  return (
    <>
      <div ref={ref} className="klide-rail-list">
        {/* Rows that arrive with More start their own wave from the top of
            what is new, not from the bottom of what was already there. */}
        {visible.map((c, index) => render(c, revealDelay(showAll ? index - limit : index)))}
      </div>
      {rows.length > limit ? (
        <button
          type="button"
          className="klide-focus-more-conversations"
          aria-expanded={showAll}
          aria-label={`${showAll ? "Show fewer" : "Show all"} ${label}`}
          onClick={() => {
            startHeight.current = ref.current?.getBoundingClientRect().height ?? null;
            setShowAll((shown) => !shown);
          }}
        >
          {showAll ? "Less" : "More"}
        </button>
      ) : null}
    </>
  );
}

type ConversationView = "sections" | "agent";
const VIEWS: { id: ConversationView; label: string }[] = [
  { id: "sections", label: "Sections" },
  { id: "agent", label: "Agent" },
];

/** The way the list is read, as one word — "Sections" or "Agent". A click
 *  turns it into the other: the word rolls over to the next one while its
 *  pill stretches to the new width, and the list below morphs with it. */
function ViewSwitch({
  value,
  onChange,
}: {
  value: ConversationView;
  onChange: (view: ConversationView) => void;
}) {
  const current = VIEWS.find((v) => v.id === value) ?? VIEWS[0];
  const next = VIEWS[(VIEWS.indexOf(current) + 1) % VIEWS.length];
  // Each word's width, so the pill can travel between them — `width: auto`
  // does not transition.
  const measureRef = useRef<HTMLSpanElement>(null);
  const [widths, setWidths] = useState<Partial<Record<ConversationView, number>>>({});
  useLayoutEffect(() => {
    const measure = () => {
      const spans = measureRef.current?.children;
      if (!spans) return;
      const next: Partial<Record<ConversationView, number>> = {};
      VIEWS.forEach((v, i) => { next[v.id] = (spans[i] as HTMLElement | undefined)?.offsetWidth; });
      setWidths(next);
    };
    measure();
    // The words are measured in the UI font; measure again once it is in.
    void document.fonts?.ready.then(measure);
  }, []);
  const width = widths[value];
  return (
    <button
      type="button"
      className="klide-rail-view-pick"
      data-sound="tap"
      aria-label={`Conversations by ${current.label.toLowerCase()} — show by ${next.label.toLowerCase()}`}
      title={`Show by ${next.label.toLowerCase()}`}
      onClick={() => onChange(next.id)}
    >
      <span className="klide-rail-view-words" style={width ? { width } : undefined} aria-hidden="true">
        {VIEWS.map((v) => (
          <span key={v.id} className="klide-rail-view-word" data-on={v.id === value || undefined}>
            {v.label}
          </span>
        ))}
      </span>
      <SwitcherIcon size={10} />
      <span ref={measureRef} className="klide-rail-view-measure" aria-hidden="true">
        {VIEWS.map((v) => <span key={v.id}>{v.label}</span>)}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------- rail */

export function WorkspaceRail({
  workspaceRoot,
  projects,
  newTask,
  nav,
  selectedConversationIds,
  openConversationIds,
  onSwitchProject,
  onOpenFolder,
  onCloneRepo,
  onOpenConversation,
  onConversationUnavailable,
  onConversationDeleted,
  onOpenConversationInMissionControl,
  onNavigateAway,
  onOpenSettings,
  onOpenProfile,
  footActions,
  reloadKey,
}: Props) {
  const activeProjectRoot = canonicalWorkspaceRoot(workspaceRoot);
  // One Set each for the render. A host that only ever has one conversation
  // loaded can leave `openConversationIds` off: what is showing is what is
  // open.
  const selectedIds = useMemo(
    () => new Set(selectedConversationIds ?? []),
    [selectedConversationIds],
  );
  const openIds = useMemo(
    () => new Set(openConversationIds ?? selectedIds),
    [openConversationIds, selectedIds],
  );
  const railProjects = useMemo(
    () => railProjectRoots(projects, activeProjectRoot),
    [activeProjectRoot, projects],
  );
  // Width and fold are persisted settings rather than local state: both shells
  // render this component, and the rail should be the width you left it at
  // whichever one you come back through. ⌘B (App.tsx) writes the same setting.
  const [railWidth, setRailWidth] = useSetting(SETTINGS.railWidth);
  const [collapsed, setCollapsed] = useSetting(SETTINGS.railCollapsed);
  const [view, setView] = useSetting(SETTINGS.railConversationView);
  // The width the pointer is currently holding the rail at, or null when no
  // drag is in flight. It exists so a drag can be *exactly* the pointer — every
  // width, including ones the rail is not allowed to rest at — while the stored
  // width stays a legal one. Release is what settles the two.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { username, hostname, avatarUrl } = useUserInfo();
  const searchRef = useRef<HTMLInputElement>(null);
  // Folded headings, by key: "needs", "pinned", "agent:<provider>".
  // Everything starts open; the session remembers what you folded.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const needsYouIds = useNeedsYouIds();

  function toggleFolded(key: string) {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Make sure a conversation's heading is open — it was opened from
   *  somewhere other than its row, so its row has to be findable. */
  function unfoldFor(provider: ProviderId | undefined) {
    setFolded((prev) => {
      const keys = ["needs", "pinned", `agent:${provider ?? "ollama"}`];
      if (!keys.some((key) => prev.has(key))) return prev;
      const next = new Set(prev);
      for (const key of keys) next.delete(key);
      return next;
    });
  }

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const [convos, setConvos] = useState<Conversation[]>(
    () => loadConversations<Conversation>(),
  );
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(() => pinnedConversationIds());
  useEffect(
    () => subscribePinnedConversations(() => setPinnedIds(pinnedConversationIds())),
    [],
  );
  function togglePin(conversation: Conversation) {
    togglePinnedConversation(conversation.id);
  }

  // Same-window localStorage writes do not emit the browser's `storage`
  // event. AiPanel publishes this focused index event after the first durable
  // snapshot, so a brand-new conversation arrives with its model logo while
  // the rail stays mounted. `reloadKey` still reloads as a defensive fallback.
  useEffect(() => {
    const reload = (event: Event) => {
      setConvos(loadConversations<Conversation>());
      const detail = (event as CustomEvent<ConversationChangedDetail | undefined>).detail;
      // Work in a secondary AI panel still belongs in the rail: its heading
      // opens rather than leaving the new row folded away.
      if (detail) unfoldFor(detail.provider);
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
  }, []);

  useEffect(() => {
    setConvos(loadConversations<Conversation>());
  }, [reloadKey, searchOpen]);

  // Which folder each conversation belongs to — a worktree run's under the
  // project it was cut from.
  const folderById = useMemo(() => {
    const byId = new Map<string, string>();
    for (const c of convos) {
      const folder = linkedProjectForPath(c.cwd, railProjects);
      if (folder) byId.set(c.id, folder);
    }
    return byId;
  }, [convos, railProjects]);

  const waitingByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of needsYouIds) {
      const folder = folderById.get(id);
      if (folder) counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    return counts;
  }, [needsYouIds, folderById]);

  const sections = useMemo(
    () => railConversationSections(
      convos,
      (c) => folderById.get(c.id) ?? null,
      activeProjectRoot,
      needsYouIds,
      pinnedIds,
    ),
    [convos, folderById, activeProjectRoot, needsYouIds, pinnedIds],
  );

  // By agent: this folder only, every conversation once. Group positions are
  // held while rows follow recency, so a live provider does not leapfrog.
  const orderMemory = useRef<Map<string, string[]>>(new Map());
  const agentGroups = useMemo(() => {
    if (!activeProjectRoot) return [];
    const here = convos.filter((c) => folderById.get(c.id) === activeProjectRoot);
    return orderProviderHistory(groupHistoryByProvider(here), orderMemory.current, activeProjectRoot);
  }, [convos, folderById, activeProjectRoot]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return convos
      .filter(
        (c) =>
          (c.title || "").toLowerCase().includes(q) ||
          isSubsequence(q, (c.title || "").toLowerCase())
      )
      .slice(0, 20);
  }, [convos, query]);

  function renameHistoryConversation(conversation: Conversation, title: string) {
    // One call names the thread in both records — the Stored conversation the
    // rail reads and the Mission Control row — and the store's change event
    // brings every other rail along.
    renameKlideConvo(conversation.id, title);
    setConvos(loadConversations<Conversation>());
  }

  /** Remove a conversation from local history. The Run transcript stays on
   *  disk and in Mission Control; only the resumable snapshot goes. Forgetting
   *  it publishes the deletion, so any panel showing the thread drops it
   *  before its next persist could write it back. */
  function deleteHistoryConversation(conversation: Conversation) {
    forgetPinnedConversation(conversation.id);
    forgetStoredConversation(conversation.id);
    deleteKlideConvo(conversation.id);
    setConvos(loadConversations<Conversation>());
    onConversationDeleted?.(conversation);
  }

  function openHistoryConversation(conversation: Conversation) {
    // The row is a rendered snapshot. Resolve it against durable local history
    // once more before handing it to the host so a pruned/corrupt entry gets a
    // deliberate empty state instead of reopening whichever chat was active.
    const resolved = retrievableConversation(
      conversation.id,
      loadConversations<Conversation>(),
    );
    if (!resolved) {
      onConversationUnavailable?.(conversation);
      setSearchOpen(false);
      setQuery("");
      return;
    }
    onNavigateAway?.();
    // History is navigation, not a second reader mode. Resume the saved
    // conversation into the fully wired AiPanel the host owns.
    onOpenConversation(resolved);
  }

  /* A conversation that has just been loaded into a panel from elsewhere — the
     palette, Mission Control, a toast — has to be findable: its heading opens
     once, on the transition, and is then left alone, so you can still fold a
     heading while its conversation stays loaded. Starts empty, so a session
     that comes back with panels restored reveals them on the first pass. */
  const revealedOpenIds = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const previouslyOpen = revealedOpenIds.current;
    revealedOpenIds.current = openIds;
    for (const id of openIds) {
      if (previouslyOpen.has(id)) continue;
      const convo = convos.find((c) => c.id === id);
      if (convo) unfoldFor(convo.provider);
    }
  }, [openIds, convos]);

  const searching = searchOpen && query.trim().length > 0;

  /* Switching Sections ⇄ Agent is a morph, not a page change: every row is
     measured where it stands, the other view renders, and each row then
     travels from where it was to where it now is. A row only one view shows
     fades in behind them. The entrance cascade stays out of it — the rows
     are not arriving, they are moving. */
  const bodyRef = useRef<HTMLDivElement>(null);
  const morphFrom = useRef<Map<string, DOMRect> | null>(null);
  function switchView(next: ConversationView) {
    if (next === view) return;
    const body = bodyRef.current;
    if (body && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const from = new Map<string, DOMRect>();
      for (const el of body.querySelectorAll<HTMLElement>("[data-convo-id]")) {
        from.set(el.dataset.convoId!, el.getBoundingClientRect());
      }
      morphFrom.current = from;
    }
    setView(next);
  }
  useLayoutEffect(() => {
    const from = morphFrom.current;
    morphFrom.current = null;
    const body = bodyRef.current;
    if (!from || !body) return;
    // `--ease-soft`, spelled out: the Web Animations API reads no variables.
    const easing = "cubic-bezier(0.32, 0.72, 0, 1)";
    for (const el of body.querySelectorAll<HTMLElement>("[data-convo-id]")) {
      const was = from.get(el.dataset.convoId!);
      if (!was) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 140, easing, fill: "backwards" });
        continue;
      }
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: 420, easing },
      );
    }
    for (const el of body.querySelectorAll<HTMLElement>(".klide-rail-section-head")) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 120, easing, fill: "backwards" });
    }
  }, [view]);

  const row = (
    conversation: Conversation,
    options: { markBy?: "agent" | "model"; showPin?: boolean; delay?: string } = {},
  ) => {
    const folder = folderById.get(conversation.id);
    return (
      <ConvoRow
        key={conversation.id}
        convo={conversation}
        markBy={options.markBy}
        revealDelay={morphFrom.current ? undefined : options.delay}
        showPin={options.showPin}
        where={folder && folder !== activeProjectRoot ? basename(folder) : undefined}
        selected={selectedIds.has(conversation.id)}
        open={openIds.has(conversation.id)}
        onOpen={() => openHistoryConversation(conversation)}
        onInspect={
          onOpenConversationInMissionControl
            ? () => onOpenConversationInMissionControl(conversation)
            : undefined
        }
        onDelete={() => deleteHistoryConversation(conversation)}
        onRename={(title) => renameHistoryConversation(conversation, title)}
        pinned={pinnedIds.has(conversation.id)}
        onTogglePin={() => togglePin(conversation)}
      />
    );
  };

  const here = sections.pinned.length + sections.recent.length;

  let conversationBody: ReactNode;
  if (searching) {
    conversationBody = filtered.length === 0 ? (
      <p className="klide-focus-rail-empty">No conversations match.</p>
    ) : (
      <div className="klide-rail-list">{filtered.map((c) => row(c, { showPin: true }))}</div>
    );
  } else if (view === "agent") {
    conversationBody = (
      <>
        {agentGroups.map((group) => {
          const key = `agent:${group.provider}`;
          const ordered = orderPinnedFirst(group.conversations, pinnedIds);
          return (
            <RailSection
              key={key}
              label={providerName(group.provider)}
              icon={<ProviderLogo id={group.provider} size={13} />}
              count={group.conversations.length}
              open={!folded.has(key)}
              onToggle={() => toggleFolded(key)}
            >
              <RowList
                rows={ordered}
                limit={CONVERSATION_ROW_LIMIT}
                keepIds={new Set([...openIds, ...pinnedIds])}
                label={`${providerName(group.provider)} conversations`}
                render={(c, delay) => row(c, { markBy: "model", showPin: true, delay })}
              />
            </RailSection>
          );
        })}
        {/* Grouped by agent, the list is this folder's — say when another
            folder has something waiting rather than hiding it entirely. */}
        {(() => {
          const elsewhere = sections.needs.filter((c) => folderById.get(c.id) !== activeProjectRoot).length;
          return elsewhere > 0 ? (
            <p className="klide-rail-elsewhere">
              <NeedsYouIcon size={13} /> {elsewhere} waiting in {elsewhere === 1 ? "another folder" : "other folders"}
            </p>
          ) : null;
        })()}
      </>
    );
  } else {
    conversationBody = (
      <>
        {sections.needs.length > 0 ? (
          <RailSection
            label="Needs you"
            tone="needs"
            count={sections.needs.length}
            open={!folded.has("needs")}
            onToggle={() => toggleFolded("needs")}
          >
            <div className="klide-rail-list">{sections.needs.map((c, i) => row(c, { delay: revealDelay(i) }))}</div>
          </RailSection>
        ) : null}
        {sections.pinned.length > 0 ? (
          <RailSection
            label="Pinned"
            open={!folded.has("pinned")}
            onToggle={() => toggleFolded("pinned")}
          >
            <div className="klide-rail-list">{sections.pinned.map((c, i) => row(c, { delay: revealDelay(i) }))}</div>
          </RailSection>
        ) : null}
        {/* The rest of the folder needs no heading: every list here is
            newest first, so "Recent" said nothing. */}
        {sections.recent.length > 0 ? (
          <div className="klide-rail-rest">
            <RowList
              rows={sections.recent}
              limit={RECENT_ROW_LIMIT}
              keepIds={openIds}
              label="conversations"
              render={(c, delay) => row(c, { delay })}
            />
          </div>
        ) : null}
      </>
    );
  }

  return (
    // The rail runs to the window's top edge and carries the traffic lights,
    // so it doubles as the window's drag handle — its blank areas move the
    // window the way a Mac sidebar does. Rows and buttons are their own event
    // targets, so they still click through.
    <aside
      className="klide-focus-rail"
      aria-label="Workspace navigation"
      data-tauri-drag-region
      /* Folded, the rail keeps its box at zero width rather than unmounting:
         its state, its scroll position and its history subscriptions all
         survive the fold, so bringing it back is instant. The clip below hides
         the contents, and the width between the two states is what animates. */
      data-collapsed={collapsed || undefined}
      data-dragging={dragWidth !== null || undefined}
      /* Above the docks and above the free layout's floating panels — that band
         climbs by one with every focus event, so the rail cannot hold a small
         local z the way it could when only Focus rendered it. */
      style={{
        zIndex: Z.rail,
        width: dragWidth ?? (collapsed ? 0 : railWidth),
        // The sampled spring briefly crosses its target; maxWidth clamps it so
        // opening settles at the stored width instead of bulging past it.
        maxWidth: dragWidth === null ? railWidth : RAIL_MAX_WIDTH,
      }}
    >
      <RailEdge
        collapsed={collapsed}
        width={railWidth}
        onEdgeMoved={(edgeX, startedCollapsed) => {
          setDragWidth(railDragWidth(edgeX, startedCollapsed));
          // The fold state still updates live, so the contents fade as you
          // cross the point they will fold at. Read back through the store
          // rather than the closure: this handler is captured for the whole
          // drag, so its own `collapsed` is one mouse-move out of date.
          const folding = railFromEdge(edgeX, startedCollapsed).collapsed;
          if (folding !== getSetting(SETTINGS.railCollapsed)) setCollapsed(folding);
        }}
        onEdgeReleased={(edgeX, startedCollapsed) => {
          const settled = railFromEdge(edgeX, startedCollapsed);
          setCollapsed(settled.collapsed);
          if (settled.width !== null) setRailWidth(settled.width);
          // Last: clearing the drag hands the width back to the transition, so
          // an out-of-bounds release eases into the legal width.
          setDragWidth(null);
        }}
        onToggle={() => setCollapsed(!collapsed)}
      />

      {/* Two wrappers, and each earns its keep. The clip is what the fold
          actually is — the rail's own width animates to zero and this hides
          what no longer fits — and the inner holds the content at its full
          width throughout, so it slides out of view instead of reflowing. */}
      <div className="klide-rail-clip" inert={collapsed}>
        {/* The drag region rides down here with the content: Tauri only moves
            the window for the element the pointer actually hits. */}
        <div className="klide-rail-inner" style={{ width: railWidth }} data-tauri-drag-region>
          <FolderCard
            root={activeProjectRoot}
            folders={railProjects}
            waitingByFolder={waitingByFolder}
            onSwitch={(root) => {
              onNavigateAway?.();
              onSwitchProject(root);
            }}
            onOpenFolder={onOpenFolder}
            onCloneRepo={onCloneRepo}
          />

          {/* New task and search share a line. Searching, the field takes
              the line over, so opening it never moves the list it filters. */}
          <div className="klide-rail-actions">
            {searchOpen ? (
              <input
                ref={searchRef}
                className="klide-focus-brand-search"
                type="search"
                name="conversation-search"
                aria-label="Search conversations"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchOpen(false);
                    setQuery("");
                  }
                }}
                placeholder="Search conversations…"
              />
            ) : newTask ? (
              <NavRow
                icon={newTask.icon}
                label={newTask.label}
                active={newTask.active}
                onClick={(meta) => {
                  onNavigateAway?.();
                  newTask.onClick(meta);
                }}
              />
            ) : (
              <span className="klide-rail-actions-fill" />
            )}
            <button
              type="button"
              className="klide-focus-brand-action"
              aria-label={searchOpen ? "Close conversation search" : "Search conversations"}
              title={searchOpen ? "Close search" : "Search conversations"}
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen((v) => !v);
                setQuery("");
              }}
            >
              {searchOpen ? <CloseIcon size={RAIL_GLYPH} /> : <SearchIcon size={RAIL_GLYPH} />}
            </button>
          </div>

          <div className="klide-focus-nav-group">
            {nav.map((item) => (
              <NavRow
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={item.active}
                expanded={item.expanded}
                note={item.note}
                onClick={(meta) => {
                  onNavigateAway?.();
                  item.onClick(meta);
                }}
              />
            ))}
          </div>

          <div className="klide-rail-convos-head">
            <h2 className="klide-rail-convos-label">{searching ? "Results" : "Conversations"}</h2>
            {searching ? null : <ViewSwitch value={view} onChange={switchView} />}
          </div>

          <div className="klide-focus-rail-body" ref={bodyRef}>
            {!searching && !activeProjectRoot ? (
              <p className="klide-focus-rail-empty">Open a folder to start.</p>
            ) : null}
            {!searching && activeProjectRoot && here === 0 && sections.needs.length === 0 ? (
              <p className="klide-focus-rail-empty">No conversations here yet.</p>
            ) : null}
            {conversationBody}
          </div>

          {/* You, then the shell's own controls, then Settings — one line.
              Profile is drawn as the identity card because it has a name and
              a host to show. */}
          <div className="klide-rail-identity-row">
            <button
              type="button"
              className="klide-rail-profile"
              data-sound="tap"
              aria-label={`Open ${profileDest.label.toLowerCase()}`}
              title={profileDest.label}
              onClick={() => {
                onNavigateAway?.();
                onOpenProfile();
              }}
            >
              <span className="klide-rail-profile-avatar" aria-hidden>
                {initialsOf(username || "?")}
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    onError={(event) => { event.currentTarget.style.display = "none"; }}
                  />
                ) : null}
              </span>
              <span className="klide-rail-profile-identity">
                <span className="klide-rail-profile-name">{username || "Local profile"}</span>
                <span className="klide-rail-profile-host">{hostname}</span>
              </span>
            </button>
            {footActions}
            <button
              type="button"
              className="klide-rail-view-switch"
              data-sound="tap"
              aria-label={settingsDest.label}
              title={`${settingsDest.label} (⌘,)`}
              onClick={() => {
                onNavigateAway?.();
                onOpenSettings();
              }}
            >
              <settingsDest.Icon size={15} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
