// The folded docked-editor spine — a slim typographic dock of the open
// documents. Each file is a mono extension monogram (TS, RS …) rather
// than a pictographic icon set: one accent, monochrome type, hairlines —
// the Klide way. Two exceptions earn a drawn glyph (see fileMarks):
// markdown gets the M↓ mark, agent context files (CLAUDE.md / AGENTS.md)
// get the accent-tinted sparkle. Clicking a file unfolds the pane on that
// document.
import { FileMark, fileMarkKind } from "./fileMarks";

type SpineTab = { path: string; dirty: boolean };

type Props = {
  tabs: SpineTab[];
  activeIdx: number;
  /** Unfold and land on this tab. */
  onSelectFile: (index: number) => void;
  onUnfold: () => void;
};

/** How many file monograms the spine shows before folding the rest into a
 *  "+N" tail. Enough for real sessions without turning into a scrollbar. */
const MAX_SPINE_FILES = 9;

function monogram(path: string): string {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const known: Record<string, string> = {
    ts: "TS",
    tsx: "TS",
    js: "JS",
    jsx: "JS",
    rs: "RS",
    css: "CS",
    json: "{}",
    toml: "TL",
    yml: "YM",
    yaml: "YM",
    html: "HT",
    py: "PY",
    sh: "SH",
    svg: "SV",
    lock: "LK",
  };
  if (known[ext]) return known[ext];
  if (ext) return ext.slice(0, 2).toUpperCase();
  return "··";
}

export function EditorDockSpine({ tabs, activeIdx, onSelectFile, onUnfold }: Props) {
  const shown = tabs.slice(0, MAX_SPINE_FILES);
  const hidden = tabs.length - shown.length;

  return (
    <div className="editor-dock-spine" role="toolbar" aria-label="Folded editor documents">
      <button
        type="button"
        className="editor-dock-spine-btn klide-enter-rise"
        title="Unfold editor"
        aria-label="Unfold editor"
        onClick={onUnfold}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6l-6 6 6 6" />
          <path d="M11 6l-6 6 6 6" />
        </svg>
      </button>
      <span className="editor-dock-spine-divider" aria-hidden="true" />
      {shown.map((tab, i) => {
        const name = tab.path.split("/").pop() ?? tab.path;
        const kind = fileMarkKind(tab.path);
        return (
          <button
            key={tab.path}
            type="button"
            className="editor-dock-spine-btn klide-enter-rise"
            style={{ ["--enter-delay" as string]: `${40 + i * 30}ms` }}
            data-active={i === activeIdx ? "true" : undefined}
            data-kind={kind ?? undefined}
            title={`Open ${name}`}
            aria-label={`Open ${name}`}
            onClick={() => onSelectFile(i)}
          >
            {kind ? (
              <FileMark kind={kind} />
            ) : (
              <span className="editor-dock-spine-monogram">{monogram(tab.path)}</span>
            )}
            {tab.dirty && <span className="editor-dock-spine-dot" aria-label="Unsaved changes" />}
          </button>
        );
      })}
      {hidden > 0 && (
        <button
          type="button"
          className="editor-dock-spine-btn klide-enter-rise"
          style={{ ["--enter-delay" as string]: `${40 + shown.length * 30}ms` }}
          title={`${hidden} more file${hidden === 1 ? "" : "s"} — unfold to see all`}
          aria-label={`${hidden} more files — unfold`}
          onClick={onUnfold}
        >
          <span className="editor-dock-spine-monogram">+{hidden}</span>
        </button>
      )}
    </div>
  );
}
