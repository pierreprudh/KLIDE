import type { KlideConvo } from "./klideConvos";
import type { RunLedgerEntry } from "./runLedger";
import type { TaskSession } from "./tasks";

export type RunLineage = {
  parent: RunLedgerEntry | null;
  children: RunLedgerEntry[];
};

/** The one resolved subject for Mission Control's detail pane.
 *
 * Durable transcripts deliberately win over an in-memory conversation with
 * the same id: they contain the complete event history and support resume.
 * Until that transcript lands, the live conversation supplies the same Run
 * interface plus its in-memory messages. Keeping that precedence here makes
 * the detail pane a consumer of one Inspection instead of reimplementing
 * source arbitration, live/durable dedupe, and lineage separately. */
export type RunInspection =
  | {
      kind: "task";
      task: TaskSession;
    }
  | {
      kind: "run";
      run: RunLedgerEntry;
      liveConversation: KlideConvo | null;
      lineage: RunLineage;
    };

export type ResolveRunInspectionInput = {
  selectedId: string | null;
  tasks: TaskSession[];
  conversations: KlideConvo[];
  entries: RunLedgerEntry[];
  workspaceRoot: string | null;
};

function conversationInWorkspace(
  conversation: KlideConvo,
  workspaceRoot: string | null,
): boolean {
  return !workspaceRoot || !conversation.cwd || conversation.cwd === workspaceRoot;
}

function lineageFor(run: RunLedgerEntry, entries: RunLedgerEntry[]): RunLineage {
  const parentId = run.forkedFrom?.conversationId;
  const children = entries
    .filter((entry) => entry.forkedFrom?.conversationId === run.id)
    .sort(
      (a, b) =>
        b.updatedMs - a.updatedMs ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  return {
    parent: parentId ? entries.find((entry) => entry.id === parentId) ?? null : null,
    children,
  };
}

export function resolveRunInspection({
  selectedId,
  tasks,
  conversations,
  entries,
  workspaceRoot,
}: ResolveRunInspectionInput): RunInspection | null {
  if (!selectedId) return null;

  const task = tasks.find((candidate) => candidate.id === selectedId);
  if (task) return { kind: "task", task };

  const durable = entries.find(
    (entry) => entry.id === selectedId && entry.origin === "transcript",
  );
  const liveConversation = conversations.find(
    (conversation) =>
      conversation.id === selectedId && conversationInWorkspace(conversation, workspaceRoot),
  );
  const liveEntry = liveConversation
    ? entries.find(
        (entry) => entry.id === selectedId && entry.origin === "klide-convo",
      )
    : undefined;
  const run = durable ?? liveEntry;
  if (!run) return null;

  return {
    kind: "run",
    run,
    liveConversation: durable ? null : liveConversation ?? null,
    lineage: lineageFor(run, entries),
  };
}
