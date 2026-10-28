import { RaceMark } from "./ai/icons";

// Mission Control's loading shape.
//
// Two waits sit between clicking the board and seeing it: the lazy chunk
// (MissionControl is a big module) and the run scan (session logs + Klide
// conversations). Both used to render nothing — a blank pane that reads as
// lag. This draws everything the board already knows how to draw without any
// data (title, filter row, both composers) and shimmers only where runs will
// land, so the view feels arrived rather than pending.
//
// Every measurement here is copied from the real board, not eyeballed: the
// 340px column, the `0 8px 10px` card margin, the 28px header controls, the
// `8px 10px` row padding, the 22px avatar. If MissionControl's geometry
// changes, change it here too — the whole point is that the swap causes no
// reflow.

// Both surfaces fade in after a short delay: a load that resolves quickly
// never flashes a skeleton at all.
const SKELETON_CSS = `
  @keyframes mc-skel-in { from { opacity: 0; } to { opacity: 1; } }
  .mc-skel { animation: mc-skel-in var(--motion-slow) var(--ease-out) 140ms both; }
  @media (prefers-reduced-motion: reduce) {
    .mc-skel { animation-delay: 0ms; animation-duration: 1ms; }
  }
`;

function Bar({
  width,
  height,
  delay = 0,
  radius = 4,
  grow,
}: {
  width?: number | string;
  height: number;
  /** Staggers the shimmer sweep so the column reads as one wave. */
  delay?: number;
  radius?: number;
  grow?: boolean;
}) {
  return (
    <div
      className="klide-skeleton"
      style={
        {
          width,
          height,
          borderRadius: radius,
          flex: grow ? "1 1 auto" : undefined,
          flexShrink: grow ? undefined : 0,
          minWidth: grow ? 0 : undefined,
          "--shimmer-delay": `${delay}ms`,
        } as React.CSSProperties
      }
    />
  );
}

// Deterministic title/subtitle widths — a natural-looking list without any
// randomness that would reshuffle between renders.
const ROW_WIDTHS: Array<[string, string]> = [
  ["72%", "44%"],
  ["54%", "36%"],
  ["81%", "50%"],
  ["63%", "31%"],
  ["76%", "41%"],
  ["48%", "38%"],
];

/**
 * One board row. Mirrors `.mc-row` → `.mc-card` → `RunRow`: the card owns the
 * hairline and elevated fill, the row inside owns `8px 10px` padding, a 22px
 * avatar, and a two-line column (title 13px / meta 11px, gap 3) — so a real
 * row drops in at the same height.
 */
function RowCard({ index }: { index: number }) {
  const [title, subtitle] = ROW_WIDTHS[index % ROW_WIDTHS.length];
  const delay = Math.min(index, 6) * 70;
  return (
    <div style={{ margin: "0 8px 10px" }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          background: "var(--bg-elevated)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
          }}
        >
          <Bar width={22} height={22} radius={999} delay={delay} />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 3,
              flex: 1,
              minWidth: 0,
            }}
          >
            {/* 13px title line and 11px mono meta line, boxed to the line
                heights RunRow actually renders (1.3). */}
            <div style={{ height: 17, display: "flex", alignItems: "center" }}>
              <Bar width={title} height={9} delay={delay} />
            </div>
            <div style={{ height: 14, display: "flex", alignItems: "center" }}>
              <Bar width={subtitle} height={8} delay={delay + 40} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Section caption — same `4px 10px` box and 10px cap-height as the real one. */
function SectionHead({ width, delay }: { width: number; delay: number }) {
  return (
    <div style={{ padding: "4px 10px", height: 22, display: "flex", alignItems: "center" }}>
      <Bar width={width} height={7} delay={delay} />
    </div>
  );
}

/**
 * The resting shape of both composers ("Add a task", "Race two agents on one
 * task"). These need no data, so the real component paints them the instant
 * it mounts — the skeleton draws the identical dashed button, with the label
 * as a bar, to hold the ~90px of vertical space the rows sit below.
 */
function ComposerPlaceholder({
  labelWidth,
  icon,
  delay,
}: {
  labelWidth: number;
  icon: "plus" | "race";
  delay: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "calc(100% - 16px)",
        margin: "0 8px 10px",
        padding: "8px 9px",
        fontSize: 12.5,
        // The real button is sized by its 12.5px label's line box (buttons
        // reset line-height to `normal` via `font: inherit`, ≈1.29 for
        // Atkinson → ~16px) plus 8px padding and a 1px border, border-box.
        // Pin that total so a bar-shaped label doesn't make the placeholder
        // shorter than the button it stands in for.
        minHeight: 34,
        color: "var(--fg-subtle)",
        border: "1px dashed var(--border)",
        borderRadius: "var(--radius-md)",
        boxSizing: "border-box",
      }}
    >
      {/* The affordance's icon is static too — draw it for real, so only the
          label text arrives later. */}
      {icon === "plus" ? (
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1, marginTop: -1 }}>
          +
        </span>
      ) : (
        <RaceMark size={12} />
      )}
      <Bar width={labelWidth} height={9} delay={delay} />
    </div>
  );
}

// A plausible transcript shape: the user opens, the agent answers at length,
// a short follow-up, a longer reply. Each entry is the bar widths (as % of the
// bubble) of that turn's text lines, so the stack reads like a conversation
// instead of a barcode.
const TURNS: Array<{ user: boolean; lines: string[] }> = [
  { user: true, lines: ["88%", "54%"] },
  { user: false, lines: ["96%", "91%", "72%"] },
  { user: true, lines: ["61%"] },
  { user: false, lines: ["93%", "97%", "84%", "46%"] },
];

/**
 * One transcript turn. Mirrors ConversationView's grid exactly: a 42px avatar
 * gutter on the speaker's side, the bubble in a `minmax(280px, 660px)` (agent)
 * or `minmax(260px, 620px)` (user) middle column, and the tail radius + fill
 * that tells the two roles apart.
 */
function TurnBubble({ user, lines, delay }: { user: boolean; lines: string[]; delay: number }) {
  const avatar = (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        justifySelf: user ? "start" : "end",
      }}
      className="klide-skeleton"
    />
  );
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: user
          ? "minmax(0, 1fr) minmax(260px, 620px) 42px"
          : "42px minmax(280px, 660px) minmax(0, 1fr)",
        columnGap: 12,
        alignItems: "end",
      }}
    >
      {!user && avatar}
      <div
        style={{
          gridColumn: "2",
          justifySelf: user ? "end" : "start",
          width: "100%",
        }}
      >
        <div
          style={{
            padding: user ? "10px 12px" : "12px 14px",
            borderRadius: user ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
            border: "1px solid var(--border)",
            background: user
              ? "color-mix(in srgb, var(--accent-soft) 55%, var(--bg-elevated))"
              : "color-mix(in srgb, var(--bg-elevated) 88%, var(--bg))",
          }}
        >
          {lines.map((w, i) => (
            // 13px body text at line-height 1.6 → a 21px line box per row.
            <div key={i} style={{ height: 21, display: "flex", alignItems: "center" }}>
              <Bar width={w} height={9} delay={delay + i * 50} />
            </div>
          ))}
        </div>
      </div>
      {user && avatar}
    </div>
  );
}

/**
 * The transcript stack. Used two ways: inside the whole-view fallback, and as
 * ConversationView's own loading state — reading a session log off disk is a
 * real wait, and it used to print a bare "Loading conversation…" line.
 */
export function TranscriptSkeleton() {
  return (
    <div className="mc-skel" aria-hidden style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <style>{SKELETON_CSS}</style>
      {/* Review bar · copy button — a 28px band, same as the real one. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, height: 28 }}>
        <Bar width={132} height={8} />
        <Bar width={28} height={28} radius={7} delay={80} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 1040 }}>
        {TURNS.map((t, i) => (
          <TurnBubble key={i} user={t.user} lines={t.lines} delay={i * 90} />
        ))}
      </div>
    </div>
  );
}

/**
 * The detail pane while nothing can be shown yet. The header block here is
 * decorative — which run gets selected isn't known during the chunk load — so
 * its job is only to stop the right two-thirds of the window reading as a
 * void while the board arrives.
 */
export function RunDetailSkeleton() {
  return (
    <div className="mc-skel" aria-hidden style={{ padding: "20px 24px", height: "100%", overflow: "hidden" }}>
      <style>{SKELETON_CSS}</style>
      {/* Agent mark · label · lifecycle — RunDetail's 30px avatar and its
          two mono lines (12px / 11px, gap 2). */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Bar width={30} height={30} radius={999} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ height: 16, display: "flex", alignItems: "center" }}>
            <Bar width={88} height={8} delay={40} />
          </div>
          <div style={{ height: 14, display: "flex", alignItems: "center" }}>
            <Bar width={62} height={7} delay={80} />
          </div>
        </div>
      </div>
      {/* The 18px run title. */}
      <div style={{ height: 23, display: "flex", alignItems: "center", margin: "0 0 14px" }}>
        <Bar width="min(46%, 320px)" height={12} delay={120} />
      </div>
      <TranscriptSkeleton />
    </div>
  );
}

/**
 * The board's row area while the run scan is in flight. Rendered inside the
 * real Mission Control below the live strip and both composers, so it draws
 * sections and cards only.
 */
export function BoardRowsSkeleton() {
  return (
    <div className="mc-skel" aria-hidden>
      <style>{SKELETON_CSS}</style>
      <SectionHead width={76} delay={0} />
      {[0, 1].map((i) => (
        <RowCard key={i} index={i} />
      ))}
      {/* Sections carry `marginBottom: 14` on the real board. */}
      <div style={{ height: 14 }} />
      <SectionHead width={54} delay={180} />
      {[2, 3, 4].map((i) => (
        <RowCard key={i} index={i} />
      ))}
    </div>
  );
}

/**
 * Whole-view placeholder used as the Suspense fallback while the Mission
 * Control chunk downloads and parses. Same shell classes as the real
 * workbench (`mission-control-workbench` / `-board` / `-detail`), so the
 * board keeps its tinted fill and hairline and the swap is a content
 * cross-fade, not a re-layout.
 */
export function MissionControlSkeleton() {
  return (
    <div
      className="mission-control-workbench"
      aria-busy="true"
      aria-label="Loading Mission Control"
      style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--bg)" }}
    >
      <style>{SKELETON_CSS}</style>
      {/* Header band — the title is real text, not a placeholder: it can be
          painted before anything is known, and seeing it lands the view. The
          search field fills the middle; archive + refresh sit right. */}
      <header style={{ minHeight: 56, padding: "0 20px", display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
        <h1 style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-strong)", margin: 0, flexShrink: 0 }}>
          Mission Control
        </h1>
        <div className="mc-skel" style={{ flex: 1, display: "flex", alignItems: "center", gap: 16, minWidth: 0 }}>
          <Bar grow height={32} radius={10} />
          <Bar width={60} height={28} radius={6} delay={60} />
        </div>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden", padding: "0 10px 10px" }}>
        <div
          className="mission-control-board"
          style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          {/* Source filter — before runs load there are no agent logos yet,
              so only the "All" toggle. No live-sessions strip: it renders
              nothing until a delegate PTY is found, and inventing one would
              collapse a moment later. */}
          <div className="mc-skel" style={{ padding: "10px 10px 4px" }}>
            <Bar width={34} height={28} radius={7} />
          </div>

          <div style={{ overflow: "hidden", padding: "8px 8px 16px", flex: 1, minHeight: 0 }}>
            <div className="mc-skel" aria-hidden>
              <ComposerPlaceholder icon="plus" labelWidth={64} delay={0} />
              <ComposerPlaceholder icon="race" labelWidth={148} delay={60} />
            </div>
            <BoardRowsSkeleton />
          </div>
        </div>

        <div className="mission-control-detail" style={{ flex: 1, minWidth: 0, marginLeft: 8 }}>
          <RunDetailSkeleton />
        </div>
      </div>
    </div>
  );
}
