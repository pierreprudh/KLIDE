import { useEffect, useRef, useState } from "react";
import type { ArtifactRequest, ArtifactTab } from "../components/ArtifactInspector";

// The Artifact Inspector's docking state machine — tab list, active tab,
// open/close animation timing, and the dirty-guard on close. Extracted from
// Mission Control so the main workbench can dock the same surface without
// re-deriving the policy (tab identity, file→diff upgrade, delayed unmount).

function artifactIdentity(request: ArtifactRequest): string {
  if (request.kind === "file" || request.kind === "diff" || request.kind === "patch") {
    return `${request.workspaceRoot}:${request.path}`;
  }
  return `${request.kind}:${request.runId}`;
}

/** A checkpoint set opens as one diff tab per file, not a single grouped tab. */
function expandArtifactRequest(request: ArtifactRequest): ArtifactRequest[] {
  if (request.kind !== "checkpoint-set") return [request];
  return request.entries.map((entry) => ({
    kind: "diff",
    runId: request.runId,
    workspaceRoot: entry.workspaceRoot,
    path: entry.path,
    original: entry.oldContent,
    modified: entry.newContent,
    isCreate: entry.isCreate,
  }));
}

export function useArtifactInspector() {
  const [artifactTabs, setArtifactTabs] = useState<ArtifactTab[]>([]);
  const [activeArtifactKey, setActiveArtifactKey] = useState<number | null>(null);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [artifactDirty, setArtifactDirty] = useState(false);
  const artifactKeyRef = useRef(0);
  const artifactCloseTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (artifactCloseTimer.current !== null) window.clearTimeout(artifactCloseTimer.current);
    },
    []
  );

  function openArtifact(request: ArtifactRequest) {
    if (artifactCloseTimer.current !== null) {
      window.clearTimeout(artifactCloseTimer.current);
      artifactCloseTimer.current = null;
    }

    const requests = expandArtifactRequest(request);
    if (requests.length === 0) return;

    const next = [...artifactTabs];
    let targetKey: number | null = null;
    for (const nextRequest of requests) {
      const identity = artifactIdentity(nextRequest);
      const existingIndex = next.findIndex(
        (tab) => artifactIdentity(tab.request) === identity
      );
      if (existingIndex >= 0) {
        const existing = next[existingIndex];
        if (
          existing.request.kind === "file" &&
          (nextRequest.kind === "diff" || nextRequest.kind === "patch")
        ) {
          next[existingIndex] = { ...existing, request: nextRequest };
        }
        targetKey ??= existing.key;
        continue;
      }

      artifactKeyRef.current += 1;
      const tab = { key: artifactKeyRef.current, request: nextRequest } satisfies ArtifactTab;
      next.push(tab);
      targetKey ??= tab.key;
    }
    setArtifactTabs(next);
    setActiveArtifactKey(targetKey);
    requestAnimationFrame(() => setArtifactOpen(true));
  }

  // Slide the shell closed first, drop the tabs once the 320ms width
  // transition has finished so the content doesn't blink out mid-animation.
  function dismissArtifactWorkspace() {
    setArtifactDirty(false);
    setArtifactOpen(false);
    if (artifactCloseTimer.current !== null) window.clearTimeout(artifactCloseTimer.current);
    artifactCloseTimer.current = window.setTimeout(() => {
      setArtifactTabs([]);
      setActiveArtifactKey(null);
      artifactCloseTimer.current = null;
    }, 300);
  }

  function closeArtifact(): boolean {
    if (artifactDirty && !window.confirm("Close the Artifact Inspector without saving your changes?")) {
      return false;
    }
    dismissArtifactWorkspace();
    return true;
  }

  function closeArtifactTab(key: number) {
    const index = artifactTabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    const next = artifactTabs.filter((tab) => tab.key !== key);
    if (next.length === 0) {
      dismissArtifactWorkspace();
      return;
    }
    setArtifactTabs(next);
    if (activeArtifactKey === key) {
      setActiveArtifactKey(next[Math.min(index, next.length - 1)].key);
    }
  }

  return {
    artifactTabs,
    activeArtifactKey,
    artifactOpen,
    artifactDirty,
    setActiveArtifactKey,
    setArtifactDirty,
    openArtifact,
    closeArtifact,
    closeArtifactTab,
  };
}
