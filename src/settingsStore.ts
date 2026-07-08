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

export type SettingDef<T> = {
  key: string;
  fallback: () => T;
  /** Applied on every read — clamps/validates whatever storage held. */
  normalize?: (value: T) => T;
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

export const SETTINGS = {
  theme: {
    key: "klide-theme",
    fallback: () => normalizeThemeId(null),
    normalize: (v: ThemeId) => normalizeThemeId(v),
  } as SettingDef<ThemeId>,
  /** Default ON for first-run users so Klide matches their OS theme out of
   *  the box. Users can disable the toggle in Settings → Appearance. */
  autoTheme: { key: "klide-auto-theme", fallback: () => true } as SettingDef<boolean>,
  lightTheme: {
    key: "klide-light-theme",
    fallback: () => "klide-light" as ThemeId,
    normalize: (v: ThemeId) => normalizeThemeId(v),
  } as SettingDef<ThemeId>,
  darkTheme: {
    key: "klide-dark-theme",
    fallback: () => "cursor-dark" as ThemeId,
    normalize: (v: ThemeId) => normalizeThemeId(v),
  } as SettingDef<ThemeId>,
  restoreLastProject: { key: "klide-restore-project", fallback: () => false } as SettingDef<boolean>,
  autoSaveMode: {
    key: "klide-autosave",
    fallback: () => "off" as "off" | "delay" | "blur",
    normalize: (v) => (v === "delay" || v === "blur" ? v : "off"),
  } as SettingDef<"off" | "delay" | "blur">,
  showHiddenFiles: { key: "klide-show-hidden", fallback: () => true } as SettingDef<boolean>,
  confirmCloseDirty: { key: "klide-confirm-close", fallback: () => true } as SettingDef<boolean>,
  editorFontSize: {
    key: "klide-editor-font-size",
    fallback: () => 13,
    normalize: clamp(11, 20),
  } as SettingDef<number>,
  editorLineNumbers: { key: "klide-editor-line-numbers", fallback: () => true } as SettingDef<boolean>,
  editorWordWrap: { key: "klide-editor-word-wrap", fallback: () => false } as SettingDef<boolean>,
  editorMinimap: { key: "klide-editor-minimap", fallback: () => true } as SettingDef<boolean>,
  aiModel: {
    key: "klide-ai-model",
    // Legacy fallback chain: the pre-rename Ollama-only key, then the stock default.
    fallback: () => readRaw("klide-ollama-model") || "llama3.1:8b",
  } as SettingDef<string>,
  /** Global default for "require diff review" (auto-accept off). Each AI
   *  panel keeps its own in-memory override on top of this. */
  requireDiffReview: { key: "klide-confirm-agent-edits", fallback: () => true } as SettingDef<boolean>,
  stopAfterRejection: { key: "klide.stopAfterRejection", fallback: () => false } as SettingDef<boolean>,
  harnessSettings: {
    key: "klide.harnessSettings",
    fallback: () => ({}) as HarnessSettings,
  } as SettingDef<HarnessSettings>,
} as const;
