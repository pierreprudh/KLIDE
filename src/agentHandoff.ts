export type HandoffMessage = {
  role: "user" | "assistant";
  text: string;
};

export type HandoffContextItem = {
  label?: string;
  path: string;
  detail?: string;
};

export type HandoffSummary = {
  title: string;
  goal: string;
  body: string;
  delegatePrompt: string;
  filesTouched: string[];
  nextSteps: string[];
};

type BuildHandoffInput = {
  messages: HandoffMessage[];
  title?: string | null;
  sourceLabel?: string | null;
  cwd?: string | null;
  model?: string | null;
  contextItems?: HandoffContextItem[];
  files?: string[];
  tools?: string[];
};

const MAX_STATE_CHARS = 1200;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 3) + "..." : oneLine;
}

function titleFrom(text: string): string {
  const trimmed = clip(text, 80);
  return trimmed || "Untitled handoff";
}

function unique(items: Array<string | null | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const value = item?.trim();
    if (!value || value === "." || seen.has(value)) continue;
    seen.add(value);
    if (seen.size >= limit) break;
  }
  return Array.from(seen);
}

function bulletList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None captured.";
}

export function buildRunHandoff(input: BuildHandoffInput): HandoffSummary {
  const messages = input.messages.filter((m) => m.text.trim());
  const userTurns = messages.filter((m) => m.role === "user");
  const assistantTurns = messages.filter((m) => m.role === "assistant");
  const firstUser = userTurns[0]?.text.trim() || "Continue the current task.";
  const lastUser = userTurns[userTurns.length - 1]?.text.trim() || firstUser;
  const lastAssistant = assistantTurns[assistantTurns.length - 1]?.text.trim() || "";
  const contextItems = input.contextItems ?? [];
  const filesTouched = unique(
    [
      ...(input.files ?? []),
      ...contextItems.map((item) => item.path),
    ],
    24
  );
  const tools = unique(input.tools ?? [], 12);
  const nextSteps = [
    "Inspect the relevant files before editing.",
    "Continue from the last user request.",
    "Run an appropriate validation command if files change.",
  ];
  const source = input.sourceLabel?.trim() || "Klide";
  const title = input.title?.trim() || titleFrom(firstUser);
  const currentState = lastAssistant
    ? clip(lastAssistant, MAX_STATE_CHARS)
    : "No assistant summary was captured yet.";

  const body = [
    `# Goal\n\n${firstUser}`,
    `# Last user request\n\n${lastUser}`,
    `# Current state\n\n${currentState}`,
    `# Relevant files\n\n${bulletList(filesTouched.map((path) => `\`${path}\``))}`,
    contextItems.length
      ? `# Context\n\n${contextItems
          .slice(0, 8)
          .map((item) => {
            const label = item.label?.trim() || "Context";
            const detail = item.detail?.trim();
            return `- ${label}: \`${item.path}\`${detail ? ` - ${clip(detail, 180)}` : ""}`;
          })
          .join("\n")}`
      : "# Context\n\n- None captured.",
    `# Tools used\n\n${bulletList(tools)}`,
    `# Next steps\n\n${bulletList(nextSteps)}`,
  ].join("\n\n");

  const delegatePrompt = [
    `You are taking over this coding task from ${source}.`,
    input.cwd ? `Workspace: ${input.cwd}` : null,
    input.model ? `Previous model/source: ${input.model}` : null,
    "",
    body,
    "",
    "Do not assume the prior agent was correct. Verify the current workspace state, then continue from the handoff.",
  ]
    .filter((part): part is string => part !== null)
    .join("\n");

  return {
    title,
    goal: firstUser,
    body,
    delegatePrompt,
    filesTouched,
    nextSteps,
  };
}
