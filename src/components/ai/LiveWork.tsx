// The run while it is still going — read, not opened.
//
// Under the "Working" line the operator follows the thread: the sentence the
// model wrote before a call, the next sentence after. The calls between are
// one quiet line each stretch — "Read files, searched files" once they are
// done, "Running curl …" while one is — and the thinking folds away with the
// rows, except that a turn which said nothing shows the gist of its thought
// where its sentence would be, one shade quieter: a thought, not a reply.
// Nothing here is a second drawing of a tool row: when the answer
// lands the run folds to "Worked for" and a click gives the real rows back.
// The rule for what shows is `liveWorkSteps` (toolRuns.ts); this only draws.

import type { Msg } from "./types";
import { renderMarkdown } from "../markdown";
import { ToolIcon } from "./icons";
import { liveWorkLine, liveWorkSteps, visibleProse, workSummary, type ToolResultPairing } from "./toolRuns";

export function LiveWork({ msgs, start, end, pairing }: { msgs: Msg[]; start: number; end: number; pairing: ToolResultPairing }) {
  const steps = liveWorkSteps(msgs, start, end, pairing);
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <div aria-hidden="true" style={{ flexShrink: 0, width: 22 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {steps.map((step, i) => {
          if (step.kind === "prose") {
            const m = msgs[step.index];
            if (m.role !== "assistant") return null;
            // The last step is the sentence still arriving; the rest are
            // settled and need no streaming cursor (the markdown tail draws it).
            const streaming = i === steps.length - 1 && step.index === msgs.length - 1;
            return (
              <div key={step.index} style={{ margin: "6px 0", fontSize: 14, lineHeight: 1.6 }}>
                {renderMarkdown(visibleProse(m), { streaming, visuals: true })}
              </div>
            );
          }
          if (step.kind === "thought") {
            return (
              <div key={`thought-${step.index}`} style={{ margin: "6px 0", fontSize: 14, lineHeight: 1.6, color: "var(--fg-subtle)" }}>
                {renderMarkdown(step.text)}
              </div>
            );
          }
          const live = step.live;
          const line = live ? liveWorkLine(live) : workSummary(step.names);
          const icon = live ? live.name : step.names[0] ?? "tool";
          return (
            <div
              key={`work-${i}`}
              className={live ? "klide-live-work is-live" : "klide-live-work"}
              title={live ? undefined : `${step.calls} tool call${step.calls === 1 ? "" : "s"} · ${step.names.join(", ")}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: "6px 0",
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--fg-dim)",
                minWidth: 0,
              }}
            >
              <span style={{ display: "inline-flex", flexShrink: 0, opacity: 0.8 }}>
                <ToolIcon name={icon} size={13} />
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
