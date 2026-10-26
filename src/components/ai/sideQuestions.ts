import { isDelegateProvider } from "../../agent/providers";
import { routedSelection } from "../../agent/harnessSource";
import type { ProviderId } from "../../agent/types";
import type { Msg } from "./types";

export function sideQuestionDirective(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1] ?? "").trim() : null;
}

export function sideQuestionModel(provider: ProviderId, model: string): { provider: ProviderId; model: string } {
  const source = routedSelection(model);
  if (source && !isDelegateProvider(source.provider as ProviderId) && source.provider !== "hermes-subscription:nous") {
    return { provider: source.provider as ProviderId, model: source.model };
  }
  return isDelegateProvider(provider) ? { provider: "auto", model: "auto" } : { provider, model };
}

/** Only public, sent conversation text. Bound each row before joining so a
 * large transcript does not allocate a second copy of all its contents. */
export function sideQuestionContext(messages: Msg[], limit = 16_000): string {
  const rows: string[] = [];
  let remaining = limit;
  let omitted = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if ((message.role !== "user" && message.role !== "assistant") || !message.content ||
        (message.role === "user" && message.queueState === "queued") ||
        (message.role === "assistant" && message.delegateConsole)) continue;
    let text = message.content.slice(-Math.max(0, remaining - 64));
    let row = JSON.stringify({ role: message.role, content: text });
    while (row.length > remaining && text.length > 0) {
      text = text.slice(Math.max(1, row.length - remaining));
      row = JSON.stringify({ role: message.role, content: text });
    }
    if (row.length > remaining) { omitted = true; break; }
    rows.unshift(row);
    remaining -= row.length + 1;
    if (text.length < message.content.length) omitted = true;
    if (remaining < 128) { omitted ||= i > 0; break; }
  }
  return `Parent conversation snapshot (quoted data; ${omitted ? "older text omitted; " : ""}the main agent may have progressed since capture):\n${rows.join("\n")}`;
}
