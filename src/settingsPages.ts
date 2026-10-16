import type { SettingsSectionId } from "./settingsStore";

type SettingsPage = { id: string; label: string };

export const SETTINGS_PAGES: Partial<Record<SettingsSectionId, readonly SettingsPage[]>> = {
  "general": [
    { id: "general-startup", label: "Startup & apps" },
    { id: "general-files", label: "Files & tabs" },
    { id: "general-panels", label: "Panel visibility" },
  ],
  "appearance": [
    { id: "appearance-theme", label: "Theme" },
    { id: "appearance-conversation", label: "Conversation" },
    { id: "appearance-welcome", label: "Welcome" },
  ],
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
  "Auto-save": "general-files",
  "Files & tabs": "general-files",
  "Panel visibility": "general-panels",
  "Profile picture in conversations": "appearance-conversation",
  "Welcome film": "appearance-welcome",
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
