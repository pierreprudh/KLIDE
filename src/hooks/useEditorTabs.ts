import { useEffect, useRef, useState } from "react";
import { type OnMount } from "@monaco-editor/react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { readWorkspaceTextFile, writeWorkspaceTextFile } from "../workspaceFs";

// One open file in the editor. `diskCode` is the last content loaded from /
// saved to disk — the baseline for deciding whether a watch event is a real
// external edit or just noise (our own save, a rename).
export type Tab = {
  path: string;
  code: string;
  dirty: boolean;
  externalChanged?: boolean;
  diskCode?: string;
};

function filename(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Owns the editor's open tabs: which files are open, which is active, their
 * dirty/disk state, and every mutation (open, edit, save, close, rename,
 * delete, agent-write). Also owns the reveal-on-open behaviour (jump to a
 * line after a search-result click) and the on-disk watcher that flags
 * externally-changed files. The host passes a `notify` sink for status-bar
 * messages; everything else about a file's lifecycle lives here.
 */
export type AutoSaveMode = "off" | "delay" | "blur";

export function useEditorTabs(opts: {
  notify: (msg: string) => void;
  workspaceRoot: string | null;
  /** Auto-save dirty tabs: after a 1s typing pause, or when the window loses focus. */
  autoSave?: AutoSaveMode;
  /** Ask before closing a tab with unsaved changes. Defaults to true. */
  confirmCloseDirty?: boolean;
}) {
  const { notify, workspaceRoot, autoSave = "off", confirmCloseDirty = true } = opts;
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const active = activeIdx >= 0 ? tabs[activeIdx] : null;

  // Latest tabs for timers/listeners (auto-save reads state outside render).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Monaco instance + the position a search-result click wants to land on.
  // The reveal runs in an effect so it fires after the tab's content commits.
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [pendingReveal, setPendingReveal] = useState<
    { path: string; line: number; column: number } | null
  >(null);
  useEffect(() => {
    if (!pendingReveal || active?.path !== pendingReveal.path) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(pendingReveal.line);
    editor.setPosition({ lineNumber: pendingReveal.line, column: pendingReveal.column });
    editor.focus();
    setPendingReveal(null);
  }, [pendingReveal, activeIdx]);

  function openFile(
    p: string,
    content: string,
    position?: { line: number; column: number }
  ) {
    if (position) setPendingReveal({ path: p, ...position });
    const existing = tabs.findIndex((t) => t.path === p);
    if (existing >= 0) {
      setActiveIdx(existing);
      return;
    }
    setTabs([
      ...tabs,
      { path: p, code: content, dirty: false, externalChanged: false, diskCode: content },
    ]);
    setActiveIdx(tabs.length);
  }

  function updateActiveCode(v: string) {
    if (activeIdx < 0) return;
    setTabs(
      tabs.map((t, i) => (i === activeIdx ? { ...t, code: v, dirty: true } : t))
    );
  }

  function onEntryRenamed(oldPath: string, newPath: string) {
    // Folder-aware: renaming a folder remaps every open tab underneath it.
    setTabs((cur) =>
      cur.map((t) => {
        if (t.path === oldPath) return { ...t, path: newPath };
        if (t.path.startsWith(`${oldPath}/`))
          return { ...t, path: newPath + t.path.slice(oldPath.length) };
        return t;
      })
    );
  }

  function onEntryDeleted(path: string) {
    const isGone = (p: string) => p === path || p.startsWith(`${path}/`);
    const next = tabs.filter((t) => !isGone(t.path));
    if (next.length === tabs.length) return;
    const activePath = active?.path ?? null;
    setTabs(next);
    if (next.length === 0) setActiveIdx(-1);
    else if (activePath && !isGone(activePath))
      setActiveIdx(next.findIndex((t) => t.path === activePath));
    else setActiveIdx(Math.min(Math.max(activeIdx, 0), next.length - 1));
  }

  // Write one tab to disk without any dialog — the auto-save path. Tabs
  // flagged `externalChanged` are skipped on purpose: silently overwriting a
  // file that moved under the user is exactly what auto-save must never do;
  // that conflict stays with the explicit ⌘S confirm.
  async function persistTab(path: string) {
    if (!workspaceRoot) return;
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || !tab.dirty || tab.externalChanged) return;
    const code = tab.code;
    try {
      await writeWorkspaceTextFile(workspaceRoot, path, code);
      setTabs((cur) =>
        cur.map((t) =>
          // Only clear dirty if nothing was typed while the write was in
          // flight — otherwise the newer edits keep the tab dirty.
          t.path === path && t.code === code
            ? { ...t, dirty: false, externalChanged: false, diskCode: code }
            : t
        )
      );
    } catch (e) {
      notify(`Auto-save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Auto-save "delay": debounce 1s after the last keystroke in the active tab.
  useEffect(() => {
    if (autoSave !== "delay" || !active?.dirty) return;
    const path = active.path;
    const timer = window.setTimeout(() => void persistTab(path), 1_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, active?.path, active?.code, active?.dirty, workspaceRoot]);

  // Auto-save "delay": switching tabs is a natural save point — flush the tab
  // you just left (its pending debounce timer was cleared by the cleanup above).
  useEffect(() => {
    if (autoSave !== "delay") return;
    for (const t of tabsRef.current) {
      if (t.dirty && t.path !== active?.path) void persistTab(t.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, activeIdx]);

  // Auto-save "blur": flush every dirty tab when the window loses focus.
  useEffect(() => {
    if (autoSave !== "blur") return;
    const flush = () => {
      for (const t of tabsRef.current) if (t.dirty) void persistTab(t.path);
    };
    window.addEventListener("blur", flush);
    return () => window.removeEventListener("blur", flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, workspaceRoot]);

  async function closeTab(i: number) {
    const closing = tabs[i];
    if (closing?.dirty && confirmCloseDirty) {
      // window.confirm is a no-op in Tauri's webview (always falsy) —
      // use the dialog plugin's native confirm instead.
      try {
        const ok = await confirm(
          `Close ${filename(closing.path)} with unsaved changes?`,
          { title: "Unsaved changes", kind: "warning" }
        );
        if (!ok) return;
      } catch (e) {
        console.error("Confirm dialog failed:", e);
        notify(`Confirm failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    const next = tabs.filter((_, idx) => idx !== i);
    setTabs(next);
    if (next.length === 0) setActiveIdx(-1);
    else if (i < activeIdx) setActiveIdx(activeIdx - 1);
    else if (i === activeIdx) setActiveIdx(Math.min(activeIdx, next.length - 1));
  }

  async function saveActive() {
    if (!active || !workspaceRoot) return;
    try {
      if (active.externalChanged) {
        const ok = await confirm(
          `${filename(active.path)} changed on disk while you were editing. Save anyway and overwrite the disk version?`,
          { title: "File changed on disk", kind: "warning" }
        );
        if (!ok) return;
      }
      await writeWorkspaceTextFile(workspaceRoot, active.path, active.code);
      setTabs((cur) =>
        cur.map((t, i) =>
          i === activeIdx
            ? { ...t, dirty: false, externalChanged: false, diskCode: t.code }
            : t
        )
      );
      // Routine save success isn't toasted on purpose: the dirty dot clearing
      // is the confirmation, and a toast on every ⌘S is noise. Failures and
      // disk conflicts (below / in the watcher) still surface loudly.
    } catch (e) {
      console.error("Save failed:", e);
      notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function onAgentWrote(path: string, newContent: string) {
    setTabs((cur) =>
      cur.map((t) =>
        t.path === path
          ? { ...t, code: newContent, dirty: false, externalChanged: false, diskCode: newContent }
          : t
      )
    );
  }

  // Poll every open file for external edits. A change reloads clean tabs in
  // place; for dirty tabs it raises a flag (resolved on the next save). The
  // diskCode baseline filters out our own writes and renames.
  useEffect(() => {
    if (!workspaceRoot) return;
    const openPaths = Array.from(new Set(tabs.map((t) => t.path)));
    if (openPaths.length === 0) return;

    let cancelled = false;

    const poll = () => {
      for (const path of openPaths) {
        readWorkspaceTextFile(workspaceRoot, path)
          .then((diskCode) => {
            if (cancelled) return;
            setTabs((cur) =>
              cur.map((tab) => {
                if (tab.path !== path) return tab;
                // Same as the last disk content we know about? Then this
                // event is noise (our own save, or a rename) — not an edit.
                if (diskCode === (tab.diskCode ?? tab.code)) {
                  return { ...tab, diskCode, externalChanged: false };
                }
                if (tab.dirty) {
                  notify(`${filename(path)} changed on disk`);
                  return { ...tab, diskCode, externalChanged: true };
                }
                notify(`Reloaded ${filename(path)}`);
                return { ...tab, code: diskCode, diskCode, externalChanged: false };
              })
            );
          })
          .catch(() => {
            if (cancelled) return;
            setTabs((cur) => {
              // Tab may have been renamed or closed already (e.g. via the
              // explorer context menu) — don't raise a false alarm.
              if (!cur.some((tab) => tab.path === path)) return cur;
              notify(`${filename(path)} is unavailable on disk`);
              return cur.map((tab) =>
                tab.path === path ? { ...tab, externalChanged: true } : tab
              );
            });
          });
      }
    };
    const interval = window.setInterval(poll, 2_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot, tabs.map((t) => t.path).join("\n")]);

  return {
    tabs,
    activeIdx,
    setActiveIdx,
    active,
    editorRef,
    openFile,
    updateActiveCode,
    onEntryRenamed,
    onEntryDeleted,
    closeTab,
    saveActive,
    onAgentWrote,
  };
}
