import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "../../agent/types";

// The card's IPC and toast are module-level imports; neither exists in node.
vi.mock("../../agent/client", () => ({
  stopAgentRun: vi.fn(async () => {}),
  resolvePermission: vi.fn(async () => {}),
  setRunCommandPolicy: vi.fn(async () => true),
  readAgentRunEvents: vi.fn(async () => []),
  reattachAgentRun: vi.fn(async () => ({ detach: () => {} })),
  getAgentRunStatus: vi.fn(async () => "running"),
  isActiveRunStatus: () => true,
}));
vi.mock("../../toast", () => ({ notify: vi.fn() }));

import { SubagentPermissionCard, SubagentWatchLine, WorkerCancelButton } from "./SubagentWatcher";
import { isWatchable, neverStarted, subagentActivity } from "./subagentWatch";

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
    // And the one option the panel's card never needs: the worker has no foot
    // bar, so its rung is flipped from here.
    expect(html).toContain("Full auto");
  });
});

describe("SubagentWatchLine", () => {
  const asking = subagentActivity([
    { type: "run_started", runId: CHILD, mode: "goal", provider: "claude-code", model: "default", cwd: null, ts: 1 },
    { type: "permission_requested", runId: CHILD, request, ts: 2 },
  ]);

  it("closed, says the child needs approval and stops the loader", () => {
    const html = renderToStaticMarkup(<SubagentWatchLine activity={asking} open={false} onToggle={() => {}} hasRows />);
    expect(html).toContain("Needs approval");
    expect(html).not.toContain("klide-orbit-loader");
    expect(html).not.toContain("thinking");
  });

  it("open, says the child is asking and names the command", () => {
    const html = renderToStaticMarkup(<SubagentWatchLine activity={asking} open onToggle={() => {}} hasRows />);
    expect(html).toContain(">asking<");
    expect(html).toContain("git add hello.txt");
    expect(html).not.toContain("klide-orbit-loader");
  });
});

describe("worker cancellation control", () => {
  const render = (activity: ReturnType<typeof subagentActivity>, runId?: string, stage?: string) =>
    renderToStaticMarkup(<><WorkerCancelButton runId={runId} active={isWatchable(activity)} /><SubagentWatchLine activity={activity} stage={stage} open={false} onToggle={() => {}} hasRows={false} /></>);

  it("offers Cancel for a worker during setup, while queued and while running", () => {
    for (const stage of ["Running setup…", "Queued behind 4 running API workers", undefined]) {
      expect(render(subagentActivity([]), "child", stage)).toContain('aria-label="Cancel worker"');
    }
    expect(render(subagentActivity([{ type: "run_started", runId: "child", mode: "goal", provider: "openai", model: "test", cwd: null, ts: 0 }]), "child")).toContain('aria-label="Cancel worker"');
  });

  it("offers no cancellation for settled workers or a dispatch without an address", () => {
    expect(render(neverStarted("Cancelled during setup."), "child")).not.toContain('aria-label="Cancel worker"');
    expect(render(subagentActivity([]))).not.toContain('aria-label="Cancel worker"');
    expect(render(subagentActivity([{ type: "run_result", runId: "child", result: { status: "done" }, ts: 0 }]), "child")).not.toContain('aria-label="Cancel worker"');
  });

  it.each(["Setup was cancelled before the worker started.", "Run aborted by user."])("calls an aborted dispatch Cancelled: %s", (message) => {
    const activity = subagentActivity([{ type: "run_error", runId: "child", error: { code: "aborted", message, retryable: true }, ts: 0 }]);
    const html = render(activity, "child");
    expect(html).toContain("Cancelled");
    expect(html).not.toContain("Completed");
    expect(html).not.toContain('aria-label="Cancel worker"');
  });
});
