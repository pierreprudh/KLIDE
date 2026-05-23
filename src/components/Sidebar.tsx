import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile, type DirEntry } from "@tauri-apps/plugin-fs";
import { useState } from "react";

type Props = {
  onOpen: (path: string, content: string) => void;
  onRootChange: (root: string | null) => void;
};

export function Sidebar({ onOpen, onRootChange }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);

  async function pickFolder() {
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    setRoot(picked);
    setEntries(await readDir(picked));
    onRootChange(picked);
  }

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
        padding: "10px 12px",
        overflow: "auto",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-muted)",
          letterSpacing: "0.08em",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        EXPLORER
        <button onClick={pickFolder} style={{ fontSize: 11, color: "var(--fg-muted)" }}>
          open…
        </button>
      </div>

      {root && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: "var(--fg-dim)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={root}
        >
          {root.split("/").pop()}
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
        {entries
          .slice()
          .sort(
            (a, b) =>
              Number(b.isDirectory) - Number(a.isDirectory) ||
              a.name.localeCompare(b.name)
          )
          .map((e) => (
            <li
              key={e.name}
              onClick={() => !e.isDirectory && pick(e.name)}
              style={{
                padding: "2px 6px",
                borderRadius: 3,
                color: e.isDirectory ? "var(--fg-muted)" : "var(--fg)",
                cursor: e.isDirectory ? "default" : "pointer",
                fontSize: 12,
              }}
            >
              {e.isDirectory ? "▸ " : "  "}
              {e.name}
            </li>
          ))}
      </ul>
    </aside>
  );
}
