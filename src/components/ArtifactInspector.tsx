import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import type { CheckpointEntry } from "../agent/types";
import type { ThemeId } from "../theme";
import { defineKlideMonacoThemes, getMonacoThemeId } from "../theme";
import type { GitStatus } from "../gitTypes";
import { readWorkspaceTextFile, writeWorkspaceTextFile } from "../workspaceFs";
import { notify } from "../toast";
import { DiffView, parseDiffBlocks, type FileCount } from "./diffView";

type GitBranchDiffSummary = {
  baseBranch: string;
  branch: string;
  mergeBase: string;
  diff: string;
  additions: number;
  deletions: number;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
};

type GitFileDiff = {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
};

export type ArtifactRequest =
  | {
      kind: "file";
      runId: string;
      workspaceRoot: string;
      path: string;
    }
  | {
      kind: "diff";
      runId: string;
      workspaceRoot: string;
      path: string;
      original: string;
      modified: string;
      isCreate: boolean;
    }
  | {
      kind: "checkpoint-set";
      runId: string;
      title: string;
      entries: CheckpointEntry[];
    }
  | {
      kind: "patch";
      runId: string;
      workspaceRoot: string;
      path: string;
      diff: string;
      additions: number;
      deletions: number;
      status: string;
    }
  | {
      kind: "run-review";
      runId: string;
      title: string;
      workspaceRoot: string;
      branch: string | null;
    };

type Props = {
  tabs: ArtifactTab[];
  activeTabKey: number;
  theme: ThemeId;
  onSelectTab: (key: number) => void;
  onCloseTab: (key: number) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export type ArtifactTab = {
  key: number;
  request: ArtifactRequest;
};

type TabState = {
  view: "file" | "diff";
  diskCode: string;
  draft: string;
  loadedPath: string | null;
  fileLoading: boolean;
  fileError: string | null;
  saving: boolean;
};

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return (
    {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      rs: "rust",
      py: "python",
      json: "json",
      md: "markdown",
      html: "html",
      css: "css",
      toml: "ini",
      yml: "yaml",
      yaml: "yaml",
    } as Record<string, string>
  )[ext ?? ""] ?? "plaintext";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function requestPath(request: ArtifactRequest): string {
  if (request.kind === "file" || request.kind === "diff" || request.kind === "patch") {
    return request.path;
  }
  if (request.kind === "checkpoint-set") {
    return request.entries[0]?.path ?? request.title;
  }
  return request.title;
}

function initialTabState(request: ArtifactRequest): TabState {
  return {
    view: request.kind === "file" ? "file" : "diff",
    diskCode: "",
    draft: "",
    loadedPath: null,
    fileLoading: false,
    fileError: null,
    saving: false,
  };
}

function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6.75 3.75h6.5l4 4v12.5h-10.5z" />
      <path d="M13.25 3.75v4h4" />
    </svg>
  );
}

function DiffGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M8 5v14M5 8l3-3 3 3M16 19V5M13 16l3 3 3-3" />
    </svg>
  );
}

function SaveGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 4h12l2 2v14H5z" />
      <path d="M8 4v6h8V4M8 20v-6h8v6" />
    </svg>
  );
}

function InspectorButton({
  label,
  active = false,
  disabled = false,
  tone = "neutral",
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  tone?: "neutral" | "primary";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className="artifact-inspector-button"
      data-active={active ? "true" : undefined}
      data-tone={tone}
    >
      {children}
    </button>
  );
}

function requestDiff(request: ArtifactRequest, selected: CheckpointEntry | null) {
  if (request.kind === "diff") {
    return {
      path: request.path,
      original: request.original,
      modified: request.modified,
      isCreate: request.isCreate,
      workspaceRoot: request.workspaceRoot,
    };
  }
  if (request.kind === "checkpoint-set" && selected) {
    return {
      path: selected.path,
      original: selected.oldContent,
      modified: selected.newContent,
      isCreate: selected.isCreate,
      workspaceRoot: selected.workspaceRoot,
    };
  }
  return null;
}

function PatchSurface({
  diff,
  files,
  loading,
  error,
}: {
  diff: string;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  loading?: boolean;
  error?: string | null;
}) {
  const blocks = useMemo(
    () => (diff.trim() ? parseDiffBlocks(diff.replace(/\n$/, "").split("\n")) : []),
    [diff]
  );
  const counts = useMemo(
    () =>
      new Map<string, FileCount>(
        files.map((file) => [
          file.path,
          { status: file.status, additions: file.additions, deletions: file.deletions },
        ])
      ),
    [files]
  );

  if (loading) {
    return <div className="artifact-inspector-state">Preparing review…</div>;
  }
  if (error) {
    return <div className="artifact-inspector-state" data-tone="danger">{error}</div>;
  }
  if (blocks.length === 0) {
    return <div className="artifact-inspector-state">No file changes found for this Run.</div>;
  }
  return (
    <div className="artifact-inspector-patch">
      <DiffView blocks={blocks} limit={1800} fileCounts={counts} />
    </div>
  );
}

function RunReviewSurface({ request }: { request: Extract<ArtifactRequest, { kind: "run-review" }> }) {
  const [review, setReview] = useState<{
    diff: string;
    additions: number;
    deletions: number;
    files: Array<{ path: string; status: string; additions: number; deletions: number }>;
    comparison: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function workingTreeReview() {
      const status = await invoke<GitStatus>("git_status", { workspaceRoot: request.workspaceRoot });
      const rows = await Promise.all(
        status.files.map(async (file) => {
          const result = await invoke<GitFileDiff>("git_diff", {
            workspaceRoot: request.workspaceRoot,
            path: file.path,
            staged: file.staged,
          });
          return { file, result };
        })
      );
      return {
        diff: rows.map(({ result }) => result.diff).filter(Boolean).join("\n"),
        additions: rows.reduce((sum, { result }) => sum + result.additions, 0),
        deletions: rows.reduce((sum, { result }) => sum + result.deletions, 0),
        files: rows.map(({ file, result }) => ({
          path: file.path,
          status: file.status,
          additions: result.additions,
          deletions: result.deletions,
        })),
        comparison: status.branch ? `${status.branch} working tree` : "Working tree",
      };
    }

    async function load() {
      setLoading(true);
      setError(null);
      try {
        let next = null;
        if (request.branch) {
          try {
            const branch = await invoke<GitBranchDiffSummary>("git_branch_diff", {
              workspaceRoot: request.workspaceRoot,
              branch: request.branch,
              baseBranch: null,
            });
            if (branch.diff.trim()) {
              next = {
                diff: branch.diff,
                additions: branch.additions,
                deletions: branch.deletions,
                files: branch.files,
                comparison: `${branch.baseBranch}…${branch.branch}`,
              };
            }
          } catch {
            // A delegate may not have committed or recorded a fork base yet.
            // In that case its working tree is still the useful review unit.
          }
        }
        next ??= await workingTreeReview();
        if (!cancelled) setReview(next);
      } catch (err) {
        if (!cancelled) {
          setReview(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [request.branch, request.workspaceRoot]);

  return (
    <div className="artifact-inspector-review">
      {review && (
        <div className="artifact-inspector-review-summary">
          <span className="artifact-inspector-review-branch">
            <DiffGlyph />
            <span>{review.comparison}</span>
          </span>
          <span className="artifact-inspector-review-files">
            {review.files.length} {review.files.length === 1 ? "file" : "files"}
          </span>
          <span className="artifact-inspector-review-count" data-tone="add">+{review.additions}</span>
          <span className="artifact-inspector-review-count" data-tone="remove">−{review.deletions}</span>
        </div>
      )}
      <PatchSurface
        diff={review?.diff ?? ""}
        files={review?.files ?? []}
        loading={loading}
        error={error}
      />
    </div>
  );
}

export function ArtifactInspector({
  tabs,
  activeTabKey,
  theme,
  onSelectTab,
  onCloseTab,
  onClose,
  onDirtyChange,
}: Props) {
  const [tabStates, setTabStates] = useState<Record<number, TabState>>(() =>
    Object.fromEntries(tabs.map((tab) => [tab.key, initialTabState(tab.request)]))
  );
  const openTabKeysRef = useRef(new Set<number>());
  openTabKeysRef.current = new Set(tabs.map((tab) => tab.key));

  useEffect(
    () => () => {
      openTabKeysRef.current.clear();
    },
    []
  );

  useEffect(() => {
    setTabStates((previous) => {
      const next: Record<number, TabState> = {};
      for (const tab of tabs) next[tab.key] = previous[tab.key] ?? initialTabState(tab.request);
      return next;
    });
  }, [tabs]);

  const dirtyCount = tabs.reduce((count, tab) => {
    const state = tabStates[tab.key];
    return count + (state && state.draft !== state.diskCode ? 1 : 0);
  }, 0);

  useEffect(() => {
    onDirtyChange?.(dirtyCount > 0);
  }, [dirtyCount, onDirtyChange]);

  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? tabs[0];
  if (!activeTab) return null;

  const request = activeTab.request;
  const state = tabStates[activeTab.key] ?? initialTabState(request);
  const selectedCheckpoint = request.kind === "checkpoint-set" ? request.entries[0] ?? null : null;
  const diff = requestDiff(request, selectedCheckpoint);
  const patch = request.kind === "patch" ? request : null;
  const canViewDiff = !!diff || !!patch;
  const activePath = requestPath(request);
  const workspaceRoot =
    request.kind === "file" || request.kind === "diff" || request.kind === "patch" || request.kind === "run-review"
      ? request.workspaceRoot
      : selectedCheckpoint?.workspaceRoot ?? null;
  const canOpenFile = !!workspaceRoot && request.kind !== "run-review";
  const dirty = state.draft !== state.diskCode;

  function updateTabState(key: number, patchState: Partial<TabState>) {
    setTabStates((previous) => ({
      ...previous,
      [key]: { ...(previous[key] ?? initialTabState(tabs.find((tab) => tab.key === key)?.request ?? request)), ...patchState },
    }));
  }

  useEffect(() => {
    if (state.view !== "file" || !workspaceRoot || !activePath) return;
    const loadPath = `${workspaceRoot}:${activePath}`;
    if (state.loadedPath === loadPath || state.fileLoading) return;
    const tabKey = activeTab.key;
    updateTabState(tabKey, { fileLoading: true, fileError: null });
    readWorkspaceTextFile(workspaceRoot, activePath)
      .then((content) => {
        if (!openTabKeysRef.current.has(tabKey)) return;
        updateTabState(tabKey, {
          diskCode: content,
          draft: content,
          loadedPath: loadPath,
          fileLoading: false,
        });
      })
      .catch((err) => {
        if (!openTabKeysRef.current.has(tabKey)) return;
        updateTabState(tabKey, {
          loadedPath: loadPath,
          fileLoading: false,
          fileError: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activePath, activeTab.key, state.fileLoading, state.loadedPath, state.view, workspaceRoot]);

  async function save() {
    if (!workspaceRoot || !activePath || !dirty || state.saving) return;
    const tabKey = activeTab.key;
    const draft = state.draft;
    updateTabState(tabKey, { saving: true });
    try {
      await writeWorkspaceTextFile(workspaceRoot, activePath, draft);
      if (openTabKeysRef.current.has(tabKey)) {
        updateTabState(tabKey, { diskCode: draft });
      }
      notify(`Saved ${activePath}`, { tone: "success" });
    } catch (err) {
      notify(`Save failed: ${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      if (openTabKeysRef.current.has(tabKey)) updateTabState(tabKey, { saving: false });
    }
  }

  function closeTab(tab: ArtifactTab) {
    const tabState = tabStates[tab.key];
    if (
      tabState &&
      tabState.draft !== tabState.diskCode &&
      !window.confirm(`Close ${requestPath(tab.request)} without saving your changes?`)
    ) return;
    onCloseTab(tab.key);
  }

  return (
    <section
      className="artifact-inspector"
      aria-label={`Artifact inspector: ${activePath}`}
      data-view={state.view}
      data-dirty={dirty ? "true" : undefined}
    >
      <header className="artifact-inspector-header">
        <div className="artifact-inspector-tabs" role="tablist" aria-label="Open files">
          {tabs.map((tab) => {
            const path = requestPath(tab.request);
            const tabDirty = tabStates[tab.key]?.draft !== tabStates[tab.key]?.diskCode;
            const active = tab.key === activeTab.key;
            return (
              <div key={tab.key} className="artifact-inspector-tab" data-active={active ? "true" : undefined}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="artifact-inspector-tab-select"
                  onClick={() => onSelectTab(tab.key)}
                  title={path}
                >
                  <span className="artifact-inspector-tab-icon" aria-hidden>
                    {tab.request.kind === "run-review" ? <DiffGlyph /> : <FileGlyph />}
                  </span>
                  <span className="artifact-inspector-tab-name">{fileName(path)}</span>
                  {tabDirty && <span className="artifact-inspector-tab-dirty" aria-label="Unsaved changes" />}
                </button>
                <button
                  type="button"
                  className="artifact-inspector-tab-close"
                  aria-label={`Close ${fileName(path)}`}
                  title={`Close ${path}`}
                  onClick={() => closeTab(tab)}
                >
                  <CloseGlyph />
                </button>
              </div>
            );
          })}
        </div>

        <div className="artifact-inspector-actions">
          {canViewDiff && (
            <InspectorButton label="View changes" active={state.view === "diff"} onClick={() => updateTabState(activeTab.key, { view: "diff" })}>
              Diff
            </InspectorButton>
          )}
          {canOpenFile && (
            <InspectorButton label="Open code" active={state.view === "file"} onClick={() => updateTabState(activeTab.key, { view: "file" })}>
              Code
            </InspectorButton>
          )}
          {state.view === "file" && dirty && (
            <InspectorButton label="Save file" tone="primary" disabled={state.saving} onClick={() => void save()}>
              <SaveGlyph />
              <span>{state.saving ? "Saving…" : "Save"}</span>
            </InspectorButton>
          )}
          <span className="artifact-inspector-action-divider" aria-hidden />
          <InspectorButton label="Close artifact inspector" onClick={onClose}>
            <CloseGlyph />
          </InspectorButton>
        </div>
      </header>

      <div className="artifact-inspector-body" key={`${activeTab.key}:${activePath}:${state.view}`}>
        {request.kind === "run-review" ? (
          <RunReviewSurface request={request} />
        ) : patch && state.view === "diff" ? (
          <PatchSurface
            diff={patch.diff}
            files={[{ path: patch.path, status: patch.status, additions: patch.additions, deletions: patch.deletions }]}
          />
        ) : state.view === "diff" && diff ? (
          <DiffEditor
            original={diff.original}
            modified={diff.modified}
            language={detectLanguage(diff.path)}
            theme={getMonacoThemeId(theme)}
            beforeMount={defineKlideMonacoThemes}
            options={{
              readOnly: true,
              renderSideBySide: false,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              lineHeight: 20,
              lineNumbersMinChars: 3,
              automaticLayout: true,
              renderOverviewRuler: false,
              stickyScroll: { enabled: false },
              padding: { top: 10, bottom: 18 },
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
        ) : state.fileLoading ? (
          <div className="artifact-inspector-state">Opening file…</div>
        ) : state.fileError ? (
          <div className="artifact-inspector-state" data-tone="danger">{state.fileError}</div>
        ) : (
          <Editor
            path={`artifact://${workspaceRoot}/${activePath}`}
            value={state.draft}
            onChange={(value) => updateTabState(activeTab.key, { draft: value ?? "" })}
            language={detectLanguage(activePath)}
            theme={getMonacoThemeId(theme)}
            beforeMount={defineKlideMonacoThemes}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineHeight: 20,
              lineNumbersMinChars: 3,
              lineNumbers: "on",
              wordWrap: "off",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              stickyScroll: { enabled: false },
              padding: { top: 10, bottom: 18 },
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
        )}
      </div>
    </section>
  );
}
