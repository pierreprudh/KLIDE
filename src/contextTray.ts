export type ProjectContextMode = "off" | "auto";

export type ProjectContextItem = {
  id: string;
  path: string;
  label: string;
  detail: string;
  weight?: number;
};

export type ProjectContextSnapshot = {
  selectedPath: string;
  focused: ProjectContextItem[];
  feature: ProjectContextItem[];
  workspace: ProjectContextItem[];
  lens: ProjectContextItem[];
};

export const CONTEXT_MODE_LABELS: Record<ProjectContextMode, string> = {
  off: "Lens off",
  auto: "Auto lens",
};

function uniqueItems(items: ProjectContextItem[]): ProjectContextItem[] {
  const seen = new Set<string>();
  const out: ProjectContextItem[] = [];
  for (const item of items) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
  }
  return out;
}

function queryTokens(input: string): string[] {
  return [...new Set(input.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])].slice(0, 12);
}

export function lensItemsForPrompt(
  snapshot: ProjectContextSnapshot | null | undefined,
  input: string,
  mode: ProjectContextMode
): ProjectContextItem[] {
  if (!snapshot || mode === "off") return [];
  const tokens = queryTokens(input);
  const candidates = uniqueItems([...snapshot.focused, ...snapshot.lens, ...snapshot.feature]);
  if (tokens.length === 0) return candidates.slice(0, 4);
  return candidates
    .map((item, index) => {
      const haystack = `${item.path} ${item.label} ${item.detail}`.toLowerCase();
      const matches = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      const activeBoost = snapshot.focused.some((focused) => focused.path === item.path) ? 4 : 0;
      const pathBoost = tokens.some((token) => item.path.toLowerCase().includes(token)) ? 3 : 0;
      const score = matches * 5 + activeBoost + pathBoost + (item.weight ?? 0) - index * 0.05;
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item)
    .slice(0, 6);
}

export function estimateProjectContextTokens(items: ProjectContextItem[]): number {
  return items.reduce(
    (sum, item) => sum + Math.ceil(`${item.path}\n${item.label}\n${item.detail}`.length / 3.7),
    0
  );
}
