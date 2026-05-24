import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile, watch, type DirEntry } from "@tauri-apps/plugin-fs";
import { useEffect, useState } from "react";

type Props = {
  onOpen: (path: string, content: string) => void;
  onRootChange: (root: string | null) => void;
  visible: boolean;
};

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function FolderRow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5C3 6.4 3.9 5.5 5 5.5h3.5l2 2H19c1.1 0 2 .9 2 2v7c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-9z" />
    </svg>
  );
}

function FileRow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H6c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V9l-6-6z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

export function Sidebar({ onOpen, onRootChange, visible }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);

  async function pickFolder() {
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    setRoot(picked);
    setEntries(await readDir(picked));
    onRootChange(picked);
  }

  useEffect(() => {
    if (!root) return;
    let unwatch: (() => void) | undefined;
    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await readDir(root);
        if (!cancelled) setEntries(next);
      } catch (e) {
        console.error("readDir failed during watch refresh:", e);
      }
    };

    watch(root, refresh, { recursive: true, delayMs: 100 })
      .then((un) => {
        if (cancelled) un();
        else unwatch = un;
      })
      .catch((e) => console.error("fs.watch failed:", e));

    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, [root]);

  async function pick(name: string) {
    if (!root) return;
    const path = `${root}/${name}`;
    onOpen(path, await readTextFile(path));
  }

  return (
    <aside
      style={{
        width: "var(--size-sidebar)",
        background: "var(--bg-elevated)",
        borderRight: "1px solid var(--border)",
        overflow: "auto",
        display: visible ? "flex" : "none",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "10px 12px 8px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 11,
          color: "var(--fg-subtle)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        <span>Explorer</span>
        <button
          onClick={pickFolder}
          title="Open folder…"
          style={{
            fontSize: 11,
            color: "var(--fg-subtle)",
            padding: "2px 6px",
            borderRadius: 4,
            transition: "color 120ms ease, background 120ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--fg-strong)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--fg-subtle)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          Open…
        </button>
      </header>

      {root && (
        <div
          style={{
            padding: "0 12px 6px",
            fontSize: 12,
            color: "var(--fg-strong)",
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={root}
        >
          {root.split("/").pop()}
        </div>
      )}

      <ul style={{ listStyle: "none", padding: "4px 4px 8px", margin: 0 }}>
        {entries
          .slice()
          .sort(
            (a, b) =>
              Number(b.isDirectory) - Number(a.isDirectory) ||
              a.name.localeCompare(b.name)
          )
          .map((e) => {
            const isDir = e.isDirectory;
            return (
              <li
                key={e.name}
                onClick={() => !isDir && pick(e.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 8px",
                  borderRadius: 4,
                  color: isDir ? "var(--fg-subtle)" : "var(--fg)",
                  cursor: isDir ? "default" : "pointer",
                  fontSize: 13,
                  userSelect: "none",
                  transition: "background 100ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    width: 12,
                    color: "var(--fg-subtle)",
                  }}
                >
                  {isDir ? <ChevronRight /> : null}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    color: "var(--fg-subtle)",
                  }}
                >
                  {isDir ? <FolderRow /> : <FileRow />}
                </span>
                <span style={{ whiteSpace: "nowrap" }}>{e.name}</span>
              </li>
            );
          })}
      </ul>
    </aside>
  );
}
