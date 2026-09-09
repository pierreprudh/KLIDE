import pdfLogo from "./assets/document-apps/pdf.webp";
import excelLogo from "./assets/document-apps/excel.webp";
import powerpointLogo from "./assets/document-apps/powerpoint.webp";
import wordLogo from "./assets/document-apps/word.webp";

/** The application a document belongs to, by extension. Markdown is in the
 *  table so the same lookup answers "does this kind of file have a mark", but
 *  its mark is drawn (`DocumentAppMark`), not a picture: it has to take the
 *  text colour to read on both themes. */
type DocumentApp = "pdf" | "excel" | "powerpoint" | "word" | "markdown";

const APPS: Record<string, DocumentApp> = {
  pdf: "pdf",
  xls: "excel", xlsx: "excel", xlsm: "excel", xlsb: "excel",
  ppt: "powerpoint", pptx: "powerpoint", pptm: "powerpoint",
  pps: "powerpoint", ppsx: "powerpoint",
  doc: "word", docx: "word", docm: "word",
  md: "markdown", markdown: "markdown", mdx: "markdown",
};

const APP_LOGOS: Record<Exclude<DocumentApp, "markdown">, string> = {
  pdf: pdfLogo,
  excel: excelLogo,
  powerpoint: powerpointLogo,
  word: wordLogo,
};

export function documentApp(path: string): DocumentApp | undefined {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? APPS[name.slice(dot + 1).toLowerCase()] : undefined;
}

/** The picture of the application that owns `path`, for an `<img>`. Markdown
 *  has none — Klide reads it itself, so there is no app to hand it to. */
export function documentAppLogo(path: string): string | undefined {
  const app = documentApp(path);
  return app && app !== "markdown" ? APP_LOGOS[app] : undefined;
}

/** The Markdown mark — the "M↓" in its rounded frame — in the text colour, so
 *  it sits beside the app logos on either theme. Hand-drawn, like every brand
 *  mark: it is not part of the Phosphor vocabulary. */
function MarkdownMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="M5.5 15.5v-7l3 3.5 3-3.5v7" />
      <path d="M17 8.5v7M14.8 13.3l2.2 2.2 2.2-2.2" />
    </svg>
  );
}

/** The mark of the application that owns `path`, at `size` px — a picture for
 *  the Office apps and PDF, a drawn glyph for Markdown — or nothing when the
 *  kind of file has none. */
export function DocumentAppMark({ path, size = 20, className }: { path: string; size?: number; className?: string }) {
  const app = documentApp(path);
  if (!app) return null;
  if (app === "markdown") {
    return <span className={className} style={{ display: "inline-grid", placeItems: "center", width: size, height: size, flexShrink: 0 }}><MarkdownMark size={size} /></span>;
  }
  return <img className={className} src={APP_LOGOS[app]} alt="" aria-hidden="true"
    style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }} />;
}

/** One mark per kind of document, in the order the documents appear, so a
 *  run that made a deck, two sheets and a memo shows PowerPoint, Excel, Word —
 *  and not the same square three times. Documents of a kind with no mark are
 *  left out; the caller says how many there were in words. */
export function documentAppMarks(paths: string[], limit = 3): string[] {
  const seen = new Set<DocumentApp>();
  const marks: string[] = [];
  for (const path of paths) {
    const app = documentApp(path);
    if (!app || seen.has(app)) continue;
    seen.add(app);
    marks.push(path);
    if (marks.length === limit) break;
  }
  return marks;
}
