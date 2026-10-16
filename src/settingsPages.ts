import type { SettingsSectionId } from "./settingsStore";

type SettingsPage = { id: string; label: string };

export const SETTINGS_PAGES: Partial<Record<SettingsSectionId, readonly SettingsPage[]>> = {
  "layout": [
    { id: "layout-presets", label: "Presets" },
    { id: "layout-builder", label: "Layout builder" },
    { id: "layout-grid", label: "Workspace grid" },
    { id: "layout-sizes", label: "Panel sizes" },
  ],
  "ai": [
    { id: "ai-model", label: "Provider & model" },
    { id: "ai-inference", label: "Reasoning & context" },
    { id: "ai-execution", label: "Tools & editing" },
    { id: "ai-harness", label: "Tools per mode" },
    { id: "ai-automation", label: "Models & memory" },
    { id: "ai-prompts", label: "System prompts" },
    { id: "ai-sessions", label: "Sessions & connections" },
  ],
  "api": [
    { id: "api-keys", label: "API keys" },
    { id: "api-balance", label: "Balance" },
    { id: "api-gateway", label: "Provider gateway" },
    { id: "api-endpoints", label: "Custom endpoints" },
  ],
  "subscription": [
    { id: "subscription-accounts", label: "Accounts" },
    { id: "subscription-setup", label: "CLI setup" },
    { id: "subscription-models", label: "Model options" },
    { id: "subscription-custom", label: "Custom CLI agents" },
    { id: "subscription-mode", label: "Bridge mode" },
  ],
};

export function defaultSettingsPage(section: SettingsSectionId): string {
  return SETTINGS_PAGES[section]?.[0].id ?? section;
}

const SEARCH_PAGES: Record<string, string> = {
  "Panel sizes": "layout-sizes",
  "Layout presets": "layout-presets",
  "Context window": "ai-inference",
  "Effort & reflection": "ai-inference",
  "Diff review before edits": "ai-execution",
  "Stop after rejection": "ai-execution",
  "Max parallel tools": "ai-execution",
  "Max turns": "ai-execution",
  "Command timeout": "ai-execution",
  "Test after edit": "ai-execution",
  "Tool overrides": "ai-harness",
  "System prompts": "ai-prompts",
  "Auto-draft memory on run done": "ai-automation",
  "Eyes model (OCR)": "ai-automation",
  "Provider gateway (opencodex)": "api-gateway",
};

/** Search must reveal the page containing the control, including on first visit. */
export function settingsPageForSearch(section: SettingsSectionId, label: string): string {
  const pages = SETTINGS_PAGES[section];
  const destination = SEARCH_PAGES[label];
  return pages?.find((page) => page.id === destination || page.label === label)?.id
    ?? defaultSettingsPage(section);
}

// Search uses friendly group labels; the page may use a shorter control title.
const SEARCH_TARGETS: Record<string, string> = {
  "Automatic light/dark theme": "Auto theme",
  "Profile picture in conversations": "Your profile picture",
  "Welcome film": "Welcome",
  "Panel visibility": "Panels",
  "Layout presets": "Presets",
  "Local servers (Ollama / MLX)": "Local Servers",
  "Provider gateway (opencodex)": "Provider gateway",
  "CLI subscriptions": "Connections & Accounts",
  "GitHub account": "GitHub",
  "Editor font size": "Font size",
  "Diff review before edits": "Require diff review",
  "Tool overrides": "Tools per mode",
  "Max parallel tools": "Parallel tool calls",
  "Max turns": "Max tool turns",
  "Auto-draft memory on run done": "Auto-draft memory on run done",
  "Saved conversations & disk usage": "Saved conversations",
  "Usage & stats": "Activity",
  "Custom endpoints": "Self-hosted endpoints",
};

/** null means the result describes the whole page, so reveal its heading. */
export function settingsSearchTarget(section: SettingsSectionId, label: string, query = ""): string | null {
  if (label === "Effort & reflection") {
    return /reflection|thinking|reason/i.test(query) ? "Reflection" : "Effort";
  }
  if (label === "Files & tabs") {
    if (/hidden|dotfile/i.test(query)) return "Show hidden files";
    if (/clos|unsaved|confirm/i.test(query)) return "Confirm before closing unsaved tabs";
    return "Files";
  }
  if (SEARCH_TARGETS[label]) return SEARCH_TARGETS[label];
  if (label === "Connectors (MCP servers)" ||
      SETTINGS_PAGES[section]?.some((page) => page.label === label)) return null;
  return label;
}
