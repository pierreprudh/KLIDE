// Keyboard-shortcut registry — the single source of truth for what each
// binding is *called* and which keycaps it displays. Display-only for now:
// the handlers stay where they live (App.tsx's global keydown, per-component
// onKeyDown), but every surface that *shows* a chord — the ⌘/ cheatsheet,
// tooltips, empty-state launchers — reads from here. Rebinding a shortcut is
// then a one-line change here plus its handler, instead of a hunt across
// hardcoded strings in half a dozen components.
//
// AZERTY note (Pierre's layout): handlers must match digits/symbols by
// `e.code`, but the *display* strings below are layout-independent — they are
// what the user reads on the physical keycap.

export type ShortcutId =
  | "region-next"
  | "region-prev"
  | "go-to-file"
  | "command-palette"
  | "find-in-files"
  | "git-review"
  | "back-to-editor"
  | "next-tab"
  | "prev-tab"
  | "save-file"
  | "open-folder"
  | "close-tab"
  | "find-in-file"
  | "toggle-terminal"
  | "settings"
  | "profile"
  | "cheatsheet"
  | "ai-send"
  | "ai-newline"
  | "ai-toggle-mode"
  | "ai-stop";

export type Shortcut = { keys: string[]; label: string };

export const SHORTCUTS: Record<ShortcutId, Shortcut> = {
  "region-next": { keys: ["⌃", "Tab"], label: "Focus next region (Explorer → Editor → Terminal → AI) · or F6" },
  "region-prev": { keys: ["⌃", "⇧", "Tab"], label: "Focus previous region · or ⇧F6" },
  "go-to-file": { keys: ["⌘", "P"], label: "Go to file" },
  "command-palette": { keys: ["⌘", "⇧", "P"], label: "Command palette" },
  "find-in-files": { keys: ["⌘", "⇧", "F"], label: "Find in files" },
  "git-review": { keys: ["⌘", "⇧", "G"], label: "Git review" },
  "back-to-editor": { keys: ["⌘", "N"], label: "Back to the editor" },
  "next-tab": { keys: ["⌘", "Tab"], label: "Next tab" },
  "prev-tab": { keys: ["⌘", "⇧", "Tab"], label: "Previous tab" },
  "save-file": { keys: ["⌘", "S"], label: "Save file" },
  "open-folder": { keys: ["⌘", "O"], label: "Open folder" },
  "close-tab": { keys: ["⌘", "W"], label: "Close tab" },
  "find-in-file": { keys: ["⌘", "F"], label: "Find in file (editor)" },
  "toggle-terminal": { keys: ["⌘", "`"], label: "Toggle terminal" },
  settings: { keys: ["⌘", ","], label: "Settings" },
  profile: { keys: ["⌘", "."], label: "Profile" },
  cheatsheet: { keys: ["⌘", "/"], label: "Keyboard shortcuts" },
  "ai-send": { keys: ["↵"], label: "Send message" },
  "ai-newline": { keys: ["⇧", "↵"], label: "New line" },
  "ai-toggle-mode": { keys: ["Tab"], label: "Toggle mode (Chat / Plan / Goal)" },
  "ai-stop": { keys: ["Esc"], label: "Stop a running turn" },
};

export function keysFor(id: ShortcutId): string[] {
  return SHORTCUTS[id].keys;
}

/** Cheatsheet layout — which shortcuts appear under which heading. */
export const SHORTCUT_GROUPS: { title: string; ids: ShortcutId[] }[] = [
  {
    title: "Move around",
    ids: [
      "region-next",
      "region-prev",
      "go-to-file",
      "command-palette",
      "find-in-files",
      "git-review",
      "back-to-editor",
      "next-tab",
      "prev-tab",
    ],
  },
  {
    title: "Files & editing",
    ids: ["save-file", "open-folder", "close-tab", "find-in-file"],
  },
  {
    title: "Panels & views",
    ids: ["toggle-terminal", "settings", "profile", "cheatsheet"],
  },
  {
    title: "AI panel",
    ids: ["ai-send", "ai-newline", "ai-toggle-mode", "ai-stop"],
  },
];
