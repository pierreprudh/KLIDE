import { useSyncExternalStore } from "react";
import { MemoryIcon } from "../icons";
import { getMemoryDrafts, subscribeMemoryDrafts, MEMORY_DRAFT_TTL } from "../memoryDrafts";

export function MemoryInboxIcon({ workspaceRoot }: { workspaceRoot: string | null }) {
  const drafts = useSyncExternalStore(subscribeMemoryDrafts, getMemoryDrafts);
  const count = drafts.filter((d) => d.workspaceRoot === workspaceRoot &&
    (!d.automatic || Date.now() - d.createdAtMs < MEMORY_DRAFT_TTL)).length;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={count ? `${count} memory proposals to review` : "Memory"}>
    <MemoryIcon size={15} />
    {count > 0 && <span aria-label={`${count} pending memory proposals`} style={{ fontSize: 10, color: "var(--fg-subtle)" }}>{count}</span>}
  </span>;
}
