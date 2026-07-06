// Commit history graph for Git Review — a SourceTree-style lane graph
// rendered in Klide's language: hairline rows, muted multi-hue lane tokens
// (--lane-1..8 — the one sanctioned use of hue variety, because 1.5px lines
// must be tellable apart), refs as quiet typography (no pills). Lives in the
// center pane whenever no file diff is open; the commit detail pane it feeds
// is owned by GitReview so it can span the full window width.
//
// Perf notes: the list is ~300 rows of SVG, so every layer is memoized —
// the component ignores parent re-renders (commit-box keystrokes), rows
// only re-render when their own selection flips, and dates go through ONE
// cached Intl formatter (per-call toLocaleDateString is ~0.3ms — 300 of
// those froze the pane). Do NOT add content-visibility here: WKWebView's
// compositor is fragile (see the backdrop-filter and zIndex incidents).

import { Component, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { layoutGraph, splitRefs, type GraphCommit, type GraphRow } from "../gitGraph";
import { renderMarkdown } from "./markdown";
import { ProviderLogo } from "./ai/icons";
import type { ProviderId } from "../agent/types";

const GRAPH_PAD = 8;
const MAX_GRAPH_LANES = 10;
const LANE_COLORS = 8; // --lane-1 … --lane-8 (muted multi-hue, graph-only)

/** Row density: "roomy" is the default — big rows, few of them, and the
 *  least information (no hash column, avatar instead of author name; the
 *  rest lives in the hover tooltip and the detail pane). Each zoom-out
 *  step fits more rows AND reveals more columns. All geometry and column
 *  visibility derive from this one object. */
export type GraphDensity = "roomy" | "cozy" | "compact" | "dense";
const DENSITY_ORDER: GraphDensity[] = ["roomy", "cozy", "compact", "dense"];
// v2: key bumped when "roomy" became the default, so it actually shows.
const DENSITY_KEY = "klide.gitgraph.density.v2";
const DIMS: Record<
  GraphDensity,
  { rowH: number; laneW: number; node: number; font: number; monoFont: number; avatar: number; hash: boolean; author: "avatar" | "name" | "none" }
> = {
  roomy: { rowH: 34, laneW: 14, node: 3.5, font: 13.5, monoFont: 11.5, avatar: 20, hash: true, author: "avatar" },
  cozy: { rowH: 26, laneW: 12, node: 3, font: 12, monoFont: 11, avatar: 16, hash: true, author: "name" },
  compact: { rowH: 19, laneW: 9, node: 2.5, font: 11, monoFont: 10, avatar: 13, hash: true, author: "name" },
  dense: { rowH: 14, laneW: 7, node: 2, font: 10.5, monoFont: 9.5, avatar: 0, hash: true, author: "name" },
};
type Dims = (typeof DIMS)[GraphDensity];

// ---- Author avatars -------------------------------------------------------
//
// No API calls, no auth: GitHub noreply emails encode the username, so those
// resolve straight to github.com/<user>.png; everything else tries Gravatar
// (SHA-256, d=404) and falls back to an initial disc when the image 404s.
// Resolution is async (crypto.subtle) and cached per email for the session.

const avatarUrlCache = new Map<string, Promise<string | null>>();

/** Real GitHub account pictures, resolved in batch through `gh api` (the
 *  commit endpoint maps author → account even for private emails). Filled
 *  by the graph after commits load; avatars subscribe and re-resolve. */
const githubAvatarByEmail = new Map<string, string>();
const avatarListeners = new Set<() => void>();

export async function resolveGithubAvatars(workspaceRoot: string, commits: GraphCommit[]): Promise<void> {
  const queries: { hash: string; email: string }[] = [];
  const seen = new Set<string>();
  for (const c of commits) {
    const email = c.authorEmail.trim().toLowerCase();
    if (!email || seen.has(email) || githubAvatarByEmail.has(email)) continue;
    seen.add(email);
    queries.push({ hash: c.hash, email });
  }
  if (queries.length === 0) return;
  try {
    const found = await invoke<Record<string, string>>("github_commit_avatars", { workspaceRoot, queries });
    let changed = false;
    for (const [email, url] of Object.entries(found)) {
      if (!githubAvatarByEmail.has(email)) {
        githubAvatarByEmail.set(email, url);
        avatarUrlCache.delete(email); // re-resolve with the account picture
        changed = true;
      }
    }
    if (changed) avatarListeners.forEach((l) => l());
  } catch {
    // gh missing / offline / not a GitHub repo — fallbacks still apply.
  }
}

function resolveAvatarUrl(email: string): Promise<string | null> {
  const key = email.trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  const github = githubAvatarByEmail.get(key);
  if (github) return Promise.resolve(github);
  let pending = avatarUrlCache.get(key);
  if (!pending) {
    const noreply = key.match(/^(?:\d+\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/);
    if (noreply) {
      pending = Promise.resolve(`https://github.com/${noreply[1]}.png?size=64`);
    } else {
      pending = crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(key))
        .then((buf) =>
          Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("")
        )
        .then((hash) => `https://gravatar.com/avatar/${hash}?d=404&s=64`)
        .catch(() => null);
    }
    avatarUrlCache.set(key, pending);
  }
  return pending;
}

/** Emails whose avatar image 404'd — skip the <img> entirely next time. */
const avatarFailed = new Set<string>();

const AuthorAvatar = memo(function AuthorAvatar({ name, email, size }: { name: string; email: string; size: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(() => avatarFailed.has(email.trim().toLowerCase()));
  useEffect(() => {
    let cancelled = false;
    const resolve = () => {
      void resolveAvatarUrl(email).then((u) => {
        if (cancelled) return;
        setUrl(u);
        // A late-arriving GitHub account picture overrides an earlier miss.
        if (u && githubAvatarByEmail.get(email.trim().toLowerCase()) === u) setFailed(false);
      });
    };
    resolve();
    avatarListeners.add(resolve);
    return () => { cancelled = true; avatarListeners.delete(resolve); };
  }, [email]);

  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => { avatarFailed.add(email.trim().toLowerCase()); setFailed(true); }}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  // Fallback: quiet initial disc (monochrome — avatars are the images here).
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
        color: "var(--fg-subtle)",
        fontSize: Math.max(7, size * 0.52),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
});

function laneColor(index: number): string {
  return `var(--lane-${(index % LANE_COLORS) + 1})`;
}

function laneX(lane: number, d: Dims): number {
  return GRAPH_PAD + lane * d.laneW;
}

/** Top-half curve: row top at `from` down into the node at `to`. */
function topPath(from: number, to: number, d: Dims): string {
  const x1 = laneX(from, d);
  const x2 = laneX(to, d);
  const mid = d.rowH / 2;
  if (x1 === x2) return `M ${x1} 0 L ${x2} ${mid}`;
  return `M ${x1} 0 C ${x1} ${mid * 0.8}, ${x2} ${mid * 0.2}, ${x2} ${mid}`;
}

/** Bottom-half curve: node at `from` out to row bottom at `to`. */
function bottomPath(from: number, to: number, d: Dims): string {
  const x1 = laneX(from, d);
  const x2 = laneX(to, d);
  const mid = d.rowH / 2;
  if (x1 === x2) return `M ${x1} ${mid} L ${x2} ${d.rowH}`;
  return `M ${x1} ${mid} C ${x1} ${mid + mid * 0.8}, ${x2} ${mid + mid * 0.2}, ${x2} ${d.rowH}`;
}

const GraphCell = memo(function GraphCell({ row, width, isHead, dims }: { row: GraphRow; width: number; isHead: boolean; dims: Dims }) {
  const nodeX = laneX(row.lane, dims);
  return (
    <svg width={width} height={dims.rowH} style={{ display: "block", flexShrink: 0 }} aria-hidden>
      {row.passThrough.map((l) => (
        <line key={`p${l.lane}`} x1={laneX(l.lane, dims)} y1={0} x2={laneX(l.lane, dims)} y2={dims.rowH} stroke={laneColor(l.color)} strokeWidth={1.5} />
      ))}
      {row.intoNode.map((l) => (
        <path key={`i${l.lane}`} d={topPath(l.lane, row.lane, dims)} stroke={laneColor(l.color)} strokeWidth={1.5} fill="none" />
      ))}
      {row.outOfNode.map((l, i) => (
        <path key={`o${i}-${l.lane}`} d={bottomPath(row.lane, l.lane, dims)} stroke={laneColor(l.color)} strokeWidth={1.5} fill="none" />
      ))}
      {isHead ? (
        <circle cx={nodeX} cy={dims.rowH / 2} r={dims.node + 0.5} fill="var(--bg)" stroke={laneColor(row.color)} strokeWidth={2} />
      ) : (
        <circle cx={nodeX} cy={dims.rowH / 2} r={dims.node} fill={laneColor(row.color)} />
      )}
    </svg>
  );
});

const RefLabels = memo(function RefLabels({ refs }: { refs: string[] }) {
  const parts = splitRefs(refs);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part) => (
        <span
          key={`${part.kind}:${part.name}`}
          title={part.kind === "tag" ? `tag ${part.name}` : part.name}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            flexShrink: 0,
            fontWeight: part.kind === "head" ? 700 : 600,
            fontStyle: part.kind === "tag" ? "italic" : undefined,
            color:
              part.kind === "head" ? "var(--accent)"
              : part.kind === "local" ? "var(--fg-strong)"
              : "var(--fg-subtle)",
          }}
        >
          {part.name}
        </span>
      ))}
    </>
  );
});

// One shared formatter — constructing Intl.DateTimeFormat per call is the
// single most expensive thing this component can do.
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

const selectedBg = "color-mix(in srgb, var(--accent-soft) 70%, transparent)";

const HistoryRow = memo(function HistoryRow({
  row,
  graphW,
  isHead,
  isSelected,
  dims,
  onSelect,
}: {
  row: GraphRow;
  graphW: number;
  isHead: boolean;
  isSelected: boolean;
  dims: Dims;
  onSelect: (hash: string) => void;
}) {
  const c = row.commit;
  return (
    <div
      onClick={() => onSelect(c.hash)}
      title={`${c.shortHash} · ${c.author}\n${c.subject}`}
      style={{
        height: dims.rowH,
        display: "flex",
        alignItems: "center",
        padding: "0 14px 0 0",
        cursor: "default",
        background: isSelected ? selectedBg : undefined,
      }}
      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? selectedBg : ""; }}
    >
      <GraphCell row={row} width={graphW} isHead={isHead} dims={dims} />
      {dims.author === "avatar" && (
        <span style={{ width: dims.avatar + 14, flexShrink: 0, display: "flex", justifyContent: "center" }} title={c.author}>
          <AuthorAvatar name={c.author} email={c.authorEmail} size={dims.avatar} />
        </span>
      )}
      {dims.hash && (
        <span style={{ width: 72, flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: dims.monoFont, color: isHead ? "var(--fg-strong)" : "var(--fg-subtle)", fontWeight: isHead ? 600 : 400 }}>
          {c.shortHash}
        </span>
      )}
      <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
        <RefLabels refs={c.refs} />
        <span style={{ fontSize: dims.font, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.subject}
        </span>
      </span>
      {dims.author === "name" && (
        <span style={{ width: 118, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, paddingRight: 8, overflow: "hidden" }}>
          {dims.avatar > 0 && <AuthorAvatar name={c.author} email={c.authorEmail} size={dims.avatar} />}
          <span style={{ fontSize: dims.font - 0.5, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.author}
          </span>
        </span>
      )}
      <span style={{ width: 92, flexShrink: 0, fontSize: dims.monoFont, color: "var(--fg-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums", paddingRight: 0 }}>
        {dateFmt.format(c.timestamp * 1000)}
      </span>
    </div>
  );
});

const headerCellStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
};

type CommitFile = { path: string; status: string; additions: number; deletions: number };

export type CommitDetails = {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  refs: string[];
  files: CommitFile[];
  diff: string;
  additions: number;
  deletions: number;
};

const DETAIL_DIFF_LIMIT = 1200;

/** File change status as a small stroke icon (Pierre: no bare letters) —
 *  pencil/plus/minus/arrow, colored like GitReview's status letters. */
function FileStatusIcon({ status }: { status: string }) {
  const s = status[0] ?? "M";
  const color =
    s === "A" ? "var(--success)"
    : s === "D" ? "var(--danger)"
    : s === "R" || s === "C" ? "var(--fg-subtle)"
    : "var(--warning)";
  const title =
    s === "A" ? "Added" : s === "D" ? "Deleted" : s === "R" ? "Renamed" : s === "C" ? "Copied" : "Modified";
  return (
    <span title={title} style={{ display: "inline-flex", width: 14, flexShrink: 0, color, justifyContent: "center" }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {s === "A" ? (
          <><path d="M12 5v14" /><path d="M5 12h14" /></>
        ) : s === "D" ? (
          <path d="M5 12h14" />
        ) : s === "R" || s === "C" ? (
          <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>
        ) : (
          // Modified: filled dot — VS Code's convention, quieter than a pencil.
          <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
        )}
      </svg>
    </span>
  );
}

// ---- Structured diff rendering --------------------------------------------
//
// Modeled on what makes GitHub / Tower / Fork diffs digestible: dual
// line-number gutters, a separated sign column so code indentation aligns,
// word-level highlighting inside changed line pairs, collapsible per-file
// sections, and hunk gaps as quiet "···" bands instead of raw @@ noise.
// Row tinting keeps GitReview's 12% success/danger vocabulary.

type DiffBlock =
  | { kind: "file"; path: string }
  | { kind: "hunk"; text: string }
  | {
      kind: "line";
      /** Code without the leading +/-/space sign. */
      code: string;
      tone: "add" | "del" | "ctx";
      oldNo: number | null;
      newNo: number | null;
      /** Word-level changed span [start, end) within `code`. */
      hi?: [number, number];
    };

type DiffCodeBlock = Extract<DiffBlock, { kind: "line" }>;

const DIFF_META_RE =
  /^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files)/;

export function parseDiffBlocks(lines: string[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(.+)$/);
      blocks.push({ kind: "file", path: m ? m[1] : line.slice("diff --git ".length) });
      continue;
    }
    if (DIFF_META_RE.test(line)) continue;
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      blocks.push({ kind: "hunk", text: line.replace(/^@@ .*? @@ ?/, "") });
      continue;
    }
    const tone = line.startsWith("+") ? "add" as const : line.startsWith("-") ? "del" as const : "ctx" as const;
    blocks.push({
      kind: "line",
      code: line.slice(1),
      tone,
      oldNo: tone === "add" ? null : oldNo++,
      newNo: tone === "del" ? null : newNo++,
    });
  }
  markInlineChanges(blocks);
  return blocks;
}

/** Tower-style word-level highlighting: when a run of removed lines is
 *  followed by an equally long run of added lines, each pair almost always
 *  differs in one span — mark it via common prefix/suffix so the eye lands
 *  on what actually changed. */
function markInlineChanges(blocks: DiffBlock[]): void {
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.kind !== "line" || b.tone !== "del") {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < blocks.length) {
      const d = blocks[delEnd];
      if (d.kind === "line" && d.tone === "del") delEnd++;
      else break;
    }
    let addEnd = delEnd;
    while (addEnd < blocks.length) {
      const a = blocks[addEnd];
      if (a.kind === "line" && a.tone === "add") addEnd++;
      else break;
    }
    if (delEnd - i === addEnd - delEnd) {
      for (let k = 0; k < delEnd - i; k++) {
        const del = blocks[i + k] as DiffCodeBlock;
        const add = blocks[delEnd + k] as DiffCodeBlock;
        const spans = changedSpan(del.code, add.code);
        if (spans) {
          del.hi = spans[0];
          add.hi = spans[1];
        }
      }
    }
    i = addEnd > i ? addEnd : i + 1;
  }
}

/** Common prefix/suffix trim: the changed middle of each side, or null when
 *  the lines are identical or share no shell at all (highlighting everything
 *  is the same as highlighting nothing). */
function changedSpan(a: string, b: string): [[number, number], [number, number]] | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p === 0 && s === 0) return null;
  return [
    [p, a.length - s],
    [p, b.length - s],
  ];
}

/** One diff code row: [old№ | new№ | sign | code], tinted by tone, with
 *  the word-level changed span on a stronger tint. */
const DiffCodeRow = memo(function DiffCodeRow({ block }: { block: DiffCodeBlock }) {
  const bg =
    block.tone === "add" ? "color-mix(in srgb, var(--success) 12%, transparent)"
    : block.tone === "del" ? "color-mix(in srgb, var(--danger) 12%, transparent)"
    : "transparent";
  const fg =
    block.tone === "add" ? "var(--success)"
    : block.tone === "del" ? "var(--danger)"
    : "var(--fg-subtle)";
  const hiBg =
    block.tone === "add" ? "color-mix(in srgb, var(--success) 30%, transparent)"
    : "color-mix(in srgb, var(--danger) 30%, transparent)";
  const code = block.code || " ";
  const hi = block.hi;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "36px 36px 18px 1fr", minHeight: 18, background: bg, color: fg }}>
      <span style={{ textAlign: "right", paddingRight: 8, userSelect: "none", fontSize: 10, color: "var(--fg-dim)", lineHeight: "18px" }}>
        {block.oldNo ?? ""}
      </span>
      <span style={{ textAlign: "right", paddingRight: 8, userSelect: "none", fontSize: 10, color: "var(--fg-dim)", lineHeight: "18px" }}>
        {block.newNo ?? ""}
      </span>
      <span style={{ userSelect: "none", textAlign: "center" }}>
        {block.tone === "add" ? "+" : block.tone === "del" ? "−" : ""}
      </span>
      <span style={{ whiteSpace: "pre", paddingRight: 16 }}>
        {hi && hi[0] < hi[1] ? (
          <>
            {code.slice(0, hi[0])}
            <span style={{ background: hiBg, borderRadius: 2 }}>{code.slice(hi[0], hi[1])}</span>
            {code.slice(hi[1])}
          </>
        ) : (
          code
        )}
      </span>
    </div>
  );
});

const fullDateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });


// ---- Commit message rendering -------------------------------------------
//
// Commit bodies aren't chat text: git convention hard-wraps them at 72
// columns and stacks trailers (Co-Authored-By:, Fixes:, …) at the end.
// Rendering them verbatim keeps the ragged 72-col breaks and reads the
// trailers as prose. So: split the trailers off into a quiet meta block,
// unwrap the hard-wrapped lines back into real paragraphs, and hand the
// result to the shared markdown renderer (same one the chat uses) so
// bullet lists and `inline code` come through.

const TRAILER_RE = /^[A-Za-z][A-Za-z0-9-]*:\s\S.*$/;

function splitTrailers(body: string): { text: string; trailers: string[] } {
  const lines = body.trimEnd().split("\n");
  let start = lines.length;
  while (start > 0 && TRAILER_RE.test(lines[start - 1].trim())) start--;
  // Only a FINAL block counts (whole body, or preceded by a blank line) —
  // otherwise a paragraph ending in "Note: something" would lose its tail.
  const isFinalBlock = start === 0 || lines[start - 1].trim() === "";
  if (start === lines.length || !isFinalBlock) return { text: body, trailers: [] };
  return {
    text: lines.slice(0, start).join("\n").trimEnd(),
    trailers: lines.slice(start).map((l) => l.trim()),
  };
}

/** True for lines that start a markdown block and must keep their newline. */
function startsBlock(trimmed: string): boolean {
  return trimmed === "" || /^([-*+]\s|\d+[.)]\s|#{1,6}\s|>)/.test(trimmed);
}

/** Undo git's 72-column hard wrapping: a plain prose line joins the line
 *  above it unless either side is a block boundary (blank line, list item
 *  start, heading, quote, fence, or indented code). Wrapped list-item
 *  continuations fold into their bullet. */
function reflowCommitBody(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const isIndentedCode = /^(\s{4,}|\t)/.test(line);
    if (inFence || isIndentedCode || startsBlock(trimmed)) {
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const prevTrimmed = prev?.trim() ?? "";
    const prevAbsorbs =
      prev !== undefined &&
      prevTrimmed !== "" &&
      !prevTrimmed.startsWith("```") &&
      !/^#{1,6}\s/.test(prevTrimmed) &&
      !/^(\s{4,}|\t)/.test(prev);
    if (prevAbsorbs) out[out.length - 1] = `${prev} ${trimmed}`;
    else out.push(line);
  }
  return out.join("\n");
}

/** Recognize AI co-author trailers so they get their provider's mark —
 *  "Co-Authored-By: Claude Fable 5 <…>" reads as an Anthropic credit line. */
function trailerProvider(trailer: string): ProviderId | null {
  if (!/^co-authored-by:/i.test(trailer)) return null;
  const v = trailer.toLowerCase();
  if (/(claude|anthropic|fable|mythos|opus|sonnet|haiku)/.test(v)) return "anthropic";
  if (/(codex|openai|chatgpt|gpt-)/.test(v)) return "openai";
  if (/gemini/.test(v)) return "gemini";
  if (/mistral/.test(v)) return "mistral";
  if (/(grok|xai)/.test(v)) return "xai";
  return null;
}

const CommitMessage = memo(function CommitMessage({ body }: { body: string }) {
  const { text, trailers } = useMemo(() => splitTrailers(body), [body]);
  const rendered = useMemo(() => (text ? renderMarkdown(reflowCommitBody(text)) : null), [text]);
  return (
    <div style={{ padding: "4px 16px 10px", fontSize: 13, lineHeight: 1.55 }}>
      {rendered}
      {trailers.length > 0 && (
        <div style={{ marginTop: text ? 8 : 0, paddingTop: text ? 6 : 0, borderTop: text ? "1px solid var(--border)" : "none" }}>
          {trailers.map((t) => {
            const provider = trailerProvider(t);
            return (
              <div key={t} style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 20, overflow: "hidden" }}>
                {provider && (
                  <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--fg-subtle)" }} title={provider}>
                    <ProviderLogo id={provider} size={12} />
                  </span>
                )}
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: provider ? "var(--fg-subtle)" : "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export const DETAIL_PCT_KEY = "klide.gitgraph.detailPct";
export const DETAIL_PCT_DEFAULT = 55;
const DETAIL_PCT_MIN = 25;
const DETAIL_PCT_MAX = 85;

/** Uppercase hairline section header inside the detail pane — same voice as
 *  GitReview's Staged/Changes headers (Design.md: labels are fs-xs, fg-dim,
 *  tracked; icons only where they aid scanning). */
function DetailSection({ icon, label, meta }: { icon: ReactNode; label: string; meta?: ReactNode }) {
  return (
    <div style={{ height: 28, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderTop: "1px solid var(--border)", background: "color-mix(in srgb, var(--bg-hover) 45%, transparent)" }}>
      <span style={{ display: "inline-flex", color: "var(--fg-dim)", flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-dim)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {meta}
    </div>
  );
}

const sectionIcon = {
  files: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
    </svg>
  ),
  diff: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M12 4v7" /><path d="M8.5 7.5h7" /><path d="M8.5 16.5h7" />
    </svg>
  ),
};
/** Collapsed = header strip only: enough to know what's selected while the
 *  graph gets the room back. */
const DETAIL_COLLAPSED_H = 37;

export function clampDetailPct(pct: number): number {
  return Math.min(DETAIL_PCT_MAX, Math.max(DETAIL_PCT_MIN, pct));
}

/** Bottom detail pane for the selected commit: metadata, changed files with
 *  counts, and the (render-capped) patch. Readable-first: tall by default,
 *  resizable by dragging its top edge (double-click resets), and
 *  collapsible to a header strip to give the graph back. */
export function CommitDetailPane({
  detail,
  heightPct,
  collapsed,
  containerRef,
  onResize,
  onToggleCollapsed,
  onClose,
}: {
  detail: CommitDetails;
  heightPct: number;
  collapsed: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onResize: (pct: number) => void;
  onToggleCollapsed: () => void;
  onClose: () => void;
}) {
  const [showFullDiff, setShowFullDiff] = useState(false);
  const [hashCopied, setHashCopied] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  // Open animation: mount at height 0, then transition to the real height on
  // the next frame — the graph above shrinks in the same glide, so the pane
  // feels like it slides up out of the shelf. The transition also covers
  // collapse/expand; it turns OFF while dragging so resize tracks 1:1.
  const [entered, setEntered] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    setCollapsedFiles(new Set());
    setShowFullDiff(false);
  }, [detail.hash]);
  const toggleFileCollapsed = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const blocks = useMemo(
    () => (detail.diff.trim() ? parseDiffBlocks(detail.diff.replace(/\n$/, "").split("\n")) : []),
    [detail.diff]
  );
  const fileCounts = useMemo(() => new Map(detail.files.map((f) => [f.path, f])), [detail.files]);
  const visible = showFullDiff ? blocks : blocks.slice(0, DETAIL_DIFF_LIMIT);
  const hidden = blocks.length - visible.length;

  const copyHash = () => {
    void navigator.clipboard.writeText(detail.hash);
    setHashCopied(true);
    setTimeout(() => setHashCopied(false), 1200);
  };

  const startDrag = (e: React.PointerEvent) => {
    if (collapsed) return;
    e.preventDefault();
    const containerH = containerRef.current?.getBoundingClientRect().height ?? 0;
    if (containerH <= 0) return;
    const startY = e.clientY;
    const startPct = heightPct;
    setDragging(true);
    const move = (ev: PointerEvent) => onResize(startPct + ((startY - ev.clientY) / containerH) * 100);
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      style={{
        height: !entered ? 0 : collapsed ? DETAIL_COLLAPSED_H : `${heightPct}%`,
        opacity: entered ? 1 : 0,
        transition: dragging
          ? "none"
          : "height var(--motion-slow) var(--ease-soft), opacity var(--motion-med) var(--ease-out)",
        flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0,
        borderTop: "1px solid var(--border)", position: "relative", background: "var(--bg)", overflow: "hidden",
      }}
    >
      {!collapsed && (
        <div
          onPointerDown={startDrag}
          onDoubleClick={() => onResize(DETAIL_PCT_DEFAULT)}
          title="Drag to resize · double-click to reset"
          style={{ position: "absolute", top: -3, left: 0, right: 0, height: 7, cursor: "row-resize", zIndex: 1 }}
        />
      )}
      <div style={{ height: 36, flexShrink: 0, padding: "0 10px 0 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: collapsed ? "none" : "1px solid var(--border)", fontSize: 12 }}>
        <button
          onClick={copyHash}
          title={hashCopied ? "Copied!" : `Copy full hash\n${detail.hash}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, border: "none", background: "transparent", padding: "2px 4px", margin: "0 0 0 -4px", borderRadius: "var(--radius-xs)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: hashCopied ? "var(--accent)" : "var(--fg-subtle)" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          {detail.shortHash}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {hashCopied ? (
              <path d="M4 12l5 5L20 6" />
            ) : (
              <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>
            )}
          </svg>
        </button>
        <span style={{ color: "var(--fg-strong)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {detail.subject}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, flexShrink: 0 }}>
          <span style={{ color: "var(--diff-add)" }}>+{detail.additions}</span>{" "}
          <span style={{ color: "var(--diff-remove)" }}>−{detail.deletions}</span>
        </span>
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand commit details" : "Collapse to see the graph"}
          style={{ width: 24, height: 24, display: "grid", placeItems: "center", border: "none", background: "transparent", color: "var(--fg-subtle)", cursor: "pointer", borderRadius: "var(--radius-xs)", flexShrink: 0 }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            {collapsed ? <path d="M6 14l6-6 6 6" /> : <path d="M6 10l6 6 6-6" />}
          </svg>
        </button>
        <button
          onClick={onClose}
          title="Close commit details"
          style={{ width: 24, height: 24, display: "grid", placeItems: "center", border: "none", background: "transparent", color: "var(--fg-subtle)", cursor: "pointer", borderRadius: "var(--radius-xs)", flexShrink: 0 }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {!collapsed && (
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <div style={{ padding: "12px 16px 6px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--fg-subtle)" }}>
          <AuthorAvatar name={detail.author} email={detail.authorEmail} size={28} />
          <span title={detail.authorEmail} style={{ color: "var(--fg-strong)", fontWeight: 600, fontSize: 15 }}>{detail.author}</span>
          <span style={{ color: "var(--fg-dim)" }}>·</span>
          <span>{fullDateFmt.format(detail.timestamp * 1000)}</span>
          {detail.refs.length > 0 && <span style={{ color: "var(--fg-dim)" }}>·</span>}
          <RefLabels refs={detail.refs} />
        </div>
        {detail.body && <CommitMessage body={detail.body} />}
        <div style={{ height: detail.body ? 4 : 8 }} />
        <DetailSection
          icon={sectionIcon.files}
          label={`Files · ${detail.files.length}`}
        />
        <div style={{ padding: "6px 16px 10px" }}>
          {detail.files.map((f) => (
            <div key={f.path} style={{ height: 23, display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <FileStatusIcon status={f.status} />
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {f.path}
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, flexShrink: 0 }}>
                <span style={{ color: "var(--diff-add)" }}>+{f.additions}</span>{" "}
                <span style={{ color: "var(--diff-remove)" }}>−{f.deletions}</span>
              </span>
            </div>
          ))}
        </div>
        {visible.length > 0 && (
          <>
            <DetailSection
              icon={sectionIcon.diff}
              label="Diff"
              meta={
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
                  <span style={{ color: "var(--diff-add)" }}>+{detail.additions}</span>{" "}
                  <span style={{ color: "var(--diff-remove)" }}>−{detail.deletions}</span>
                </span>
              }
            />
            <div style={{ padding: "0 0 8px", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6 }}>
              {(() => {
                const out: ReactNode[] = [];
                let fileCollapsed = false;
                visible.forEach((block, i) => {
                  if (block.kind === "file") {
                    const counts = fileCounts.get(block.path);
                    const collapsed = collapsedFiles.has(block.path);
                    fileCollapsed = collapsed;
                    out.push(
                      <div
                        key={i}
                        onClick={() => toggleFileCollapsed(block.path)}
                        title={collapsed ? "Expand file" : "Collapse file"}
                        style={{ height: 26, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", marginTop: i > 0 ? 8 : 0, borderTop: i > 0 ? "1px solid var(--border)" : "none", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--bg-hover) 45%, transparent)", cursor: "pointer", userSelect: "none" }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: "var(--fg-dim)", flexShrink: 0, transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform var(--motion-fast) var(--ease-out)" }}>
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                        {counts && <FileStatusIcon status={counts.status} />}
                        <span style={{ color: "var(--fg-strong)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {block.path}
                        </span>
                        <span style={{ flex: 1 }} />
                        {counts && (
                          <span style={{ fontSize: 10.5, flexShrink: 0 }}>
                            <span style={{ color: "var(--diff-add)" }}>+{counts.additions}</span>{" "}
                            <span style={{ color: "var(--diff-remove)" }}>−{counts.deletions}</span>
                          </span>
                        )}
                      </div>
                    );
                    return;
                  }
                  if (fileCollapsed) return;
                  if (block.kind === "hunk") {
                    out.push(
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "72px 1fr", minHeight: 18, color: "var(--fg-dim)", background: "color-mix(in srgb, var(--bg-hover) 60%, transparent)", fontSize: 10.5 }}>
                        <span style={{ textAlign: "center", userSelect: "none", letterSpacing: "2px" }}>···</span>
                        <span style={{ paddingLeft: 18, whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", opacity: 0.8 }}>{block.text}</span>
                      </div>
                    );
                    return;
                  }
                  out.push(<DiffCodeRow key={i} block={block} />);
                });
                return out;
              })()}
              {hidden > 0 && (
                <div style={{ padding: "10px 16px 2px", color: "var(--fg-subtle)", fontFamily: "var(--font-ui)", fontSize: 12 }}>
                  {hidden} more lines hidden.{" "}
                  <button
                    type="button"
                    onClick={() => setShowFullDiff(true)}
                    style={{ border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", font: "inherit", padding: 0 }}
                  >
                    Show full diff
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}

type Props = {
  workspaceRoot: string | null;
  /** Any value that changes when history may have moved (commit, pull, …). */
  refreshToken?: unknown;
  /** Selection is owned by GitReview — it renders the full-width detail
   *  pane at the window bottom, outside this center-pane component. */
  selectedCommit: string | null;
  onSelectCommit: (hash: string | null) => void;
};

/** If anything in the graph throws at render time, fail to a quiet message
 *  instead of unmounting the whole app (there is no boundary above us). */
class GraphBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-subtle)", fontSize: 13, textAlign: "center", padding: 24 }}>
          <div>
            <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>History graph failed to render</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{this.state.error}</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const GitHistoryGraphInner = memo(function GitHistoryGraphInner({ workspaceRoot, refreshToken, selectedCommit, onSelectCommit }: Props) {
  const [commits, setCommits] = useState<GraphCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [density, setDensity] = useState<GraphDensity>(() => {
    const stored = localStorage.getItem(DENSITY_KEY);
    return DENSITY_ORDER.includes(stored as GraphDensity) ? (stored as GraphDensity) : "roomy";
  });
  const dims = DIMS[density];
  const toggleDensity = () => {
    const next = DENSITY_ORDER[(DENSITY_ORDER.indexOf(density) + 1) % DENSITY_ORDER.length];
    setDensity(next);
    localStorage.setItem(DENSITY_KEY, next);
  };

  useEffect(() => {
    if (!workspaceRoot) return;
    let cancelled = false;
    invoke<GraphCommit[]>("git_graph", { workspaceRoot, limit: 300 })
      .then((c) => {
        if (cancelled) return;
        setCommits(c);
        setError(null);
        // Fire-and-forget: real GitHub account pictures arrive when gh
        // answers; avatars re-resolve through the listener set.
        void resolveGithubAvatars(workspaceRoot, c);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [workspaceRoot, refreshToken]);

  const rows = useMemo(() => (commits ? layoutGraph(commits) : []), [commits]);
  const graphW = useMemo(() => {
    const lanes = Math.min(MAX_GRAPH_LANES, Math.max(1, ...rows.map((r) => r.width)));
    return GRAPH_PAD * 2 + (lanes - 1) * dims.laneW;
  }, [rows, dims.laneW]);
  const headHash = useMemo(
    () => commits?.find((c) => c.refs.some((r) => r.startsWith("HEAD -> ")))?.hash ?? null,
    [commits]
  );
  const onSelect = useCallback(
    (hash: string) => onSelectCommit(selectedCommit === hash ? null : hash),
    [onSelectCommit, selectedCommit]
  );

  if (error) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-subtle)", fontSize: 13, textAlign: "center", padding: 24 }}>
        <div>
          <div style={{ color: "var(--fg)", marginBottom: 4, fontWeight: 600 }}>No history yet</div>
          <div>{error}</div>
        </div>
      </div>
    );
  }
  if (!commits) {
    return <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--fg-dim)", fontSize: 12 }}>Loading history…</div>;
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Column headers */}
      <div
        className="pane-inset-top"
        style={{ height: 28, flexShrink: 0, display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", padding: "0 8px 0 0" }}
      >
        <span style={{ ...headerCellStyle, width: graphW, paddingLeft: GRAPH_PAD }}>Graph</span>
        {dims.author === "avatar" && <span style={{ width: dims.avatar + 14, flexShrink: 0 }} />}
        {dims.hash && <span style={{ ...headerCellStyle, width: 72 }}>Commit</span>}
        <span style={{ ...headerCellStyle, flex: 1 }}>Description</span>
        {dims.author === "name" && <span style={{ ...headerCellStyle, width: 118 }}>Author</span>}
        <span style={{ ...headerCellStyle, width: 92, textAlign: "right" }}>Date</span>
        <button
          onClick={toggleDensity}
          title={
            density === "roomy" ? "Zoom out — cozy rows with details"
            : density === "cozy" ? "Zoom out — compact rows"
            : density === "compact" ? "Zoom out more — dense rows"
            : "Zoom back in — roomy rows"
          }
          style={{ width: 22, height: 22, marginLeft: 8, display: "grid", placeItems: "center", border: "none", background: "transparent", color: "var(--fg-subtle)", cursor: "pointer", borderRadius: "var(--radius-xs)", flexShrink: 0 }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
            {density === "roomy" ? (
              <><path d="M4 8h16" /><path d="M4 17h16" /></>
            ) : density === "cozy" ? (
              <><path d="M4 7h16" /><path d="M4 14h16" /><path d="M4 21h16" /></>
            ) : density === "compact" ? (
              <><path d="M4 6h16" /><path d="M4 11h16" /><path d="M4 16h16" /><path d="M4 21h16" /></>
            ) : (
              <><path d="M4 5h16" /><path d="M4 9h16" /><path d="M4 13h16" /><path d="M4 17h16" /><path d="M4 21h16" /></>
            )}
          </svg>
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {rows.map((row) => (
          <HistoryRow
            key={row.commit.hash}
            row={row}
            graphW={graphW}
            isHead={row.commit.hash === headHash}
            isSelected={selectedCommit === row.commit.hash}
            dims={dims}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
});

export function GitHistoryGraph(props: Props) {
  return (
    <GraphBoundary>
      <GitHistoryGraphInner {...props} />
    </GraphBoundary>
  );
}
