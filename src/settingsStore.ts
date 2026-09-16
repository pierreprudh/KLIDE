// The persistent settings store — one home for every durable preference.
//
// Each setting is declared ONCE in the SETTINGS catalog below (storage key,
// default, optional normalize), and any component reads/writes it through
// `useSetting(SETTINGS.x)`. Subscribers on the same setting stay in sync
// across components without prop threading — App.tsx no longer brokers a
// value/onChange pair per setting down to the Settings panel.
//
// Storage formats match what App.tsx historically wrote, so existing
// localStorage values keep working: strings raw ("delay", theme ids, model
// ids), booleans as "true"/"false", numbers as their decimal string, and
// objects/arrays as JSON.

import { useCallback, useSyncExternalStore } from "react";
import { normalizeThemeId, type ThemeId } from "./theme";

export type HarnessSettings = {
  chatPrompt?: string;
  planPrompt?: string;
  goalPrompt?: string;
  toolOverrides?: Record<string, boolean>;
  /** Per-model context window (num_ctx) override for local models. Absent →
   *  use the model's detected trained window. Keyed by model id. */
  contextWindows?: Record<string, number>;
  /** Per-model reply budget (num_predict) for local models. Absent → provider default. */
  effortBudgets?: Record<string, number>;
  /** Per-model thinking/reflection level for models that advertise thinking. */
  reflectionLevels?: Record<string, string>;
  /** Max read-only tool calls to run concurrently within a turn (1 = off). */
  maxParallelTools?: number;
  /** Advisor strategy: which provider/model answers a `consult_advisor` call.
   *  The executor (the run's own model, typically small/local) escalates a hard
   *  decision to this stronger model. Absent → the default advisor (Anthropic
   *  Opus). See src/agent/advisor.ts. */
  advisorProvider?: string;
  advisorModel?: string;
  /** Max tool turns per run before handing back to the user. Absent → harness
   *  default (50). A runaway-loop guard; raise it for big multi-file / multi-
   *  agent tasks. The conversation can always be continued past the cap. */
  maxTurns?: number;
  /** Seconds a run_command may run before it's killed. Absent → 180. Raise it
   *  for slow builds; a hang guard, not a task limit. */
  commandTimeoutSecs?: number;
  /** Optional command to run after accepted edits/creates. Empty/absent means off. */
  testAfterEditCommand?: string;
  /** OLLAMA_NUM_PARALLEL for Klide-launched Ollama servers (concurrent
   *  request slots). Absent → Ollama's own default. */
  serverConcurrency?: number;
  /** When a Klide agent run settles with status "done", automatically write
   *  a project-memory note from the conversation. Default ON (undefined /
   *  missing field is treated as true). Off silences the auto-save — the
   *  manual Summarize header action still works. */
  autoMemoryOnRunDone?: boolean;
};

/** Settings-panel section ids. Declared here (not in the component) so each
 *  SettingDef can name where it lives without the store importing UI code;
 *  the panel's own SectionId aliases this type. */
export type SettingsSectionId =
  | "general"
  | "appearance"
  | "layout"
  | "ai"
  | "local-ai"
  | "api"
  | "connectors"
  | "subscription"
  | "editor"
  | "terminal"
  | "stats"
  | "storage";

/** One row in the Settings "Look for a setting" search index: the visible
 *  label, the section the row jumps to, and the words a user is likely to
 *  type (synonyms included) rather than the exact label. */
export type SettingSearchEntry = {
  label: string;
  section: SettingsSectionId;
  keywords: string;
};

export type SettingDef<T> = {
  key: string;
  fallback: () => T;
  /** Applied on every read — clamps/validates whatever storage held. */
  normalize?: (value: T) => T;
  /** How this setting surfaces in the Settings search box. One setting can
   *  surface several rows (harnessSettings bundles many knobs), and several
   *  settings can share one row (the derived index dedupes by label+section).
   *  Settings without `search` are reachable only by browsing sections. */
  search?: SettingSearchEntry | SettingSearchEntry[];
};

// localStorage is absent under vitest's node environment; fall back to a
// process-lifetime map so the pure layer stays testable.
const memoryStore = new Map<string, string>();

function readRaw(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem(key);
  } catch {
    // fall through to the memory store
  }
  return memoryStore.get(key) ?? null;
}

function writeRaw(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    // fall through to the memory store
  }
  memoryStore.set(key, value);
}

/** Raw string → typed value, driven by the fallback's type. Booleans accept
 *  only "true"/"false" (anything else → fallback), numbers reject NaN, and
 *  object-shaped settings JSON-parse with the fallback as the safety net. */
export function decodeSetting<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  switch (typeof fallback) {
    case "string":
      return raw as unknown as T;
    case "boolean":
      return (raw === "true" ? true : raw === "false" ? false : fallback) as T;
    case "number": {
      const n = Number(raw);
      return (Number.isFinite(n) ? n : fallback) as T;
    }
    default:
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
  }
}

export function encodeSetting(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
    case "number":
      return String(value);
    default:
      return JSON.stringify(value);
  }
}

const cache = new Map<string, unknown>();
const subscribers = new Map<string, Set<() => void>>();

export function getSetting<T>(def: SettingDef<T>): T {
  if (cache.has(def.key)) return cache.get(def.key) as T;
  let value = decodeSetting(readRaw(def.key), def.fallback());
  if (def.normalize) value = def.normalize(value);
  cache.set(def.key, value);
  return value;
}

export function setSetting<T>(def: SettingDef<T>, value: T): void {
  const next = def.normalize ? def.normalize(value) : value;
  cache.set(def.key, next);
  writeRaw(def.key, encodeSetting(next));
  subscribers.get(def.key)?.forEach((cb) => cb());
}

export function subscribeSetting(key: string, cb: () => void): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

/** React binding: `const [value, setValue] = useSetting(SETTINGS.theme)`.
 *  Every component on the same setting re-renders when any of them writes. */
export function useSetting<T>(
  def: SettingDef<T>
): [T, (next: T | ((prev: T) => T)) => void] {
  const value = useSyncExternalStore(
    useCallback((cb) => subscribeSetting(def.key, cb), [def.key]),
    () => getSetting(def)
  );
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(getSetting(def)) : next;
      setSetting(def, resolved);
    },
    // A def is a module-level constant; keying on it keeps the linter honest.
    [def]
  );
  return [value, set];
}

/** Test hook: drop cached values so a fresh read hits storage again. */
export function resetSettingsCacheForTests(): void {
  cache.clear();
  memoryStore.clear();
}

const clamp = (min: number, max: number) => (n: number) => Math.min(max, Math.max(min, n));

// ── The catalog ──────────────────────────────────────────────────────────
// Keys are the historical localStorage names — do not rename without a
// migration. Defaults + validation live here and nowhere else.

// Two settings share the "Files & tabs" row; the auto-theme trio shares the
// "Automatic light/dark theme" row. Shared rows are declared once so the
// dedupe in settingsSearchIndex sees identical entries.
const FILES_AND_TABS_SEARCH: SettingSearchEntry = {
  label: "Files & tabs",
  section: "general",
  keywords: "hidden files dotfiles confirm close unsaved tabs",
};
const AUTO_THEME_SEARCH: SettingSearchEntry = {
  label: "Automatic light/dark theme",
  section: "appearance",
  keywords: "auto theme system light dark switch",
};

export const SETTINGS = {
  theme: {
    key: "klide-theme",
    fallback: () => normalizeThemeId(null),
    normalize: (v: ThemeId) => normalizeThemeId(v),
    search: {
      label: "Theme",
      section: "appearance",
      keywords: "theme dark light color colour palette appearance",
    },
  } as SettingDef<ThemeId>,
  /** Default ON for first-run users so Klide matches their OS theme out of
   *  the box. Users can disable the toggle in Settings → Appearance. */
  autoTheme: {
    key: "klide-auto-theme",
    fallback: () => true,
    search: AUTO_THEME_SEARCH,
  } as SettingDef<boolean>,
  lightTheme: {
    key: "klide-light-theme",
    fallback: () => "klide-light" as ThemeId,
    normalize: (v: ThemeId) => normalizeThemeId(v),
    search: AUTO_THEME_SEARCH,
  } as SettingDef<ThemeId>,
  darkTheme: {
    key: "klide-dark-theme",
    fallback: () => "cursor-dark" as ThemeId,
    normalize: (v: ThemeId) => normalizeThemeId(v),
    search: AUTO_THEME_SEARCH,
  } as SettingDef<ThemeId>,
  /** Your profile picture beside your own turns in a conversation. On by
   *  default: a thread reads as two participants talking. Off drops the mark
   *  and its gutter, and the bubbles keep the right edge to themselves. */
  showAskerAvatar: {
    key: "klide-conversation-avatar",
    fallback: () => true,
    search: {
      label: "Profile picture in conversations",
      section: "appearance",
      keywords: "avatar profile picture photo conversation message mark chat me",
    },
  } as SettingDef<boolean>,
  restoreLastProject: {
    key: "klide-restore-project",
    fallback: () => false,
    search: {
      label: "Startup",
      section: "general",
      keywords: "startup launch reopen restore last project welcome",
    },
  } as SettingDef<boolean>,
  autoSaveMode: {
    key: "klide-autosave",
    fallback: () => "off" as "off" | "delay" | "blur",
    normalize: (v) => (v === "delay" || v === "blur" ? v : "off"),
    search: {
      label: "Auto-save",
      section: "general",
      keywords: "autosave auto save delay focus blur dirty unsaved",
    },
  } as SettingDef<"off" | "delay" | "blur">,
  showHiddenFiles: {
    key: "klide-show-hidden",
    fallback: () => true,
    search: FILES_AND_TABS_SEARCH,
  } as SettingDef<boolean>,
  confirmCloseDirty: {
    key: "klide-confirm-close",
    fallback: () => true,
    search: FILES_AND_TABS_SEARCH,
  } as SettingDef<boolean>,
  editorFontSize: {
    key: "klide-editor-font-size",
    fallback: () => 13,
    normalize: clamp(11, 20),
    search: {
      label: "Editor font size",
      section: "editor",
      keywords: "editor font size text monaco",
    },
  } as SettingDef<number>,
  editorLineNumbers: {
    key: "klide-editor-line-numbers",
    fallback: () => true,
    search: {
      label: "Line numbers",
      section: "editor",
      keywords: "editor line numbers gutter",
    },
  } as SettingDef<boolean>,
  editorWordWrap: {
    key: "klide-editor-word-wrap",
    fallback: () => false,
    search: {
      label: "Word wrap",
      section: "editor",
      keywords: "editor word wrap soft",
    },
  } as SettingDef<boolean>,
  editorMinimap: {
    key: "klide-editor-minimap",
    fallback: () => true,
    search: {
      label: "Minimap",
      section: "editor",
      keywords: "editor minimap overview",
    },
  } as SettingDef<boolean>,
  /** The sidebar's width, in px. Direct manipulation only — you set it by
   *  dragging the rail's inner edge, so it carries no Settings row and no
   *  search entry. The bounds are the same ones the drag clamps to. */
  railWidth: {
    key: "klide-rail-width",
    fallback: () => 252,
    normalize: clamp(200, 460),
  } as SettingDef<number>,
  /** Whether the sidebar is folded away. Written by the same drag (past the
   *  fold threshold) and by ⌘B; persisted so the shell reopens the way you
   *  left it. */
  railCollapsed: {
    key: "klide-rail-collapsed",
    fallback: () => false,
  } as SettingDef<boolean>,
  aiModel: {
    key: "klide-ai-model",
    // Legacy fallback chain: the pre-rename Ollama-only key, then the stock default.
    fallback: () => readRaw("klide-ollama-model") || "llama3.1:8b",
    search: {
      label: "AI model",
      section: "ai",
      keywords: "ai model assistant provider default",
    },
  } as SettingDef<string>,
  /** Global default for "require diff review" (auto-accept off). Each AI
   *  panel keeps its own in-memory override on top of this. */
  requireDiffReview: {
    key: "klide-confirm-agent-edits",
    fallback: () => true,
    search: {
      label: "Diff review before edits",
      section: "ai",
      keywords: "diff review approve confirm edits write apply",
    },
  } as SettingDef<boolean>,
  stopAfterRejection: {
    key: "klide.stopAfterRejection",
    fallback: () => false,
    search: {
      label: "Stop after rejection",
      section: "ai",
      keywords: "stop reject rejection halt edits",
    },
  } as SettingDef<boolean>,
  harnessSettings: {
    key: "klide.harnessSettings",
    fallback: () => ({}) as HarnessSettings,
    // One stored object, many knobs — each surfaces as its own search row.
    search: [
      { label: "System prompts", section: "ai", keywords: "prompt system chat plan goal instructions" },
      { label: "Tool overrides", section: "ai", keywords: "tools tool enable disable allow override" },
      { label: "Context window", section: "ai", keywords: "context window tokens length size" },
      { label: "Effort & reflection", section: "ai", keywords: "effort budget reflection thinking reasoning" },
      { label: "Max parallel tools", section: "ai", keywords: "parallel tools concurrency simultaneous" },
      { label: "Max turns", section: "ai", keywords: "max turns loop limit iterations" },
      { label: "Command timeout", section: "ai", keywords: "command timeout shell run seconds" },
      { label: "Test after edit", section: "ai", keywords: "test verify after edit syntax check command" },
      { label: "Auto-draft memory on run done", section: "ai", keywords: "memory draft auto note handoff summarize pending review" },
    ],
  } as SettingDef<HarnessSettings>,
} as const;

/** The store-backed slice of the Settings search index, derived from the
 *  catalog so it cannot drift from what actually exists. Rows shared by
 *  several settings are deduped by label+section; the panel appends its own
 *  hand list for things that are not persisted settings (panel toggles,
 *  whole panes) and owns ordering. */
export function settingsSearchIndex(): SettingSearchEntry[] {
  const rows: SettingSearchEntry[] = [];
  const seen = new Set<string>();
  for (const def of Object.values(SETTINGS) as SettingDef<unknown>[]) {
    if (!def.search) continue;
    for (const entry of Array.isArray(def.search) ? def.search : [def.search]) {
      const id = `${entry.section}::${entry.label}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(entry);
    }
  }
  return rows;
}
