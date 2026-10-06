// Agent context files (CLAUDE.md / AGENTS.md / KIT.md — the files that steer
// the agents) are the one file kind that earns a mark: a single filled
// four-point star carrying the accent. Filled, not stroked — a thin stroke
// rendered at 12px lands between pixels and reads as noise; a solid shape
// stays crisp at any size. Markdown deliberately gets no mark: half a repo
// is .md, so it never earned one.

import { isImagePath } from "../workspaceFs";

/** The Python mark — python.org's two snakes, path for path, in flat brand
 *  colours (Design.md: no gradients). Stands where `$` would on the approval
 *  card for a command that is really a Python script. */
export function PythonMark({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0.21 -0.077 110 110" aria-hidden="true">
      <path fill="#3776AB" d="M55.023-0.077c-25.971,0-26.25,10.081-26.25,12.156c0,3.148,0,12.594,0,12.594h26.75v3.781c0,0-27.852,0-37.375,0c-7.949,0-17.938,4.833-17.938,26.25c0,19.673,7.792,27.281,15.656,27.281c2.335,0,9.344,0,9.344,0s0-9.765,0-13.125c0-5.491,2.721-15.656,15.406-15.656c15.91,0,19.971,0,26.531,0c3.902,0,14.906-1.696,14.906-14.406c0-13.452,0-17.89,0-24.219C82.054,11.426,81.515-0.077,55.023-0.077z M40.273,8.392c2.662,0,4.813,2.15,4.813,4.813c0,2.661-2.151,4.813-4.813,4.813s-4.813-2.151-4.813-4.813C35.46,10.542,37.611,8.392,40.273,8.392z" />
      <path fill="#FFD43B" d="M55.397,109.923c25.959,0,26.282-10.271,26.282-12.156c0-3.148,0-12.594,0-12.594H54.897v-3.781c0,0,28.032,0,37.375,0c8.009,0,17.938-4.954,17.938-26.25c0-23.322-10.538-27.281-15.656-27.281c-2.336,0-9.344,0-9.344,0s0,10.216,0,13.125c0,5.491-2.631,15.656-15.406,15.656c-15.91,0-19.476,0-26.532,0c-3.892,0-14.906,1.896-14.906,14.406c0,14.475,0,18.265,0,24.219C28.366,100.497,31.562,109.923,55.397,109.923z M70.148,101.454c-2.662,0-4.813-2.151-4.813-4.813s2.15-4.813,4.813-4.813c2.661,0,4.813,2.151,4.813,4.813S72.809,101.454,70.148,101.454z" />
    </svg>
  );
}

export function isAgentFile(path: string): boolean {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  return /^(claude|claude\.local|agents?|kit)\.md$/.test(name);
}

export function AgentMark({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0.8 9.8 6.2 15.2 8 9.8 9.8 8 15.2 6.2 9.8 0.8 8 6.2 6.2Z" />
    </svg>
  );
}

// The real file-type icons — the same set the Explorer tree draws (brand
// colors are hardcoded by design; file-type icons are exempt from the token
// rule). Extracted from Sidebar's FileRow so tabs and the explorer stay one
// icon language.
export function FileTypeIcon({ name, size = 17 }: { name: string; size?: number }) {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";

  // Images (png/jpg/svg/…) get the universal picture glyph — a framed photo
  // with a sun + mountains — so they read as pictures in the tree, not text.
  if (isImagePath(lower)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="3.5" fill="#8B7CE8" />
        <circle cx="8.5" cy="9" r="1.7" fill="#fff" />
        <path d="M4.5 19 9 13l3 3 3.5-4.5L19.5 19Z" fill="#fff" />
      </svg>
    );
  }

  const kind =
    lower === "package.json"
      ? "npm"
      : lower.startsWith(".git")
      ? "git"
      : lower === "cargo.toml" || lower === "cargo.lock"
      ? "rust"
      : ext;

  if (kind === "py") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#3776AB" d="M12.1 2.5c-3.9 0-4.7 1.7-4.7 3.8v2.1h4.8v.8H5.6c-2.1 0-3.9 1.2-4.5 3.6-.7 2.8-.7 4.5 0 7.3.5 2.1 1.8 3.6 3.9 3.6h1.8v-2.5c0-2.4 2.1-4.5 4.5-4.5h4.7c2 0 3.6-1.6 3.6-3.6V6.3c0-2-1.7-3.5-3.6-3.8-1.2-.2-2.6-.3-3.9 0z" transform="scale(.82) translate(1.8 1.4)" />
        <path fill="#FFD43B" d="M12 21.5c3.9 0 4.7-1.7 4.7-3.8v-2.1h-4.8v-.8h6.6c2.1 0 3.9-1.2 4.5-3.6.7-2.8.7-4.5 0-7.3-.5-2.1-1.8-3.6-3.9-3.6h-1.8v2.5c0 2.4-2.1 4.5-4.5 4.5H8.1c-2 0-3.6 1.6-3.6 3.6v6.8c0 2 1.7 3.5 3.6 3.8 1.2.2 2.6.3 3.9 0z" transform="scale(.82) translate(1.8 1.4)" />
      </svg>
    );
  }

  if (kind === "tsx" || kind === "jsx") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#61DAFB" strokeWidth="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="1.9" fill="#61DAFB" stroke="none" />
        <ellipse cx="12" cy="12" rx="9" ry="3.8" />
        <ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(120 12 12)" />
      </svg>
    );
  }

  if (kind === "html" || kind === "css") {
    const color = kind === "html" ? "#E34F26" : "#1572B6";
    const text = kind === "html" ? "5" : "3";
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path fill={color} d="M4 2h16l-1.4 17.1L12 22l-6.6-2.9L4 2z" />
        <text x="12" y="15.5" textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff">{text}</text>
      </svg>
    );
  }

  if (kind === "git") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#F05032" d="M10.8 2.8a1.7 1.7 0 0 1 2.4 0l8 8a1.7 1.7 0 0 1 0 2.4l-8 8a1.7 1.7 0 0 1-2.4 0l-8-8a1.7 1.7 0 0 1 0-2.4l8-8z" />
        <path stroke="#fff" strokeWidth="1.4" strokeLinecap="round" fill="none" d="M8 8.2l4 4m0 0v4.3m0-4.3h4" />
        <circle cx="8" cy="8.2" r="1.35" fill="#fff" />
        <circle cx="12" cy="12.2" r="1.35" fill="#fff" />
        <circle cx="16" cy="12.2" r="1.35" fill="#fff" />
      </svg>
    );
  }

  const logo: Record<string, { bg: string; fg: string; text: string }> = {
    ts: { bg: "#3178C6", fg: "#FFFFFF", text: "TS" },
    js: { bg: "#F7DF1E", fg: "#252525", text: "JS" },
    json: { bg: "#F0B429", fg: "#FFFFFF", text: "{}" },
    rust: { bg: "#DEA584", fg: "#2B1A12", text: "Rs" },
    rs: { bg: "#DEA584", fg: "#2B1A12", text: "Rs" },
    md: { bg: "#7C8A99", fg: "#FFFFFF", text: "M↓" },
    toml: { bg: "#9C6ADE", fg: "#FFFFFF", text: "T" },
    yml: { bg: "#CB4B16", fg: "#FFFFFF", text: "Y" },
    yaml: { bg: "#CB4B16", fg: "#FFFFFF", text: "Y" },
    lock: { bg: "#9AA0A6", fg: "#FFFFFF", text: "L" },
    npm: { bg: "#CB3837", fg: "#FFFFFF", text: "npm" },
  };
  const meta = logo[kind] ?? { bg: "transparent", fg: "var(--fg-dim)", text: "◇" };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4.5" fill={meta.bg} stroke={meta.bg === "transparent" ? "var(--border-strong)" : "none"} />
      <text x="12" y="15.2" textAnchor="middle" fontSize={meta.text.length > 2 ? "6.2" : "8"} fontWeight="800" fill={meta.fg}>{meta.text}</text>
    </svg>
  );
}
