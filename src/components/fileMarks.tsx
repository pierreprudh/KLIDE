// Special file marks. Most files stay typographic (extension monograms in
// the dock spine, plain names in tabs), but two kinds earn a drawn glyph:
//
//  - markdown — the reading/writing surface, marked with the classic M↓
//  - agent context files (CLAUDE.md / AGENTS.md / agent.md) — the files that
//    steer the agents, marked with the same four-point sparkle Klide uses
//    for skills. Hosts tint this one with the accent: it's the one file
//    type worth spotting instantly.
//
// Stroke-drawn, currentColor, no fills — same icon language as the rest of
// the chrome.

export type FileMarkKind = "agent" | "markdown";

export function fileMarkKind(path: string): FileMarkKind | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (/^(claude|claude\.local|agents?|kit)\.md$/.test(name)) return "agent";
  if (name.endsWith(".md") || name.endsWith(".mdx")) return "markdown";
  return null;
}

export function AgentMark({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5l1.7 4.8L17.5 11.5l-4.8 1.7L11 18l-1.7-4.8L4.5 11.5l4.8-1.7z" />
      <path d="M18.5 4v3M17 5.5h3" />
    </svg>
  );
}

export function MarkdownMark({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 17V7l4.5 5L13 7v10" />
      <path d="M18.5 8v8m0 0l-2.6-2.6M18.5 16l2.6-2.6" />
    </svg>
  );
}

export function FileMark({ kind, size = 13 }: { kind: FileMarkKind; size?: number }) {
  return kind === "agent" ? <AgentMark size={size} /> : <MarkdownMark size={size} />;
}
