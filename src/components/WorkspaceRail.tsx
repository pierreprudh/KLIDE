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
// it, rendered by App.tsx for every surface. Two instances (one per shell) made
// a mode change an unmount and a mount: the entrance animation replayed and the
// files tree's expanded folders and scroll went with it. The shells differ only
// in what they hand it:
//
//   nav        the rows above the tree. Focus: New task, Mission Control,
//              Orchestrator, Memory, Skills. The workbench adds the panel
//              tools it alone can open — Explorer, Git, AI.
//   footActions the icon buttons on the identity row's ragged right edge —
//              the terminal toggle and the way out to the other shell. Both
//              slots are filled in both shells, so the foot never gains or
//              loses a button on a mode change; only the switch's icon morphs.
//   onOpenConversation  where a click in the tree lands. Focus resumes it on
//              its own canvas; the workbench resumes it into an AI panel.
//
// Everything else — the search row, the project list, the provider groups, the
// reveal choreography, the destinations at the foot — is defined once, here.
//
// The `klide-focus-*` class names are historical: this markup was Focus's, and
// renaming ~300 CSS rules would have been the risky half of a change whose
// point was to stop the two rails drifting. Read them as "the rail's".

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CloseIcon, FolderIcon, MoreIcon, PinIcon, SearchIcon, SidebarIcon } from "../icons";
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
  conversationIsRestorable,
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
import { conversationMark } from "../modelIdentity";
import { setConversationDrag } from "../conversationDrag";
import { useIsConversationRunning } from "../runningConversations";
import { keepOrder, providerHistoryExpanded } from "../focusHistory";
import { canonicalWorkspaceRoot, linkedProjectForPath } from "../projectPaths";

/** A row above the tree. `onClick` receives the meta/ctrl modifier so the
 *  workbench can keep ⌘+click stacking on its sidebar tools. */
export type RailNavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  /** When defined, the row is a disclosure — a chevron turns with it. Explorer
   *  uses it: the tree unfolds under the row rather than opening a surface. */
  expanded?: boolean;
  onClick: (meta: boolean) => void;
};

type Props = {
  workspaceRoot: string | null;
  /** Recent project roots (the same list the Projects menu shows). */
  projects: string[];
  nav: RailNavItem[];
  /** The provider whose group opens by default when the user has expressed no
   *  preference — the one the host is actually dispatching to. */
  activeProvider: ProviderId;
  /** The conversations the host is actually showing. They wear the active
   *  route through the tree: the branch that leads to each, drawn in the
   *  accent. That route is what says "you are here".
   *
   *  Usually one. A race watch is the case that makes it plural — a race is a
   *  comparison, both columns are on the canvas at once, and a rail that lit
   *  only the column the pointer last touched said the wrong thing about where
   *  you were. */
  selectedConversationIds?: readonly string[];
  /** Every conversation loaded somewhere right now. In Focus that is the
   *  selected one and nothing else; over the workbench's floating panels it is
   *  one per open AI panel, and the rail is the only surface that can say so.
   *  These read as strong text — present, but not where you are looking. */
  openConversationIds?: readonly string[];
  onSwitchProject: (root: string) => void;
  /** A tree row was opened. The conversation has already been re-resolved
   *  against durable history, so this is a record that exists. */
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
  /** Icon buttons on the identity row's ragged right edge. */
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

/** The curve turning off a spine into its row.
 *
 *  It draws only the turn — the vertical is the spine's own `::before` in
 *  tokens.css. The path starts at x=0.5 (the spine's pixel) with a vertical
 *  tangent and ends with a horizontal one, so the two strokes read as a single
 *  continuous line rather than a border meeting an SVG.
 *
 *  It also starts *below* the spine's top, at the same y the spine's own
 *  segment stops for a last child (`--rail-branch-depart`) — so the two never
 *  paint the same pixel twice. That matters: the line is semi-transparent, and
 *  a doubled stroke would darken exactly the stretch meant to look seamless.
 *
 *  The viewBox is 1:1 with the box CSS gives it, so these numbers are pixels: a
 *  quarter-circle of radius 8 from (.5, 7) down to (8.5, 15) — the row's
 *  junction — then a short run that stops `--rail-branch-gap` short of the
 *  row's icon. Note the arc is exactly a quarter: dx and dy both equal the
 *  radius, which is what makes it tangent-vertical where it leaves the trunk
 *  and tangent-horizontal where it reaches the row. An arc rather than a
 *  hand-tuned bezier because its curvature is constant; in a 1px hairline the
 *  eye reads any variation as a kink. So trunk, turn and run are one stroke.
 *
 *  The 13 is the box width CSS computes (spine → icon, less the clearance); the
 *  radius and start match `--rail-branch-radius` / `--rail-branch-depart`, which
 *  is exactly where the trunk's own segment stops. All four move together — if
 *  you retune one, retune the others. */
function TreeElbow() {
  return (
    <span className="klide-focus-tree-elbow" aria-hidden="true">
      <svg viewBox="0 0 13 16" fill="none" shapeRendering="geometricPrecision">
        <path
          className="klide-focus-tree-elbow-base"
          d="M.5 7 A8 8 0 0 0 8.5 15 H13"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          /* Normalises the path to 100 units so the reveal's dash animation in
             tokens.css is independent of the radius. */
          pathLength={100}
        />
        {/* Selection is a second stroke over the resting tree. Keeping the
            neutral path underneath lets the active colour sweep around the
            turn without making the branch disappear while it draws. */}
        <path
          className="klide-focus-tree-elbow-active"
          d="M.5 7 A8 8 0 0 0 8.5 15 H13"
          vectorEffect="non-scaling-stroke"
          pathLength={100}
        />
      </svg>
    </span>
  );
}

/* The rail runs on one indentation grid defined in tokens.css: a row's icon
   box sits at `--rail-row-pad`, so its centre line is `--rail-spine`, and a
   nested group hangs a hairline spine there and steps its content by
   `--rail-step`. Nesting is structural CSS — no hard-coded pixel indents. */

// One shared rail row for navigation and workspace disclosure. Hover/focus
// styling lives in CSS so pointer movement does not trigger React renders.
function NavRow({
  icon,
  label,
  onClick,
  active = false,
  expanded,
}: {
  icon: ReactNode;
  label: string;
  onClick: (meta: boolean) => void;
  active?: boolean;
  /** When defined, the row is a disclosure — a small chevron turns with it. */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => onClick(e.metaKey || e.ctrlKey)}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
      className="klide-focus-nav-row"
      data-active={active || undefined}
    >
      <span className="klide-focus-nav-icon">{icon}</span>
      <span className="klide-focus-nav-label">{label}</span>
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

/** The sticky project name. Wraps the row rather than being it, so its opaque
 *  background paints *beneath* the row's own hover/active fill — a pseudo-element
 *  on the row itself could not, since negative z-index children paint above
 *  their parent's background, not below it.
 *
 *  CSS cannot tell a sticky element that it has stuck, so the pinned hairline
 *  needs an observer — and it has to watch a zero-size sentinel at the block's
 *  top rather than the header itself. Observing the header directly (ratio < 1
 *  against a 1px-shrunk root) reports "stuck" for any header that is merely
 *  clipped at the *bottom* of the scroller too, so every project below the fold
 *  wears the pinned hairline while sitting still.
 *
 *  The sentinel has one job: it scrolls away. Un-intersecting *and* above the
 *  scroller's top edge means the header has taken its place; un-intersecting
 *  below means the block simply has not been reached. */
function ProjectHead({
  scrollRoot,
  children,
}: {
  scrollRoot: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRoot.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const rootTop = root.getBoundingClientRect().top;
        setPinned(!entry.isIntersecting && entry.boundingClientRect.top <= rootTop);
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollRoot]);

  return (
    <>
      <div ref={sentinelRef} className="klide-focus-project-sentinel" aria-hidden />
      <div className="klide-focus-project-head" data-pinned={pinned || undefined}>
        {children}
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="klide-focus-section-label">{children}</h2>;
}

function ConvoRow({
  convo,
  onOpen,
  onInspect,
  onDelete,
  onRename,
  pinned = false,
  onTogglePin,
  indent = false,
  selected = false,
  selectedEnd = false,
  open = false,
  onSelectedPath = false,
  revealDelay,
}: {
  convo: Conversation;
  onOpen: () => void;
  /** Remove this conversation from local history. Offered, with the other
   *  actions, behind the row's ⋯ menu — the row keeps one trailing mark. */
  onDelete?: () => void;
  /** Give this conversation the name typed into the row. Behind the ⋯ menu;
   *  the title itself becomes the input, so the rename happens where the
   *  name is read. */
  onRename?: (title: string) => void;
  /** Open this conversation in Mission Control rather than a panel. */
  onInspect?: () => void;
  /** Kept at the top of its group. Shown as a pin where the timestamp was. */
  pinned?: boolean;
  onTogglePin?: () => void;
  indent?: boolean;
  selected?: boolean;
  /** The last selected row in this group — where the active route peels into
   *  the elbow and the neutral trunk takes over again. Distinct from
   *  `selected` because two racers under one provider are both selected, and
   *  the route has to run *past* the first of them to reach the second. */
  selectedEnd?: boolean;
  /** Loaded in a panel, but not the one being shown. Strong text, no route —
   *  the step below `selected`, per the rule in tokens.css that the active
   *  route is what carries "you are here" while the row stays calm. */
  open?: boolean;
  /** Marks the vertical history segment leading to the selected conversation. */
  onSelectedPath?: boolean;
  /** Set only for rows in a tree — a flat search result appears at once. */
  revealDelay?: string;
}) {
  // What ran this thread, by the same precedence the Focus home cards use: the
  // CLI if a delegate ran it, else the model's maker, else the provider that
  // hosted it. The row used to ask `modelIdentity` alone, so a thread whose
  // model id names no maker Klide recognises — an OpenRouter vendor slug, an
  // unbranded local pull — drew no mark at all, and the tree read as if the
  // metadata had failed to load.
  const mark = conversationMark(convo.model, convo.provider, 15);
  const running = useIsConversationRunning(convo.id);
  // Captured once: see `useEntranceValue`. Recomputing this from the row's
  // current index is what made the tree replay on every list update.
  const entranceDelay = useEntranceValue(revealDelay);
  // Where the ⋯ menu is open, if it is. Anchored under the button it came
  // from, or at the pointer for a right-click on the row.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
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
  const markNode = mark ? (
    <span className="klide-focus-convo-model" title={mark.label} aria-hidden="true">
      {mark.node}
    </span>
  ) : null;

  return (
    /* The row is a plain box around two buttons, because a button cannot hold
       another: the open action is the whole row, the delete action is a small
       target at its trailing edge. The tree spine, the fill and the slide all
       still hang off the row itself, so nothing in tokens.css moved. */
    <div
      className="klide-focus-convo-row"
      data-nested={indent || undefined}
      data-selected={selected || undefined}
      data-selected-end={selectedEnd || undefined}
      data-open={(open && !selected) || undefined}
      data-selected-path={onSelectedPath || undefined}
      data-menu-open={menuAt ? true : undefined}
      /* How the slide finds this row again after the list re-sorts. */
      data-convo-id={convo.id}
      onContextMenu={
        hasMenu
          ? (e) => {
              e.preventDefault();
              setMenuAt({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
      style={
        entranceDelay ? ({ "--rail-reveal-delay": entranceDelay } as CSSProperties) : undefined
      }
    >
      {indent ? <TreeElbow /> : null}
      {renaming ? (
        <div className="klide-focus-convo-open" data-renaming="true">
          <span className="klide-focus-convo-content">
            {markNode}
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
          </span>
        </div>
      ) : (
      <button
        type="button"
        className="klide-focus-convo-open"
        onClick={onOpen}
        /* Draggable as well as clickable: a click opens the conversation where
           Focus normally puts one, a drag lets you say *which half* of a split
           canvas it lands in. The row keeps its click — HTML drag only starts
           once the pointer actually moves. */
        draggable
        onDragStart={(e) => {
          if (e.dataTransfer) setConversationDrag(e.dataTransfer, convo.id);
        }}
        /* One line, most urgent fact first — the tooltip is where a screen
           reader and a hovering pointer get what the route and the text weight
           say silently. */
        title={
          running
            ? `${convo.title} — running`
            : open && !selected
              ? `${convo.title} — open in a panel`
              : convo.title
        }
        aria-current={selected ? "page" : undefined}
      >
        <span className="klide-focus-convo-content">
          {markNode}
          <span className="klide-focus-convo-title">{displayTitle}</span>
          {/* The trailing slot says one thing at a time. While a run is going,
              "4m ago" is the least interesting fact about the row — the panel's
              own working animation takes the slot instead, so the same motion
              means the same thing in the rail as it does inside the chat. It
              replaces the timestamp rather than sitting next to it: the row keeps
              one trailing mark, and no badge is added to a rail that deliberately
              has none. */}
          {running ? (
            <span className="klide-focus-convo-live">
              <DotGridLoader size={11} color="var(--accent)" label="Running" />
            </span>
          ) : pinned ? (
            <span className="klide-focus-convo-time klide-focus-convo-pinned" title="Pinned" aria-label="Pinned">
              <PinIcon size={11} />
            </span>
          ) : (
            <span className="klide-focus-convo-time">{relativeTime(convo.updatedAt)}</span>
          )}
        </span>
      </button>
      )}
      {/* Same slot, on hover: the timestamp steps aside and one ⋯ takes its
          place, holding the rest — pin, inspect, delete — so the row itself
          never grows a second or third mark. Not offered while the run is
          live: its snapshot is still being written, and the loader already
          owns the slot. */}
      {hasMenu ? (
        <button
          type="button"
          className="klide-focus-convo-more"
          title="More"
          aria-label={`More actions for “${convo.title || "Untitled"}”`}
          aria-haspopup="menu"
          aria-expanded={menuAt ? true : undefined}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenuAt({ x: rect.right - 190, y: rect.bottom + 4 });
          }}
        >
          <MoreIcon size={15} />
        </button>
      ) : null}
      {menuAt ? <ContextMenu x={menuAt.x} y={menuAt.y} items={menuItems} onClose={() => setMenuAt(null)} /> : null}
    </div>
  );
}

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

/** Composite map key. The separator is a NUL escape rather than a literal
 *  control character in the source — a raw one makes every grep over this file
 *  report it as binary and go silent. */
function providerHistoryKey(project: string, historyProvider: ProviderId): string {
  return `${project}\u0000${historyProvider}`;
}

/* ── Expand choreography ───────────────────────────────────────────────────
   Opening a project reveals its tree in two beats: the providers cascade top to
   bottom, then the conversations beneath them follow. Each row carries its own
   `--rail-reveal-delay`, computed from its index here and consumed by the
   keyframes in tokens.css — DOM order drives the cascade, so there is no stack
   of nth-child rules to keep in sync with the data.

   The steps are much shorter than each row's own animation (see the envelope in
   tokens.css), so a row starts while the row above it is still settling. That
   overlap is the whole point: it reads as one wave travelling down the tree.
   Widen these and the cascade degrades into a queue of separate animations —
   the choppiness is in the gaps, not in the durations.

   The cap matters: a project with forty conversations must not turn a half-
   second reveal into a four-second one. Past the cap rows share the last delay
   and land together. */
const PROVIDER_REVEAL_STEP_MS = 30;
const CONVO_REVEAL_STEP_MS = 20;
/** Beat between the provider wave and the conversation wave. Small on purpose:
 *  the two should overlap enough to feel continuous while still reading in
 *  order. */
const REVEAL_PHASE_GAP_MS = 40;
const REVEAL_STAGGER_CAP = 12;

/** How many projects the rail lists. The rest are reached through "More", which
 *  runs the same Open Folder… the macOS File menu does — the rail stays a short
 *  list of what you are working on rather than a full recents browser. */
const PROJECT_ROW_LIMIT = 3;
const CONVERSATION_ROW_LIMIT = 5;

/** The rows a collapsed provider group shows.
 *
 *  The newest few, plus any conversation that is loaded in a panel right now:
 *  the rail is what tells you what is open, so an open conversation must never
 *  be the thing hiding behind "More". Pinned rows take the tail slots and keep
 *  their place in the newest-first order, and the window never grows past the
 *  limit — a collapsed group is a fixed height by design. */
export function visibleProviderConversations(
  conversations: Conversation[],
  showAll: boolean,
  pinnedConversationIds: ReadonlySet<string> = new Set(),
): Conversation[] {
  if (showAll || conversations.length <= CONVERSATION_ROW_LIMIT) return conversations;
  // Pinned rows claim their slots first, wherever they sit in the history —
  // taking the newest five and then patching the pinned ones into the tail
  // drops any pinned row that happened to be recent enough to already be there.
  const pinned = conversations
    .filter((conversation) => pinnedConversationIds.has(conversation.id))
    .slice(0, CONVERSATION_ROW_LIMIT);
  const newestFill = conversations
    .filter((conversation) => !pinnedConversationIds.has(conversation.id))
    .slice(0, CONVERSATION_ROW_LIMIT - pinned.length);
  const keep = new Set([...pinned, ...newestFill].map((conversation) => conversation.id));
  // Filtered from the source, so the window keeps newest-first order rather
  // than the order the two groups happened to be assembled in.
  return conversations.filter((conversation) => keep.has(conversation.id));
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

function revealDelay(index: number, stepMs: number, baseMs = 0): string {
  return `${baseMs + Math.min(index, REVEAL_STAGGER_CAP) * stepMs}ms`;
}

/** A value captured when its element enters, and kept for that element's life.
 *
 *  The cascade is an entrance, not a state. Its delays end up as real
 *  `animation-delay` values on live elements, and mutating one re-phases an
 *  animation that has already played — the row hides and replays. Since a
 *  row's delay was computed from its *current index*, any re-sort rewrote
 *  every delay below the row that moved, and the whole tree replayed its
 *  entrance. The list re-sorts by `updatedAt`, which a running conversation
 *  bumps on every message, so the rail re-displayed itself continuously while
 *  an agent worked.
 *
 *  Freezing it means a row animates once, when it arrives. A row that arrives
 *  later is a new element and captures its own delay; a collapsed group
 *  unmounts, so re-opening it still cascades. Movement afterwards is the
 *  slide's business (`useRowSlide`), not the entrance's. */
function useEntranceValue<T>(value: T): T {
  const [entrance] = useState(value);
  return entrance;
}

/** Slide rows to their new positions instead of teleporting them.
 *
 *  Standard FLIP: remember where each row was, and after the DOM moves it,
 *  start it from the offset it just left and let it travel to zero. Only rows
 *  that actually moved animate — a row arriving for the first time has no
 *  previous position and keeps its entrance instead.
 *
 *  It reads geometry in a layout effect, before paint, so the row is never
 *  seen in the wrong place. `translateY` only: transform and opacity are the
 *  two properties that don't touch layout, and the tree's trunks and curves
 *  are laid out around these rows. */
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

function ProviderHistoryGroup({
  group,
  expanded,
  selectedConversationIds,
  openConversationIds,
  revealIndex,
  conversationRevealBase,
  onToggle,
  onOpen,
  onInspect,
  onDelete,
  onRename,
  pinnedConversationIds: pinnedIds,
  onTogglePin,
}: {
  group: ProviderHistory;
  expanded: boolean;
  /** Showing right now — each wears the active route. */
  selectedConversationIds: ReadonlySet<string>;
  /** Loaded in some panel — marked a step below the selected one. */
  openConversationIds: ReadonlySet<string>;
  /** Position in the provider cascade — 0 is the first to appear. */
  revealIndex: number;
  /** Delay this group's conversations wait out before their own cascade. Zero
   *  when only this provider was toggled: nothing else is animating, so the
   *  click must be answered immediately rather than after a dead pause. */
  conversationRevealBase: number;
  onToggle: () => void;
  onOpen: (conversation: Conversation) => void;
  onInspect?: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
  onRename: (conversation: Conversation, title: string) => void;
  /** Kept at the top of the group, and always inside its collapsed window. */
  pinnedConversationIds: ReadonlySet<string>;
  onTogglePin: (conversation: Conversation) => void;
}) {
  const [showAllConversations, setShowAllConversations] = useState(false);
  // Pinned rows lead; recency orders the rest, held by `keepOrder` upstream.
  const orderedConversations = useMemo(
    () => orderPinnedFirst(group.conversations, pinnedIds),
    [group.conversations, pinnedIds],
  );
  const conversationListRef = useRef<HTMLDivElement>(null);
  const groupEntranceDelay = useEntranceValue(
    revealDelay(revealIndex, PROVIDER_REVEAL_STEP_MS),
  );
  const listEntranceBase = useEntranceValue(conversationRevealBase);
  // A re-sort moves rows; this carries them there. The order string is the
  // whole point — the effect must run when the sequence changes, not when a
  // title or a timestamp does.
  useRowSlide(conversationListRef, orderedConversations.map((c) => c.id).join());
  const disclosureStartHeightRef = useRef<number | null>(null);
  const disclosureAnimationRef = useRef<Animation | null>(null);
  // "Read only" used to mean "a delegate provider", because Focus could not run
  // one and a delegate conversation was always a PTY session with no transcript
  // behind it. Focus runs delegates headlessly now, so those conversations hold
  // real messages and reopen like any other. What actually decides it is whether
  // the stored conversation has anything to restore — which is also true of a
  // Klide run that never got past an empty first turn.
  const readOnly = group.conversations.every(
    (conversation) => !conversationIsRestorable(conversation),
  );
  const containsSelectedConversation = group.conversations.some((conversation) =>
    selectedConversationIds.has(conversation.id),
  );
  const countLabel = `${group.conversations.length} ${group.conversations.length === 1 ? "conversation" : "conversations"}`;
  // Everything loaded in a panel is pinned into the collapsed window — the
  // selected one included, since the host always reports it as open too.
  const visibleConversations = visibleProviderConversations(
    orderedConversations,
    showAllConversations,
    new Set([...openConversationIds, ...pinnedIds]),
  );
  // The active route runs from the group's junction down to the *last*
  // selected row. Taking the last rather than the first is what lets two
  // racers on one provider read as one continuous branch through both,
  // instead of a route that stops at the upper of the two.
  const lastSelectedConversationIndex = visibleConversations.reduce(
    (last, conversation, index) =>
      selectedConversationIds.has(conversation.id) ? index : last,
    -1,
  );
  const hasMoreConversations = group.conversations.length > CONVERSATION_ROW_LIMIT;

  /* `height: auto` cannot transition cleanly. Capture the old intrinsic height
     at click time, then let the browser interpolate to the newly rendered
     height while the existing row/branch choreography plays inside it. */
  useLayoutEffect(() => {
    const conversationList = conversationListRef.current;
    const startHeight = disclosureStartHeightRef.current;
    disclosureStartHeightRef.current = null;

    if (conversationList === null || startHeight === null) return;

    const targetHeight = conversationList.getBoundingClientRect().height;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || Math.abs(targetHeight - startHeight) < 1) return;

    conversationList.style.overflow = "hidden";
    const animation = conversationList.animate(
      [
        { height: `${startHeight}px` },
        { height: `${targetHeight}px` },
      ],
      {
        duration: showAllConversations ? 460 : 360,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
    );
    disclosureAnimationRef.current = animation;

    const releaseList = () => {
      if (disclosureAnimationRef.current !== animation) return;
      conversationList.style.removeProperty("overflow");
      disclosureAnimationRef.current = null;
    };
    animation.addEventListener("finish", releaseList, { once: true });
    animation.addEventListener("cancel", releaseList, { once: true });

    return () => {
      animation.cancel();
      releaseList();
    };
  }, [expanded, showAllConversations]);

  function toggleConversationDisclosure() {
    disclosureStartHeightRef.current =
      conversationListRef.current?.getBoundingClientRect().height ?? null;
    setShowAllConversations((shown) => !shown);
  }

  return (
    <div
      className="klide-focus-provider-history"
      data-readonly={readOnly || undefined}
      data-contains-selected={containsSelectedConversation || undefined}
      /* The wrapper carries the delay so its row, its trunk segment and its
         curve all read the same value — captured on entry, like the rows'. */
      style={{
        "--rail-reveal-delay": groupEntranceDelay,
      } as CSSProperties}
    >
      <button
        type="button"
        className="klide-focus-provider-history-row"
        onClick={onToggle}
        aria-expanded={expanded}
        /* Read-only is carried by the row's dimmer colour; the reason belongs
           in the tooltip, not in a badge beside the name. */
        title={`${providerName(group.provider)} · ${countLabel}${readOnly ? " · read only in Focus" : ""}`}
      >
        <TreeElbow />
        {/* Same wrapper the conversation rows use: the row's box starts on the
            spine, so its own fill would paint under the curve. The fill lives
            on the content instead, which begins after the elbow's run. */}
        <span className="klide-focus-provider-history-content">
          <span className="klide-focus-provider-history-logo" aria-hidden="true">
            <ProviderLogo id={group.provider} size={16} />
          </span>
          <span className="klide-focus-provider-history-name">
            {providerName(group.provider)}
          </span>
          <span className="klide-focus-provider-history-count" aria-label={countLabel}>
            {group.conversations.length}
          </span>
          <span className="klide-focus-provider-history-chevron" aria-hidden="true">
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
        </span>
      </button>

      {expanded ? (
        <>
          {/* The container's own delay drives the segment climbing back up to
              the provider's junction, so the trunk reaches down before the
              first conversation fades in. Rows then override it with their
              own. */}
          <div
            ref={conversationListRef}
            className="klide-focus-provider-conversations"
            data-contains-selected={containsSelectedConversation || undefined}
            style={{ "--rail-reveal-delay": `${listEntranceBase}ms` } as CSSProperties}
          >
            {visibleConversations.map((conversation, index) => {
              const disclosureIndex = showAllConversations
                ? Math.max(0, index - CONVERSATION_ROW_LIMIT)
                : index;
              const disclosureBase = showAllConversations ? 0 : conversationRevealBase;

              return (
                <ConvoRow
                  key={conversation.id}
                  convo={conversation}
                  indent
                  revealDelay={revealDelay(disclosureIndex, CONVO_REVEAL_STEP_MS, disclosureBase)}
                  selected={selectedConversationIds.has(conversation.id)}
                  selectedEnd={lastSelectedConversationIndex === index}
                  open={openConversationIds.has(conversation.id)}
                  onSelectedPath={lastSelectedConversationIndex >= index}
                  onOpen={() => onOpen(conversation)}
                  onInspect={onInspect ? () => onInspect(conversation) : undefined}
                  onDelete={() => onDelete(conversation)}
                  onRename={(title) => onRename(conversation, title)}
                  pinned={pinnedIds.has(conversation.id)}
                  onTogglePin={() => onTogglePin(conversation)}
                />
              );
            })}
          </div>
          {hasMoreConversations ? (
            <button
              type="button"
              className="klide-focus-more-conversations"
              aria-expanded={showAllConversations}
              aria-label={`${showAllConversations ? "Show fewer" : "Show all"} ${providerName(group.provider)} conversations`}
              onClick={toggleConversationDisclosure}
            >
              {showAllConversations ? "Less" : "More"}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- rail */

export function WorkspaceRail({
  workspaceRoot,
  projects,
  nav,
  activeProvider,
  selectedConversationIds,
  openConversationIds,
  onSwitchProject,
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
  // The rail lists only the few projects you are actually moving between — a
  // long recents list buries the history it is meant to introduce. "More"
  // unfolds the rest; opening a project that is not among them is the macOS
  // menu bar's job (File ▸ Open Folder…), not a second picker in here.
  const [showAllProjects, setShowAllProjects] = useState(false);
  // Width and fold are persisted settings rather than local state: both shells
  // render this component, and the rail should be the width you left it at
  // whichever one you come back through. ⌘B (App.tsx) writes the same setting.
  const [railWidth, setRailWidth] = useSetting(SETTINGS.railWidth);
  const [collapsed, setCollapsed] = useSetting(SETTINGS.railCollapsed);
  // The width the pointer is currently holding the rail at, or null when no
  // drag is in flight. It exists so a drag can be *exactly* the pointer — every
  // width, including ones the rail is not allowed to rest at — while the stored
  // width stays a legal one. Release is what settles the two, and because the
  // fold's transition comes back the moment this clears, that settle is a
  // movement rather than a jump.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { username, hostname, avatarUrl } = useUserInfo();
  const searchRef = useRef<HTMLInputElement>(null);
  // The rail's scroller — the sticky project names observe it to know when they
  // have pinned.
  const railBodyRef = useRef<HTMLDivElement>(null);
  // Several projects can hold their history open at once. The active project
  // opens itself; the rest remember their state for the session.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectRoot ? [activeProjectRoot] : [])
  );
  // Absence means "follow the active provider". Explicit booleans preserve
  // the user's disclosure choice independently for every project/provider.
  const [expandedProviderGroups, setExpandedProviderGroups] = useState<Map<string, boolean>>(
    () => new Map()
  );
  // Projects whose whole tree is being revealed, so their conversations wait out
  // the provider cascade. A project drops out once a provider inside it is
  // toggled on its own — from then on that click is the only thing animating and
  // must be answered at once.
  const [cascadingProjects, setCascadingProjects] = useState<Set<string>>(
    () => new Set(activeProjectRoot ? [activeProjectRoot] : [])
  );

  useEffect(() => {
    if (!activeProjectRoot) return;
    setExpandedProjects((prev) => {
      if (prev.has(activeProjectRoot)) return prev;
      const next = new Set(prev);
      next.add(activeProjectRoot);
      return next;
    });
    // Switching to a project opens its tree, so that reveal is a full cascade.
    setCascadingProjects((prev) => {
      if (prev.has(activeProjectRoot)) return prev;
      const next = new Set(prev);
      next.add(activeProjectRoot);
      return next;
    });
  }, [activeProjectRoot]);

  function toggleProject(p: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
    setCascadingProjects((prev) => {
      const next = new Set(prev);
      next.add(p);
      return next;
    });
  }

  // `currentlyExpanded` is the state the row is actually rendering, resolved by
  // providerHistoryExpanded at the call site. Taking it from there rather than
  // recomputing a default here is the whole point: this used to fall back to
  // `historyProvider === provider`, which disagrees with the renderer's
  // "active OR newest" rule. On the newest group of a non-active provider the
  // two answers differed, so the first click wrote the value the row already
  // had and nothing moved — it took two clicks to collapse.
  function toggleProviderHistory(
    project: string,
    historyProvider: ProviderId,
    currentlyExpanded: boolean,
  ) {
    const key = providerHistoryKey(project, historyProvider);
    setExpandedProviderGroups((prev) => {
      const next = new Map(prev);
      next.set(key, !currentlyExpanded);
      return next;
    });
    // This click is now the only thing animating in that project.
    setCascadingProjects((prev) => {
      if (!prev.has(project)) return prev;
      const next = new Set(prev);
      next.delete(project);
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
      if (!detail) return;
      const project = linkedProjectForPath(detail.cwd, railProjects);
      if (!project) return;

      // Work in a secondary AI panel still belongs in the rail. Reveal the
      // owning project/provider rather than leaving the new row hidden
      // because the primary panel happens to use another provider.
      setExpandedProjects((previous) => {
        if (previous.has(project)) return previous;
        const next = new Set(previous);
        next.add(project);
        return next;
      });
      setExpandedProviderGroups((previous) => {
        const key = providerHistoryKey(project, detail.provider);
        if (previous.get(key) === true) return previous;
        const next = new Map(previous);
        next.set(key, true);
        return next;
      });
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, reload);
  }, [railProjects]);

  useEffect(() => {
    setConvos(loadConversations<Conversation>());
  }, [reloadKey, searchOpen]);

  const folderedHistory = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    const projectByConversationId = new Map<string, string>();
    for (const c of convos) {
      const linkedProject = linkedProjectForPath(c.cwd, railProjects);
      if (!linkedProject) continue;
      projectByConversationId.set(c.id, linkedProject);
      const list = byProject.get(linkedProject);
      if (list) list.push(c);
      else byProject.set(linkedProject, [c]);
    }
    return { byProject, projectByConversationId };
  }, [convos, railProjects]);
  const convosByProject = folderedHistory.byProject;
  const linkedProjectByConversationId = folderedHistory.projectByConversationId;
  // Recency picks the order; `keepOrder` decides when it is allowed to change.
  // Without it the tree re-sorts on every message of every live run — see the
  // note on `keepOrder` for what that looked like with two providers running.
  const orderMemory = useRef<Map<string, string[]>>(new Map());
  const providerHistoriesByProject = useMemo(() => {
    const byProject = new Map<string, ProviderHistory[]>();
    for (const [project, projectHistory] of convosByProject) {
      const groups = groupHistoryByProvider(projectHistory).map((group) => ({
        ...group,
        conversations: keepOrder(
          group.conversations,
          (conversation) => conversation.id,
          orderMemory.current,
          providerHistoryKey(project, group.provider),
        ),
      }));
      byProject.set(
        project,
        keepOrder(groups, (group) => group.provider, orderMemory.current, project),
      );
    }
    return byProject;
  }, [convosByProject]);

  /* The rail lists only the few projects you are actually moving between — a
     long recents list buries the history it is meant to introduce. "More"
     unfolds the rest; opening a project that is not among them is the macOS
     menu bar's job (File ▸ Open Folder…), not a second picker in here.

     Two projects are never allowed into the hidden tail, whatever their
     recency: the one that is open, or the rail stops describing where you
     are — and any project holding a conversation that is loaded in a panel,
     because the tree is what tells you what is open and it cannot do that from
     behind a "More". */
  const projectsOwningOpenConversations = useMemo(() => {
    const owners = new Set<string>();
    for (const conversationId of openIds) {
      const owner = linkedProjectByConversationId.get(conversationId);
      if (owner) owners.add(owner);
    }
    return owners;
  }, [openIds, linkedProjectByConversationId]);

  const visibleProjects = useMemo(() => {
    if (showAllProjects || railProjects.length <= PROJECT_ROW_LIMIT) return railProjects;
    const pinned = railProjects.filter(
      (project) => project === activeProjectRoot || projectsOwningOpenConversations.has(project),
    );
    // Pinned first, in recency order, then fill the remaining slots from the
    // top of the list. A workspace with more live panels than slots shows the
    // panels — that is the more urgent fact — and "More" holds the rest.
    const rest = railProjects.filter((project) => !pinned.includes(project));
    return [...pinned, ...rest].slice(0, Math.max(PROJECT_ROW_LIMIT, pinned.length));
  }, [
    activeProjectRoot,
    projectsOwningOpenConversations,
    railProjects,
    showAllProjects,
  ]);
  const hiddenProjectCount = railProjects.length - visibleProjects.length;

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

  /** Remove a conversation from local history. The Run transcript stays on
   *  disk and in Mission Control; only the resumable snapshot goes. Forgetting
   *  it publishes the deletion, so any panel showing the thread drops it
   *  before its next persist could write it back. */
  function renameHistoryConversation(conversation: Conversation, title: string) {
    // One call names the thread in both records — the Stored conversation the
    // rail reads and the Mission Control row — and the store's change event
    // brings every other rail along.
    renameKlideConvo(conversation.id, title);
    setConvos(loadConversations<Conversation>());
  }

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
    const conversationProject = linkedProjectByConversationId.get(resolved.id);
    if (conversationProject) {
      const historyProvider = resolved.provider ?? "ollama";
      setExpandedProjects((prev) => {
        if (prev.has(conversationProject)) return prev;
        const next = new Set(prev);
        next.add(conversationProject);
        return next;
      });
      setExpandedProviderGroups((prev) => {
        const key = providerHistoryKey(conversationProject, historyProvider);
        if (prev.get(key) === true) return prev;
        const next = new Map(prev);
        next.set(key, true);
        return next;
      });
    }
    // History is navigation, not a second reader mode. Resume the saved
    // conversation into the fully wired AiPanel the host owns.
    onOpenConversation(resolved);
  }

  /* A conversation that has just been loaded into a panel has to become
     visible in the tree — pinning it into the collapsed row window is no use
     if its provider group or its project is folded shut.

     Only *newly* open ids do this. Re-running for the whole set on every
     render would refuse to let you collapse a group while its conversation is
     still loaded, which is a legitimate thing to want; this expands once, on
     the transition, and then leaves the disclosure alone. */
  /* Starts empty rather than at the current set, so a session that comes back
     up with panels already restored reveals them on the first pass — the
     default "active provider or newest" disclosure has no idea which
     conversations a panel is holding. */
  const revealedOpenIds = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const previouslyOpen = revealedOpenIds.current;
    revealedOpenIds.current = openIds;
    const arrived = [...openIds].filter((id) => !previouslyOpen.has(id));
    if (arrived.length === 0) return;

    const projectsToOpen: string[] = [];
    const groupsToOpen: string[] = [];
    for (const conversationId of arrived) {
      const project = linkedProjectByConversationId.get(conversationId);
      if (!project) continue;
      projectsToOpen.push(project);
      const conversationProvider =
        convos.find((c) => c.id === conversationId)?.provider ?? "ollama";
      groupsToOpen.push(providerHistoryKey(project, conversationProvider));
    }
    if (projectsToOpen.length === 0) return;

    setExpandedProjects((prev) => {
      if (projectsToOpen.every((project) => prev.has(project))) return prev;
      const next = new Set(prev);
      for (const project of projectsToOpen) next.add(project);
      return next;
    });
    setExpandedProviderGroups((prev) => {
      if (groupsToOpen.every((key) => prev.get(key) === true)) return prev;
      const next = new Map(prev);
      for (const key of groupsToOpen) next.set(key, true);
      return next;
    });
  }, [openIds, linkedProjectByConversationId, convos]);

  const searching = searchOpen && query.trim().length > 0;

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
         its tree state, its scroll position and its history subscriptions all
         survive the fold, so bringing it back is instant instead of a reload
         and a re-run of the reveal cascade. The clip below hides the contents,
         and the width between the two states is what animates. */
      data-collapsed={collapsed || undefined}
      data-dragging={dragWidth !== null || undefined}
      /* Above the docks and above the free layout's floating panels — that band
         climbs by one with every focus event, so the rail cannot hold a small
         local z the way it could when only Focus rendered it. */
      style={{
        zIndex: Z.rail,
        width: dragWidth ?? (collapsed ? 0 : railWidth),
        // The sampled spring briefly crosses its target. Codex clamps its
        // animated progress before multiplying by the open width; maxWidth is
        // the CSS equivalent, so opening settles at the stored width instead
        // of making the whole layout bulge past it.
        maxWidth: dragWidth === null ? railWidth : RAIL_MAX_WIDTH,
      }}
    >
      <RailEdge
        collapsed={collapsed}
        width={railWidth}
        onEdgeMoved={(edgeX, startedCollapsed) => {
          setDragWidth(railDragWidth(edgeX, startedCollapsed));
          // The fold state still updates live, so the contents fade as you
          // cross the point they will fold at — the gesture says what it is
          // going to do before you commit to it. Read back through the store
          // rather than the closure: this handler is captured for the whole
          // drag, so its own `collapsed` is one mouse-move out of date, and
          // writing every frame would put a localStorage write in the gesture.
          const folding = railFromEdge(edgeX, startedCollapsed).collapsed;
          if (folding !== getSetting(SETTINGS.railCollapsed)) setCollapsed(folding);
        }}
        onEdgeReleased={(edgeX, startedCollapsed) => {
          const settled = railFromEdge(edgeX, startedCollapsed);
          setCollapsed(settled.collapsed);
          if (settled.width !== null) setRailWidth(settled.width);
          // Last: clearing the drag hands the width back to the transition, so
          // an out-of-bounds release eases into the legal width instead of
          // snapping to it.
          setDragWidth(null);
        }}
        onToggle={() => setCollapsed(!collapsed)}
      />

      {/* Two wrappers, and each earns its keep. The clip is what the fold
          actually is — the rail's own width animates to zero and this hides
          what no longer fits — and the inner holds the content at its full
          width throughout, so the tree slides out of view instead of
          reflowing every label through 200 narrower layouts on the way. */}
      <div className="klide-rail-clip" inert={collapsed}>
        {/* The drag region rides down here with the content: Tauri only moves
            the window for the element the pointer actually hits, and after the
            wrap that element is the inner, never the aside. */}
        <div className="klide-rail-inner" style={{ width: railWidth }} data-tauri-drag-region>
          {/* Brand row doubles as the search row: the field takes the brand slot
              rather than pushing a new row in, so opening search never moves the
              list it filters. */}
          <div className="klide-focus-brand">
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
            ) : (
              /* Reserved slot — the logo drops in here. */
              <span className="klide-focus-brand-slot" aria-hidden="true" />
            )}
            <button
              type="button"
              className="klide-focus-brand-action"
              aria-label={searchOpen ? "Close conversation search" : "Search conversations"}
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
                onClick={(meta) => {
                  onNavigateAway?.();
                  item.onClick(meta);
                }}
              />
            ))}
          </div>

          {/* Section break — a gradient hairline, not another written label,
              separating the actions and the tree above from the history
              below. */}
          <div aria-hidden="true" className="klide-focus-rail-divider" />

          <div className="klide-focus-rail-body" ref={railBodyRef}>
            {searching ? (
              <>
                <SectionLabel>Results</SectionLabel>
                {filtered.length === 0 ? (
                  <p className="klide-focus-rail-empty">No conversations match.</p>
                ) : (
                  <div className="klide-focus-project-list">
                    {filtered.map((c) => (
                      <ConvoRow
                        key={c.id}
                        convo={c}
                        selected={selectedIds.has(c.id)}
                        open={openIds.has(c.id)}
                        onOpen={() => openHistoryConversation(c)}
                        onInspect={
                          onOpenConversationInMissionControl
                            ? () => onOpenConversationInMissionControl(c)
                            : undefined
                        }
                        onDelete={() => deleteHistoryConversation(c)}
                        onRename={(title) => renameHistoryConversation(c, title)}
                        pinned={pinnedIds.has(c.id)}
                        onTogglePin={() => togglePin(c)}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {railProjects.length === 0 && (
                  <p className="klide-focus-rail-empty">Open a folder to start.</p>
                )}
                <div className="klide-focus-project-list">
                  {visibleProjects.map((p) => {
                    const isActive = p === activeProjectRoot;
                    const isExpanded = expandedProjects.has(p);
                    const history = convosByProject.get(p) ?? [];
                    const providerHistories = providerHistoriesByProject.get(p) ?? [];
                    return (
                      <div key={p} className="klide-focus-project">
                        {/* The project's name pins to the top of the rail while you
                            read down its history, and hands over when the next
                            project reaches it — so you always know whose
                            conversations you are looking at. */}
                        <ProjectHead scrollRoot={railBodyRef}>
                          <NavRow
                            icon={<FolderIcon size={14} />}
                            label={basename(p)}
                            active={isActive}
                            expanded={isExpanded}
                            onClick={() => {
                              // Switching makes a project current; clicking the
                              // current one just folds its history open/closed.
                              if (isActive) toggleProject(p);
                              else {
                                onNavigateAway?.();
                                onSwitchProject(p);
                              }
                            }}
                          />
                        </ProjectHead>
                        {isExpanded && history.length > 0 ? (
                          <div
                            className="klide-focus-provider-groups"
                            data-contains-selected={
                              history.some((c) => selectedIds.has(c.id)) || undefined
                            }
                          >
                            {providerHistories.map((providerHistory, providerIndex) => {
                              const key = providerHistoryKey(p, providerHistory.provider);
                              const providerExpanded = providerHistoryExpanded(
                                expandedProviderGroups.get(key),
                                providerHistory.provider,
                                activeProvider,
                                providerHistories[0]?.provider,
                              );
                              return (
                                <ProviderHistoryGroup
                                  key={providerHistory.provider}
                                  group={providerHistory}
                                  expanded={providerExpanded}
                                  selectedConversationIds={selectedIds}
                                  openConversationIds={openIds}
                                  revealIndex={providerIndex}
                                  conversationRevealBase={
                                    cascadingProjects.has(p)
                                      ? providerHistories.length * PROVIDER_REVEAL_STEP_MS +
                                        REVEAL_PHASE_GAP_MS
                                      : 0
                                  }
                                  onToggle={() =>
                                    toggleProviderHistory(
                                      p,
                                      providerHistory.provider,
                                      providerExpanded,
                                    )
                                  }
                                  onOpen={openHistoryConversation}
                                  onInspect={onOpenConversationInMissionControl}
                                  onDelete={deleteHistoryConversation}
                                  onRename={renameHistoryConversation}
                                  pinnedConversationIds={pinnedIds}
                                  onTogglePin={togglePin}
                                />
                              );
                            })}
                          </div>
                        ) : null}
                        {isExpanded && history.length === 0 ? (
                          <p className="klide-focus-rail-empty" data-nested="true">
                            No conversations yet.
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                  {/* Unfolds the rest of the recents. Opening a project that is not
                      in that list belongs to the macOS menu bar — File ▸ Open
                      Folder… (⌘O) — so the rail never grows a second picker. */}
                  {hiddenProjectCount > 0 || showAllProjects ? (
                    <button
                      type="button"
                      className="klide-focus-more-projects"
                      aria-expanded={showAllProjects}
                      onClick={() => setShowAllProjects((shown) => !shown)}
                    >
                      {showAllProjects ? "Less" : "More"}
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>

          {/* Destinations — read from one definition (../railDestinations) so
              adding one never means editing two places. They are labeled rows like
              every other row here; Profile is the exception, drawn as the identity
              card because it has a name and a host to show. */}
          <div className="klide-rail-dest-group">
            <NavRow
              icon={<settingsDest.Icon size={15} />}
              label={settingsDest.label}
              onClick={() => {
                onNavigateAway?.();
                onOpenSettings();
              }}
            />
            {/* Identity row — the profile card takes the space its name and host
                need, and the shell's own controls hang off the ragged right edge.
                They sit apart from the destinations above because they change the
                shell rather than opening a surface. */}
            <div className="klide-rail-identity-row">
              <button
                type="button"
                className="klide-rail-profile"
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
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
