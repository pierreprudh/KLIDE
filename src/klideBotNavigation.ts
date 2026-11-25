import type { BotMention } from "./ipc/klideBot";

type Opener = (mention: BotMention) => Promise<void>;
let opener: Opener | null = null;

export function registerKlideBotOpener(next: Opener | null): void { opener = next; }
export function canLookIntoMention(): boolean { return !!opener; }
export async function lookIntoMention(mention: BotMention): Promise<void> {
  if (!opener) throw new Error("Open a workspace to look into this mention");
  return opener(mention);
}
