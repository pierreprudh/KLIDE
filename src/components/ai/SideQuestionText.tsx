import type { ReactNode } from "react";

/** A transcript shortcut opens the existing side chat without resending text. */
export function SideQuestionText({ text, onOpen }: { text: string; onOpen: () => void }) {
  const parts: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(/(^|[\s(])\/btw(?=$|[\s.,!?;:)\]])/g)) {
    const start = match.index + match[1].length;
    parts.push(text.slice(end, start));
    parts.push(<button key={start} type="button" className="klide-btw-inline" title="Open side question" onClick={onOpen}>/btw</button>);
    end = start + 4;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}
