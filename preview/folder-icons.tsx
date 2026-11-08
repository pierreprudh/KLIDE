// Folder icons — three ways a project could look in the sidebar's folder card.
// Throwaway. http://localhost:1420/preview/folder-icons.html?theme=sage-garden-dark
import type { ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../src/styles/tokens.css";
import { CheckIcon, NeedsYouIcon, SwitcherIcon } from "../src/icons";
import { Flask } from "@phosphor-icons/react/dist/csr/Flask";
import { ChartBar } from "@phosphor-icons/react/dist/csr/ChartBar";
import { Bug } from "@phosphor-icons/react/dist/csr/Bug";
import { Hexagon } from "@phosphor-icons/react/dist/csr/Hexagon";
import { Terminal } from "@phosphor-icons/react/dist/csr/Terminal";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "sage-garden-dark";

type Folder = { name: string; path: string; waiting?: number; own?: string; glyph?: ReactNode; emoji?: string };
const FOLDERS: Folder[] = [
  { name: "KIDE", path: "~/Documents/Private/KIDE", waiting: 1, own: "/src-tauri/icons/128x128.png", glyph: <Terminal size={13} weight="light" /> },
  { name: "klide-acceptance", path: "~/Documents/Private/klide-acceptance", glyph: <Flask size={13} weight="light" />, emoji: "🧪" },
  { name: "klide-btw-live-20261026", path: "/private/tmp/klide-btw-live-20261026", glyph: <Bug size={13} weight="light" />, emoji: "🐛" },
  { name: "usage_tool", path: "~/Documents/Private/usage_tool", glyph: <ChartBar size={13} weight="light" />, emoji: "📊" },
  { name: "Swarm", path: "~/Documents/Private/Swarm", glyph: <Hexagon size={13} weight="light" />, emoji: "🐝" },
  { name: "Portfolio", path: "~/Documents/Private/Portfolio", own: "/preview/folder-icons/portfolio.svg", emoji: "🎨" },
];

/* Quiet hues, mixed into the theme so they never shout. */
const HUES = ["#7f9c7a", "#b0806a", "#7a8fb0", "#b39b62", "#9a7fb0", "#6fa3a0"];
function hueOf(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

type Kind = "tint" | "own" | "pick" | "none" | "folder";
function Mark({ f, kind, size }: { f: Folder; kind: Kind; size: number }) {
  if (kind === "none") return null;
  if (kind === "folder") return <span style={{ width: 16, display: "grid", placeItems: "center", flex: "none", color: "var(--fg-subtle)" }}><FolderSimple size={size > 21 ? 15 : 14} weight="light" /></span>;
  const box = { width: size, height: size, borderRadius: size > 21 ? 7 : 6, display: "grid", placeItems: "center", flex: "none", fontSize: size > 21 ? 12 : 11, overflow: "hidden" } as const;
  const tint = (hue: string) => ({ ...box, background: `color-mix(in srgb, ${hue} 22%, transparent)`, color: `color-mix(in srgb, ${hue} 75%, var(--fg-strong))` });
  if (kind === "own" && f.own) return <span style={{ ...box, background: "color-mix(in srgb, var(--fg) 6%, transparent)" }}><img src={f.own} alt="" style={{ width: size - 6, height: size - 6, objectFit: "contain" }} /></span>;
  if (kind === "pick") {
    if (f.emoji && f.name !== "KIDE") return <span style={{ ...box, background: "color-mix(in srgb, var(--fg) 6%, transparent)", fontSize: size - 9 }}>{f.emoji}</span>;
    return <span style={tint(hueOf(f.name))}>{f.glyph}</span>;
  }
  return <span style={tint(hueOf(f.name))}>{f.name[0].toUpperCase()}</span>;
}

function Picker({ kind, caption, note }: { kind: Kind; caption: string; note: string }) {
  return (
    <figure style={{ margin: 0, width: 248, display: "grid", gap: 10, alignContent: "start" }}>
      <figcaption style={{ fontSize: 12, color: "var(--fg-dim)", lineHeight: 1.45 }}><strong style={{ color: "var(--fg-strong)", fontWeight: 400, fontSize: 13 }}>{caption}</strong><br />{note}</figcaption>
      <div className="klide-focus-rail" style={{ width: 248, padding: 8, borderRadius: 12, animation: "none" }}>
        <div className="klide-rail-folder-wrap">
          <button type="button" className="klide-rail-folder" aria-expanded="true">
            <Mark f={FOLDERS[0]} kind={kind} size={22} />
            <span className="klide-rail-folder-name">KIDE</span>
            <SwitcherIcon size={12} />
          </button>
          <div className="klide-rail-folder-menu" style={{ position: "relative", top: 6 }}>
            <div className="klide-rail-folder-list">
              {FOLDERS.map((f, i) => (
                <button key={f.name} type="button" className="klide-rail-folder-row" aria-checked={i === 0} role="menuitemradio">
                  <Mark f={f} kind={kind} size={20} />
                  <span className="klide-rail-folder-text">
                    <span className="klide-rail-folder-row-name">{f.name}</span>
                    {f.waiting ? <span className="klide-rail-folder-detail" data-waiting="true"><NeedsYouIcon size={11} /> 1 needs you</span> : <span className="klide-rail-folder-detail">{f.path}</span>}
                  </span>
                  {i === 0 ? <CheckIcon size={13} /> : null}
                </button>
              ))}
            </div>
            <div className="klide-rail-folder-actions">
              <button type="button" className="klide-rail-folder-action">Open folder…</button>
              <button type="button" className="klide-rail-folder-action">Clone…</button>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", gap: 28, padding: 28, flexWrap: "wrap", fontFamily: "var(--font-ui)" }}>
    <Picker kind="none" caption="D. No mark" note="Just names. The card says which folder; the menu reads like a list of places, the check marks where you are." />
    <Picker kind="folder" caption="E. One folder glyph" note="The same quiet folder line for every row — says what the card is, never pretends to be a logo." />
    <Picker kind="tint" caption="A. Tinted initial" note="Each folder gets its own quiet hue from its name. Zero setup, always tells folders apart — but klide-* still share a K." />
    <Picker kind="own" caption="B. Its own icon" note="Klide finds the project's icon (app icon, favicon, logo) and uses it; the rest fall back to A. KIDE and Portfolio found one." />
    <Picker kind="pick" caption="C. You pick" note="Right-click a folder → Change icon: a glyph, an emoji or an image. Unset folders fall back to B, then A." />
  </div>,
);
