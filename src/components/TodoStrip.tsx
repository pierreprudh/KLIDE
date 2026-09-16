import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { formatSpan } from "../time";
import {
  attemptLabel,
  formatOffset,
  historyOf,
  planStartedAt,
  workFloors,
  type TodoEvent,
  type TodoItem,
  type TodoMoment,
} from "../todoHistory";
import { useElapsed } from "./ai/WorkingRow";
import { PlanIcon } from "../icons";
import "./todoStrip.css";

type TodoStore = {
  todos: TodoItem[];
  next_id: number;
  events?: TodoEvent[];
  next_event_id?: number;
};

const DISMISSED_TODOS_KEY = "klide.todoStrip.dismissedCompleted";

// ~5 rows before the list scrolls; keeps the card off the conversation. A
// row with its drawer open gets more, so the history is readable without
// scrolling inside a scroller.
const MAX_LIST_HEIGHT: Record<TodoStripVariant, number> = { dock: 118, island: 360 };
const MAX_LIST_HEIGHT_OPEN: Record<TodoStripVariant, number> = { dock: 214, island: 480 };

function readDismissedTodoStrips(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DISMISSED_TODOS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeDismissedTodoStrips(map: Record<string, string>) {
  try {
    const entries = Object.entries(map).slice(-200);
    localStorage.setItem(DISMISSED_TODOS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* localStorage is convenience only */
  }
}

function dismissalKey(workspaceRoot: string | null, conversationId: string): string {
  return `${workspaceRoot ?? "no-workspace"}::${conversationId}`;
}

// The shape of the plan, not its progress: hiding a plan has to survive the
// agent ticking items off, and only a *different* plan brings the strip back.
function planSignature(items: TodoItem[]): string {
  return `${items.length}:${items.map((item) => item.id).join("|")}`;
}

function planWasHidden(
  workspaceRoot: string | null,
  conversationId: string,
  signature: string
): boolean {
  return readDismissedTodoStrips()[dismissalKey(workspaceRoot, conversationId)] === signature;
}

function rememberPlanHidden(
  workspaceRoot: string | null,
  conversationId: string,
  signature: string
) {
  const map = readDismissedTodoStrips();
  map[dismissalKey(workspaceRoot, conversationId)] = signature;
  writeDismissedTodoStrips(map);
}

function forgetPlanHidden(workspaceRoot: string | null, conversationId: string) {
  const map = readDismissedTodoStrips();
  delete map[dismissalKey(workspaceRoot, conversationId)];
  writeDismissedTodoStrips(map);
}

function CheckIcon() {
  return (
    <svg className="klide-todo-check" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      style={{ transform: `rotate(${open ? 180 : 0}deg)`, transition: "transform 0.15s ease" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function safeScope(scope: string): string {
  return scope.replace(/[^A-Za-z0-9_-]/g, "_");
}

// The hairline between the header and the list. It used to fill with accent
// as steps closed, but the header now carries the state itself (the mark, the
// count, "Completed"), and collapsed it sat at the card's very bottom, where a
// second line under a bordered card read as a green bar. So it is only a
// separator now, and only while there is a list to separate.
function HeaderRule({ shown, inset }: { shown: boolean; inset: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        height: 1,
        marginLeft: -inset,
        marginRight: -inset,
        background: "var(--border)",
        opacity: shown ? 1 : 0,
        transition: "opacity var(--motion-med) var(--ease-soft)",
      }}
    />
  );
}

// "3/7" in mono — a count is more useful than a rounded percentage, and it
// doesn't read as dead ("0%") at the start of a plan.
function CountLabel({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  return (
    <span
      style={{
        color: "var(--fg-subtle)",
        fontSize: 10.5,
        fontWeight: 500,
        fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {done}/{total}
    </span>
  );
}

function GoalLine({ goal, size }: { goal: string; size: number }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0, whiteSpace: "nowrap" }}>
      <span
        style={{
          flex: "none",
          color: "var(--fg-dim)",
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
        }}
      >
        Goal
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--fg-strong)",
          fontSize: size,
          fontWeight: 460,
        }}
      >
        {goal}
      </span>
    </span>
  );
}

// The mark at the head of each row says what state the step is in without a
// colored dot: a pending step shows its number, the step being worked on wears
// a thin arc sweeping around that number, a finished step closes to a check.
// Numbers instead of hollow circles — type over shape, and "3" already tells
// you where in the plan you are.
const MARK = 14;
// The header ends in two 18px icon boxes (collapse, hide). Rows end in the same
// width so their chevron sits under the header's, and the figures on every row
// stop at the same x as the header count — one right edge for the whole strip.
const ICON = 18;
const RIGHT_GAP = 12;
// How long each exit plays before the other takes the corner (todoStrip.css).
const CARD_EXIT_MS = 220;
const MARK_EXIT_MS = 140;
// Opening is sequenced: the column slides over first, the card rises into the
// space once it is mostly there, and the rows follow the card. These are the
// island's head start over its own rows and the rows' over each other.
const ISLAND_ENTER_DELAY_MS = 240;
const ROW_STAGGER_MS = 26;
// The dock's header ends in collapse + hide; the island's in hide alone (its
// header is the collapse target and is too narrow to spend a box on saying so).
const ICON_COLUMN: Record<TodoStripVariant, number> = { dock: ICON * 2 + 2, island: ICON };

/** Where the strip lives. `dock` floats over the foot of the conversation and
 *  leans on the composer; `island` sits at the top-right of the Focus canvas,
 *  the Git island's spot and its shape, and rises in the way it does. */
export type TodoStripVariant = "dock" | "island";

/** How much of the column the strip is asking for. */
export type TodoStripSlot = "card" | "mark" | "none";

/** The island's width. Focus centres the conversation in the space to its
 *  left while the island is up (AiPanel), so the two never overlap. */
export const ISLAND_WIDTH = 320;

export function StepMark({ index, state }: { index: number; state: "todo" | "active" | "done" }) {
  const r = (MARK - 1.5) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="klide-todo-mark"
      data-state={state}
      style={{
        position: "relative",
        width: MARK,
        height: MARK,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        // opaque so the thread breaks cleanly at each node
        background: state === "done" ? "var(--accent)" : "var(--bg-elevated)",
        color: state === "done" ? "var(--bg-elevated)" : state === "active" ? "var(--fg-strong)" : "var(--fg-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        fontWeight: 600,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {state !== "done" && (
        <svg width={MARK} height={MARK} viewBox={`0 0 ${MARK} ${MARK}`} aria-hidden style={{ position: "absolute", inset: 0 }}>
          <circle
            cx={MARK / 2}
            cy={MARK / 2}
            r={r}
            fill="none"
            stroke={state === "active" ? "var(--border)" : "color-mix(in srgb, var(--fg-dim) 45%, transparent)"}
            strokeWidth={state === "active" ? 1.5 : 1}
          />
        </svg>
      )}
      {state === "active" && (
        <svg className="klide-todo-ring" width={MARK} height={MARK} viewBox={`0 0 ${MARK} ${MARK}`} aria-hidden>
          <circle
            cx={MARK / 2}
            cy={MARK / 2}
            r={r}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray={`${c * 0.3} ${c * 0.7}`}
          />
        </svg>
      )}
      {state === "done" ? <CheckIcon /> : <span style={{ position: "relative" }}>{index + 1}</span>}
    </span>
  );
}

// The active step counts up beside its label, the same mono figures the
// Working row and the thinking header use — one language for "busy".
function LiveSince({ since }: { since: number }) {
  const elapsed = useElapsed(since);
  return <>{elapsed}</>;
}

const MOMENT_LABEL: Record<TodoMoment["kind"], string> = {
  planned: "Planned",
  reworded: "Reworded",
  done: "Done",
  reopened: "Reopened",
};

function MomentLine({ moment, index, planStart }: { moment: TodoMoment; index: number; planStart: number }) {
  const label =
    moment.kind === "done" && moment.span !== undefined && moment.span >= 1000
      ? `Done in ${formatSpan(moment.span)}`
      : MOMENT_LABEL[moment.kind];
  return (
    <div
      className="klide-todo-moment"
      style={{ ["--i" as string]: index, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", columnGap: 10, alignItems: "baseline" }}
    >
      <span style={{ minWidth: 0, fontSize: 11.5, lineHeight: "17px", color: "var(--fg-subtle)" }}>
        {label}
        {moment.was && (
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--fg-dim)",
              fontStyle: "italic",
            }}
          >
            was “{moment.was}”
          </span>
        )}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          lineHeight: "17px",
          color: "var(--fg-dim)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatOffset(moment.at - planStart)}
      </span>
    </div>
  );
}

// One step of the plan. The head is a button: click it and the row's history
// drops down under it — when it was planned, how it was reworded, whether it
// was reopened, how long it took — threaded on the same line the rows hang
// from. Same expandable grammar as the thinking block, so a reader who has
// opened one knows how to open the other.
function TodoRow({
  item,
  index,
  active,
  isLast,
  threadInFilled,
  open,
  onToggle,
  events,
  planStart,
  startedAfter,
  iconColumn,
  roomy,
  enterDelay,
}: {
  item: TodoItem;
  index: number;
  active: boolean;
  isLast: boolean;
  threadInFilled: boolean;
  open: boolean;
  onToggle: () => void;
  events: TodoEvent[];
  planStart: number;
  startedAfter: number;
  iconColumn: number;
  /** The island's looser rhythm: taller rows, body-size text. */
  roomy: boolean;
  /** Head start before this row's own entrance — the island's, when it has one. */
  enterDelay: number;
}) {
  const history = historyOf(item, events, startedAfter);
  const tries = attemptLabel(history.reopened);
  const state = item.done ? "done" : active ? "active" : "todo";

  return (
    <div
      className="klide-todo-row"
      data-open={open ? "1" : "0"}
      style={{ position: "relative", animationDelay: `${enterDelay + Math.min(index, 7) * ROW_STAGGER_MS}ms` }}
    >
      {/* thread in: filled once the task above is done */}
      {index > 0 && (
        <span aria-hidden className="klide-todo-link" data-filled={threadInFilled ? "1" : "0"} style={{ top: 0, height: roomy ? 15 : 12, left: MARK / 2 - 0.5 }}>
          <i />
        </span>
      )}
      {/* thread out: filled once this task is done; runs on through the open drawer */}
      {(!isLast || open) && (
        <span aria-hidden className="klide-todo-link" data-filled={item.done ? "1" : "0"} style={{ top: roomy ? 15 : 12, bottom: isLast ? 6 : 0, left: MARK / 2 - 0.5 }}>
          <i />
        </span>
      )}

      <button
        type="button"
        className="klide-todo-row-head"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: "grid",
          gridTemplateColumns: `${MARK}px minmax(0, 1fr) auto ${iconColumn}px`,
          // The island's text wraps, so its cells pin to the first line: the
          // mark sits on that line and the thread meets it there.
          alignItems: roomy ? "start" : "center",
          columnGap: RIGHT_GAP,
          minHeight: roomy ? 30 : 24,
          padding: 0,
        }}
      >
        <span style={{ display: "grid", marginTop: roomy ? 8 : 0 }}>
          <StepMark index={index} state={state} />
        </span>
        <span
          style={{
            minWidth: 0,
            overflow: roomy ? "visible" : "hidden",
            textOverflow: roomy ? undefined : "ellipsis",
            whiteSpace: roomy ? "normal" : "nowrap",
            padding: roomy ? "6px 0" : 0,
            fontSize: roomy ? 13 : 12.5,
            lineHeight: "18px",
            fontWeight: active ? 500 : 400,
            color: item.done ? "var(--fg-dim)" : active ? "var(--fg-strong)" : "var(--fg-subtle)",
            textDecoration: item.done ? "line-through" : "none",
            textDecorationColor: item.done ? "color-mix(in srgb, var(--fg-dim) 55%, transparent)" : undefined,
            transition: "color var(--motion-slow) var(--ease-soft)",
          }}
        >
          {item.text}
        </span>
        {/* the row's own figures: a live count while active, the span once done,
            and a quiet "2nd try" when the step had to be reopened */}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--fg-dim)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            display: "inline-flex",
            gap: 8,
            marginTop: roomy ? 6 : 0,
            lineHeight: "18px",
          }}
        >
          {tries && <span>{tries}</span>}
          {active && <LiveSince since={history.attemptStartedAt} />}
          {item.done && history.doneIn !== undefined && history.doneIn >= 1000 && <span>{formatSpan(history.doneIn)}</span>}
        </span>
        <span className="klide-todo-chev" aria-hidden style={{ width: ICON, height: ICON, marginTop: roomy ? 6 : 0, display: "grid", placeItems: "center", color: "var(--fg-dim)" }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      <div className="klide-todo-drawer" data-open={open ? "1" : "0"} aria-hidden={!open}>
        <div>
          <div style={{ padding: `2px ${iconColumn + RIGHT_GAP}px 6px ${MARK + RIGHT_GAP}px`, display: "flex", flexDirection: "column", gap: 1 }}>
            {history.moments.map((moment, i) => (
              <MomentLine key={`${moment.kind}-${moment.at}-${i}`} moment={moment} index={i} planStart={planStart} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Opaque narrow panel that floats over the bottom of the conversation and
// docks onto the composer. Narrower than the chat, so messages stay visible in
// the side margins. No shadow — it cast a dark halo (the "black bars") in dark
// themes; the hairline alone defines the panel. One hairline on three sides:
// a top-only border under a 14px radius curved away into nothing at each
// corner and read as a glow, and border-strong was a heavier line than any
// other card in the panel draws. No backdrop-filter — solid surface (the
// webview has a known backdrop-filter bug).
const glassCard: CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid color-mix(in srgb, var(--border-strong) 45%, transparent)",
  borderBottom: "none",
};

// Floats just above the composer, INSIDE the conversation area. It must not
// overlap the composer (no negative bottom): the chatbox is wider than this
// narrow bar, so any overlap makes the composer's rounded top corners peek out
// on either side of the bar.
// The Focus canvas' top-right corner, where the Git island lives when no
// conversation is open. Same glass, same border, same radius, so the two read
// as one family of windows on the canvas; the wrapper carries the entrance and
// the swell (todoStrip.css) and the card inside stays still.
//
// The corner itself belongs to the column AiPanel puts there, not to this
// card: a pending question stacks under the plan in the same column, and two
// cards each positioning themselves against the canvas would have had to
// measure one another. So the wrapper only takes the width it is given.
const islandWrap: CSSProperties = {
  position: "relative",
  width: "100%",
  pointerEvents: "none",
};

const islandCard: CSSProperties = {
  background: "var(--composer-glass)",
  border: "1px solid var(--composer-border)",
  borderRadius: 15,
  backdropFilter: "var(--composer-blur)",
  WebkitBackdropFilter: "var(--composer-blur)",
};

const dockWrap: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  justifyContent: "center",
  pointerEvents: "none",
  zIndex: 6,
};

export function TodoStrip({
  workspaceRoot,
  conversationId,
  goal: goalProp,
  running = true,
  variant = "dock",
  onDockHeightChange,
  onPresenceChange,
  folded = false,
  onUnfold,
}: {
  workspaceRoot: string | null;
  conversationId: string;
  goal?: string;
  variant?: TodoStripVariant;
  /** Whether a Harness Run is alive on this conversation. The plan on disk
   *  outlives the run — closing the app ends the run, not the file — so with
   *  no run the first open step is just the next step: no arc, no count. */
  running?: boolean;
  onDockHeightChange?: (height: number) => void;
  /** What the strip occupies in the column, which is not the same question as
   *  whether it is on screen: a dismissed plan still leaves its reopen mark
   *  there. Focus makes room for a card, a sliver of room for a mark, and none
   *  for nothing — and its own close control only appears when there is a card
   *  to close. */
  onPresenceChange?: (slot: TodoStripSlot) => void;
  /** The column around it is closed: the plan shows as its mark and nothing
   *  else, so the corner in the main view is icons rather than windows.
   *  Clicking the mark reopens the column (`onUnfold`), which is a different
   *  act from un-hiding a plan the reader dismissed on its own. */
  folded?: boolean;
  onUnfold?: () => void;
}) {
  // The island opens on its steps: the column exists to be watched, and a
  // header alone says less than the plan it stands for. The dock still starts
  // closed — it sits over the conversation.
  const [open, setOpen] = useState(variant === "island");
  const [dismissed, setDismissed] = useState(false);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [events, setEvents] = useState<TodoEvent[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const listInnerRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  // One drawer at a time: the strip sits over the conversation, and two open
  // histories would push the answer further out of view than they are worth.
  const [openRow, setOpenRow] = useState<string | null>(null);
  // The island swells for a beat when a step is ticked — the Git island's
  // gesture when the branch pings it. Held exactly as long as the CSS takes to
  // reach full size, then released so the same curve carries it back.
  const [ping, setPing] = useState(false);
  // The island and its folded mark trade places with a handoff, not a swap:
  // whichever is on screen fades toward the corner first, then the other
  // grows out of it. `leaving` names the one on its way out while its exit
  // plays; the state that decides which is mounted flips when it has gone.
  const [leaving, setLeaving] = useState<"card" | "mark" | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);
  function afterExit(fn: () => void, ms: number) {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      fn();
    }, reduced ? 0 : ms);
  }

  useEffect(() => {
    // Drop the previous conversation's list right away so it never flashes
    // under a freshly-started one before the new file loads.
    setItems([]);
    setEvents([]);
    if (!workspaceRoot) return;

    const todoPath = `.agents/todos/${safeScope(conversationId)}.json`;
    async function load() {
      try {
        const raw = await invoke<string>("read_text_file", {
          workspaceRoot,
          path: `${workspaceRoot}/${todoPath}`,
        });
        const store: TodoStore = JSON.parse(raw);
        setItems(store.todos ?? []);
        setEvents(store.events ?? []);
      } catch {
        setItems([]);
        setEvents([]);
      }
    }

    load();
    intervalRef.current = setInterval(load, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [workspaceRoot, conversationId]);

  useEffect(() => {
    setOpen(true);
    setDismissed(false);
    setOpenRow(null);
  }, [conversationId]);

  const total = items.length;
  const done = items.filter((item) => item.done).length;
  const recentEvents = [...events].sort((a, b) => b.seq - a.seq).slice(0, 5);
  const visibleItems = items;
  const firstOpen = visibleItems.findIndex((candidate) => !candidate.done);
  const planStart = planStartedAt(items, events);
  // Each step's clock starts when the step before it closed, so the live count
  // and the spans measure the work on that step, not the age of the plan.
  const floors = workFloors(items, events);
  // Prefer the user's actual ask (the goal write-up) over the current step.
  const goal = goalProp?.replace(/\s+/g, " ").trim() || items[0]?.text || recentEvents[0]?.text || "Working through the plan";

  const allDone = total > 0 && done === total;
  const shownSignature = planSignature(items);

  // Hide is available at any point in a plan, not only once it finishes. The
  // signature is persisted so it survives a restart, and it keys on the plan's
  // shape — so ticking items off never resurrects a plan you dismissed, while
  // a genuinely new plan does come back.
  function hidePlan() {
    if (variant !== "island") {
      rememberPlanHidden(workspaceRoot, conversationId, shownSignature);
      setDismissed(true);
      return;
    }
    setLeaving("card");
    afterExit(() => {
      rememberPlanHidden(workspaceRoot, conversationId, shownSignature);
      setDismissed(true);
      setLeaving(null);
    }, CARD_EXIT_MS);
  }

  // The island's way back. Hiding the plan gives the canvas back to the
  // conversation, but the plan keeps moving, so a small mark stays in the
  // corner — the icon and the count — and brings the card back on click.
  function showPlan() {
    setLeaving("mark");
    afterExit(() => {
      forgetPlanHidden(workspaceRoot, conversationId);
      setDismissed(false);
      setOpen(true);
      setLeaving(null);
    }, MARK_EXIT_MS);
  }

  // A finished plan folds in the dock, where the card sits over the
  // conversation and a tall box would cover the answer. The island has a lane
  // of its own and covers nothing, so its steps stay readable — a header
  // saying "3/3" with the three steps hidden is the plan at its least useful.
  useEffect(() => {
    if (allDone && variant === "dock") setOpen(false);
    else if (!allDone) setDismissed(false);
  }, [allDone, variant]);

  const prevDoneRef = useRef(done);
  useEffect(() => {
    if (done === prevDoneRef.current) return;
    const ticked = done > prevDoneRef.current;
    prevDoneRef.current = done;
    if (!ticked || variant !== "island") return;
    setPing(true);
    const timer = setTimeout(() => setPing(false), 380);
    return () => clearTimeout(timer);
  }, [done, variant]);

  useEffect(() => {
    // Restore a prior hide — the signature comparison handles staleness
    // (a different plan → show again).
    if (planWasHidden(workspaceRoot, conversationId, shownSignature)) {
      setDismissed(true);
    }
  }, [workspaceRoot, conversationId, shownSignature]);

  // An empty list means there is nothing to show, even when the store still
  // holds the events that emptied it — otherwise clearing the plan leaves a
  // ghost card with a goal header and no rows, holding the composer up.
  const visible = !dismissed && total > 0;
  // The mark stands in for the plan in two cases: the reader dismissed it, or
  // the column around it is folded. Either way it takes room in the corner
  // without being a window, which is exactly the distinction the column needs.
  const slot: TodoStripSlot = variant !== "island" ? (visible ? "card" : "none")
    : folded && total > 0 && !dismissed ? "mark"
      : visible ? "card"
        : dismissed && total > 0 ? "mark"
          : "none";
  // Sequenced both ways. Opening: the column slides over first and the card
  // rises into the space (its entrance waits ISLAND_ENTER_DELAY_MS). Closing:
  // the card leaves first, and only then — when `dismissed` flips — does the
  // column slide back while the mark takes the corner.
  useEffect(() => {
    onPresenceChange?.(slot);
  }, [slot, onPresenceChange]);

  // Measured before paint, so the list opens at its true height and only
  // *changes* to it animate — adding or clearing a task glides. Then watched:
  // a drawer grows over 260ms after the click, and a height read once at the
  // click would clip its last lines under the list's edge.
  useLayoutEffect(() => {
    const el = listInnerRef.current;
    if (!el) return;
    setContentHeight(el.scrollHeight);
    const observer = new ResizeObserver(() => setContentHeight(el.scrollHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [items, open, openRow]);
  const listHeight = Math.min(contentHeight, openRow ? MAX_LIST_HEIGHT_OPEN[variant] : MAX_LIST_HEIGHT[variant]);
  const iconColumn = ICON_COLUMN[variant];
  const island = variant === "island";

  // The card sizes to its rows now, so the composer offset has to be measured
  // rather than assumed from a fixed height.
  useEffect(() => {
    if (!visible || variant === "island") {
      onDockHeightChange?.(0);
      return;
    }
    const el = dockRef.current;
    if (!el) return;
    const report = () => onDockHeightChange?.(Math.round(el.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, open, total, onDockHeightChange, variant]);

  // A plan the reader dismissed stays dismissed: the column closing is not a
  // reason to bring it back as a mark.
  if (folded && island && total > 0 && !dismissed) {
    return (
      <div className="klide-todo-island-mark" style={{ ...islandWrap, width: "auto", alignSelf: "flex-end" }}>
        <button
          type="button"
          className="klide-todo-reopen"
          onClick={onUnfold}
          aria-label={`Open the side panel — plan, ${done} of ${total} steps done`}
          title="Open the side panel"
          style={{ ...islandCard, pointerEvents: "auto" }}
        >
          <PlanIcon size={15} />
          <CountLabel done={done} total={total} />
        </button>
      </div>
    );
  }

  if (!visible) {
    if (variant !== "island" || dismissed === false || total === 0) return null;
    return (
      <div className="klide-todo-island-mark" data-leaving={leaving === "mark" ? "true" : undefined} style={{ ...islandWrap, width: "auto", alignSelf: "flex-end" }}>
        <button
          type="button"
          className="klide-todo-reopen"
          onClick={showPlan}
          aria-label={`Show the plan, ${done} of ${total} steps done`}
          style={{ ...islandCard, pointerEvents: "auto" }}
        >
          <PlanIcon size={15} />
          <CountLabel done={done} total={total} />
        </button>
      </div>
    );
  }

  return (
    <div ref={dockRef} className={island ? "klide-todo-island" : undefined} data-ping={ping ? "true" : undefined} data-leaving={island && leaving === "card" ? "true" : undefined} style={island ? islandWrap : dockWrap}>
      <section
        className="klide-todo-strip"
        aria-label="Agent todo progress"
        style={{
          ...(island ? islandCard : glassCard),
          pointerEvents: "auto",
          position: "relative",
          width: island ? "100%" : "min(620px, calc(100% - 48px))",
          padding: island ? "12px 16px 0" : "10px 16px 0",
          display: "grid",
          gridTemplateRows: "auto auto minmax(0, 1fr)",
          overflow: "hidden",
          borderRadius: island ? 15 : "14px 14px 0 0",
          animation: island ? undefined : "klide-todo-open-in var(--motion-slow) var(--ease-soft)",
        }}
      >
        {/* header: GOAL · title · count · collapse · hide. Doubles as the
            expand target, so the whole strip is one click when collapsed. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-label={open ? "Collapse agent todo panel" : "Expand agent todo panel"}
          onClick={() => setOpen((was) => !was)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((was) => !was);
            }
          }}
          style={{
            display: "grid",
            gridTemplateColumns: `${MARK}px minmax(0, 1fr) auto ${iconColumn}px`,
            alignItems: "center",
            columnGap: RIGHT_GAP,
            paddingBottom: island ? 11 : 9,
            cursor: "pointer",
          }}
        >
          {/* The header wears the plan's state on the same mark the rows use:
              the step in hand with its arc while the run works, the next step's
              number when no run is alive, and the check — popping in, with
              "Completed" beside the count — once every step has closed. So the
              collapsed card still says where things stand. */}
          <StepMark
            key={allDone ? "done" : "live"}
            index={allDone ? total - 1 : Math.max(firstOpen, 0)}
            state={allDone ? "done" : running ? "active" : "todo"}
          />
          {island ? (
            // The conversation is right there, so the goal would say it twice;
            // the island names itself the way the Git island does.
            <span style={{ color: "var(--fg-subtle)", fontSize: 13, minHeight: 18, display: "flex", alignItems: "center" }}>Plan</span>
          ) : (
            <GoalLine goal={goal} size={12.5} />
          )}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {allDone && (
              <span className="klide-todo-completed" aria-label="Plan completed">
                Completed
              </span>
            )}
            <CountLabel done={done} total={total} />
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {!island && (
              <span style={{ width: ICON, height: ICON, display: "grid", placeItems: "center", color: "var(--fg-dim)" }}>
                <ChevronIcon open={open} />
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); hidePlan(); }}
              aria-label="Hide this plan"
              style={{
                width: ICON,
                height: ICON,
                display: "grid",
                placeItems: "center",
                border: "none",
                background: "transparent",
                color: "var(--fg-dim)",
                cursor: "pointer",
              }}
            >
              <CloseIcon />
            </button>
          </span>
        </div>

        <HeaderRule shown={open} inset={16} />

        {/* scrollable list: tasks threaded on one hairline, state carried by type */}
        <div
          className="klide-todo-list todo-scroll"
          aria-hidden={!open}
          style={{
            position: "relative",
            overflowY: "auto",
            marginLeft: -3,
            height: open ? listHeight : 0,
            opacity: open ? 1 : 0,
          }}
        >
          {/* 3px of ring room on the left is paid for by the scroller's margin, so
              the marks still start where the header text does */}
          <div ref={listInnerRef} style={{ padding: island ? "10px 0 12px 3px" : "8px 0 10px 3px" }}>
            {visibleItems.map((item, idx) => (
              <TodoRow
                key={item.id}
                item={item}
                index={idx}
                active={running && !item.done && idx === firstOpen}
                isLast={idx === visibleItems.length - 1}
                threadInFilled={idx > 0 && visibleItems[idx - 1].done}
                open={openRow === item.id}
                onToggle={() => setOpenRow((was) => (was === item.id ? null : item.id))}
                events={events}
                planStart={planStart}
                startedAfter={floors[idx] ?? 0}
                iconColumn={iconColumn}
                roomy={island}
                enterDelay={island ? ISLAND_ENTER_DELAY_MS + 60 : 0}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
