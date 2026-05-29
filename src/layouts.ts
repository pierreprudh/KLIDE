// Layout presets — a saved arrangement of the workbench grid.
//
// Klide's frame is fixed (VS Code-style): Files + AI are vertical strips that
// always span full height (you choose their WIDTH); the Terminal is a
// horizontal strip that always spans full width (you choose its HEIGHT).
// A preset therefore stores, per region: on/off + a size.
//
// "Size" is a fraction of the relevant window axis (width for the side panels,
// height for the terminal). At apply-time we multiply by the live window size
// and clamp to each panel's safe min/max — so an "8th" never collapses a panel
// below the width it needs to be usable.

export type RegionSize = "eighth" | "quarter" | "third" | "half";

export const SIZE_OPTIONS: { id: RegionSize; label: string; fraction: number }[] = [
  { id: "eighth", label: "8th", fraction: 1 / 8 },
  { id: "quarter", label: "Quarter", fraction: 1 / 4 },
  { id: "third", label: "Third", fraction: 1 / 3 },
  { id: "half", label: "Half", fraction: 1 / 2 },
];

export type RegionConfig = { on: boolean; size: RegionSize };

export type LayoutPreset = {
  id: string;
  name: string;
  builtin?: boolean;
  files: RegionConfig; // width fraction
  ai: RegionConfig; // width fraction
  terminal: RegionConfig; // height fraction
};

export type ResolvedLayout = {
  explorer: boolean;
  ai: boolean;
  terminal: boolean;
  explorerWidth: number;
  aiWidth: number;
  terminalHeight: number;
};

// Mirror the resize constraints used in App.tsx so presets stay in-bounds.
const BOUNDS = {
  explorer: { min: 220, max: 520 },
  ai: { min: 300, max: 620 },
  terminal: { min: 140, max: 460 },
};

export function fractionForSize(size: RegionSize): number {
  return SIZE_OPTIONS.find((option) => option.id === size)?.fraction ?? 0.25;
}

// Snap a freely-dragged fraction (0–1 of the screen) to the closest named size.
export function nearestSize(fraction: number): RegionSize {
  let best = SIZE_OPTIONS[0];
  for (const option of SIZE_OPTIONS) {
    if (Math.abs(option.fraction - fraction) < Math.abs(best.fraction - fraction)) {
      best = option;
    }
  }
  return best.id;
}

function fractionFor(size: RegionSize): number {
  return fractionForSize(size);
}

function clampRound(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function resolvePreset(
  preset: LayoutPreset,
  win: { width: number; height: number }
): ResolvedLayout {
  return {
    explorer: preset.files.on,
    ai: preset.ai.on,
    terminal: preset.terminal.on,
    explorerWidth: clampRound(
      win.width * fractionFor(preset.files.size),
      BOUNDS.explorer.min,
      BOUNDS.explorer.max
    ),
    aiWidth: clampRound(
      win.width * fractionFor(preset.ai.size),
      BOUNDS.ai.min,
      BOUNDS.ai.max
    ),
    terminalHeight: clampRound(
      win.height * fractionFor(preset.terminal.size),
      BOUNDS.terminal.min,
      BOUNDS.terminal.max
    ),
  };
}

// True when the workbench's current visibility matches this preset's on/off
// flags. (We match on visibility, not exact pixels, so a hand-resized panel
// still reads as "this preset".)
export function presetMatchesVisibility(
  preset: LayoutPreset,
  state: { explorer: boolean; terminal: boolean; ai: boolean }
): boolean {
  return (
    preset.files.on === state.explorer &&
    preset.terminal.on === state.terminal &&
    preset.ai.on === state.ai
  );
}

export function summarizePreset(preset: LayoutPreset): string {
  const sizeLabel = (size: RegionSize) =>
    SIZE_OPTIONS.find((option) => option.id === size)?.label ?? size;
  const parts: string[] = [];
  if (preset.files.on) parts.push(`Files ${sizeLabel(preset.files.size)}`);
  if (preset.terminal.on) parts.push(`Terminal ${sizeLabel(preset.terminal.size)}`);
  if (preset.ai.on) parts.push(`AI ${sizeLabel(preset.ai.size)}`);
  return parts.length ? parts.join(" · ") : "Editor only";
}

export const BUILTIN_PRESETS: LayoutPreset[] = [
  {
    id: "focus",
    name: "Focus",
    builtin: true,
    files: { on: false, size: "quarter" },
    ai: { on: false, size: "quarter" },
    terminal: { on: false, size: "quarter" },
  },
  {
    id: "code",
    name: "Code",
    builtin: true,
    files: { on: true, size: "quarter" },
    ai: { on: false, size: "quarter" },
    terminal: { on: false, size: "quarter" },
  },
  {
    id: "pair",
    name: "AI Pair",
    builtin: true,
    files: { on: true, size: "eighth" },
    ai: { on: true, size: "third" },
    terminal: { on: false, size: "quarter" },
  },
  {
    id: "run",
    name: "Run",
    builtin: true,
    files: { on: true, size: "quarter" },
    ai: { on: false, size: "quarter" },
    terminal: { on: true, size: "third" },
  },
  {
    id: "full",
    name: "Full",
    builtin: true,
    files: { on: true, size: "quarter" },
    ai: { on: true, size: "quarter" },
    terminal: { on: true, size: "quarter" },
  },
];

const STORE_KEY = "klide-custom-layouts";

export function loadCustomPresets(): LayoutPreset[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LayoutPreset[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomPresets(presets: LayoutPreset[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(presets));
}

export function makePresetId(): string {
  return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyDraft(): Omit<LayoutPreset, "id"> {
  return {
    name: "",
    files: { on: true, size: "quarter" },
    ai: { on: true, size: "quarter" },
    terminal: { on: false, size: "third" },
  };
}
