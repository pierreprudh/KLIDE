import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "../../agent/types";

// The card's IPC and toast are module-level imports; neither exists in node.
vi.mock("../../agent/client", () => ({
  resolvePermission: vi.fn(async () => {}),
  readAgentRunEvents: vi.fn(async () => []),
  reattachAgentRun: vi.fn(async () => ({ detach: () => {} })),
  getAgentRunStatus: vi.fn(async () => "running"),
  isActiveRunStatus: () => true,
}));
vi.mock("../../toast", () => ({ notify: vi.fn() }));

import { SubagentPermissionCard, SubagentWatchLine } from "./SubagentWatcher";
import { subagentActivity } from "./subagentWatch";

const CHILD = "sub_parent_call_1";
const request: PermissionRequest = {
  id: "perm_1",
  runId: CHILD,
  toolCallId: "toolu_9",
  toolName: "Bash",
  input: { command: "git add hello.txt && git commit -q -m 'add'", cwd: "/w", externalPaths: [] },
  summary: "The agent asks to run Bash git add hello.txt && git commit -q -m 'add'",
  reason: "The CLI asked before acting.",
  options: [],
};

describe("SubagentPermissionCard", () => {
  it("draws the child's command with every scope a command card offers", () => {
    const html = renderToStaticMarkup(<SubagentPermissionCard runId={CHILD} request={request} />);
    expect(html).toContain("git add hello.txt");
    expect(html).toContain("The CLI asked before acting.");
    // Once / run / project: a worker's shell command is approved like the panel's own.
    expect(html.toLowerCase()).toContain("project");
  });
});

describe("SubagentWatchLine", () => {
  it("says the child is asking, names the command, and stops the loader", () => {
    const activity = subagentActivity([
      { type: "run_started", runId: CHILD, mode: "goal", provider: "claude-code", model: "default", cwd: null, ts: 1 },
      { type: "permission_requested", runId: CHILD, request, ts: 2 },
    ]);
    const html = renderToStaticMarkup(<SubagentWatchLine activity={activity} open={false} onToggle={() => {}} hasRows />);
    expect(html).toContain(">asking<");
    expect(html).toContain("git add hello.txt");
    expect(html).not.toContain("thinking");
  });
});
