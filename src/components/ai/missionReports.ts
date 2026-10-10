import { terminalOutcome, type DurableMissionBundle } from "../../agent/durableMissions";
import type { Msg } from "./types";

/** Keep the completion message brief; evidence stays in the Mission panel. */
export function missionReportSummary(markdown: string): string {
  const sections = markdown.split(/^### /m);
  const title = sections[0].trim();
  const results = sections.slice(1).map(section => {
    const [heading, ...body] = section.split("\n");
    const answer = body.join("\n").split(/^Worker: /m)[0].trim();
    const excerpt = answer.length > 400 ? `${answer.slice(0, 397)}…` : answer;
    return `**${heading.trim()}**\n${excerpt}`;
  });
  return results.length ? `${title}\n\n${results.join("\n\n")}\n\nFull report and workers are in the Mission side panel.` : markdown;
}

/** Deliver only settled reports owned by this chat; durable text also dedups
 * transcript/history hydration where the local message marker was absent. */
export function appendMissionReports(messages: Msg[], bundles: DurableMissionBundle[], runId: string): Msg[] {
  let next = messages;
  for (const bundle of bundles) {
    const report = bundle.report;
    if (!report || bundle.mission.coordinatorRunId !== runId || terminalOutcome(bundle.events)?.event.type !== "mission_completed") continue;
    const summary = missionReportSummary(report.markdown);
    const existing = next.findIndex(msg => msg.role === "assistant" && (msg.missionReportId === bundle.mission.id || msg.content === report.markdown || msg.content === summary));
    if (existing >= 0) {
      const msg = next[existing];
      if (msg.role === "assistant" && (msg.content !== summary || msg.missionReportId !== bundle.mission.id)) {
        next = next.map((row, i) => i === existing ? { ...msg, content: summary, missionReportId: bundle.mission.id } : row);
      }
      continue;
    }
    next = [...next, { role: "assistant", content: summary, missionReportId: bundle.mission.id, ts: report.completedMs }];
  }
  return next;
}
