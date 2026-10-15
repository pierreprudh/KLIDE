import type { Msg } from "./types";

/** What Harness settings say about naming conversations. Absent means on,
 *  like every default-on toggle in the catalog. */
export type NamingSettings = {
  nameConversations?: boolean;
  namingProvider?: string;
  namingModel?: string;
};

/** The `naming` field of a run request: ask Rust to name this conversation
 *  (with the pinned pair, when Settings names one), or nothing. Asked only on
 *  a thread's first turn — one user message so far — for a thread nobody has
 *  named, never for a subagent's turn. OpenCode threads are asked too: the
 *  CLI's own name arrives first on its feed and the first name wins. */
export function namingRequestFor(input: {
  settings?: NamingSettings;
  messages: readonly Pick<Msg, "role">[];
  renamed: boolean;
  subagent: boolean;
}): { model?: { provider: string; model: string } } | undefined {
  if (input.settings?.nameConversations === false || input.subagent || input.renamed) return undefined;
  if (input.messages.filter((m) => m.role === "user").length > 1) return undefined;
  const provider = input.settings?.namingProvider?.trim();
  const model = input.settings?.namingModel?.trim();
  return provider && model ? { model: { provider, model } } : {};
}
