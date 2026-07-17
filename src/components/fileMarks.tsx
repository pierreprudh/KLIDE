// Agent context files (CLAUDE.md / AGENTS.md / KIT.md — the files that steer
// the agents) are the one file kind that earns a mark: a single filled
// four-point star carrying the accent. Filled, not stroked — a thin stroke
// rendered at 12px lands between pixels and reads as noise; a solid shape
// stays crisp at any size. Markdown deliberately gets no mark: half a repo
// is .md, so it never earned one.

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
