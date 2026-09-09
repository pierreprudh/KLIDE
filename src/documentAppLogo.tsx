import pdfLogo from "./assets/document-apps/pdf.webp";
import excelLogo from "./assets/document-apps/excel.webp";
import powerpointLogo from "./assets/document-apps/powerpoint.webp";
import wordLogo from "./assets/document-apps/word.webp";

/** The application a document belongs to, by extension. Markdown and HTML are
 *  in the table so the same lookup answers "does this kind of file have a
 *  mark", but their marks are drawn (`DocumentAppMark`), not pictures: they
 *  have to take the text colour to read on both themes. */
type DocumentApp = "pdf" | "excel" | "powerpoint" | "word" | "markdown" | "html";

const APPS: Record<string, DocumentApp> = {
  pdf: "pdf",
  xls: "excel", xlsx: "excel", xlsm: "excel", xlsb: "excel",
  ppt: "powerpoint", pptx: "powerpoint", pptm: "powerpoint",
  pps: "powerpoint", ppsx: "powerpoint",
  doc: "word", docx: "word", docm: "word",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  html: "html", htm: "html",
};

const DRAWN = new Set<DocumentApp>(["markdown", "html"]);

const APP_LOGOS: Record<Exclude<DocumentApp, "markdown" | "html">, string> = {
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
 *  and HTML have none — Klide reads them itself, so there is no app to hand
 *  them to. */
export function documentAppLogo(path: string): string | undefined {
  const app = documentApp(path);
  return app && !DRAWN.has(app) ? APP_LOGOS[app as keyof typeof APP_LOGOS] : undefined;
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

/** The HTML mark — angle brackets in a page — in the text colour, for a page
 *  a run wrote. Drawn for the same reason the Markdown one is. */
function HtmlMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4h7l5 5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5.5A1.5 1.5 0 0 1 6.5 4Z" />
      <path d="M14 4v5h5" />
      <path d="M10 12.5 8 14.5l2 2M14 12.5l2 2-2 2" />
    </svg>
  );
}

/** The mark of the application that owns `path`, at `size` px — a picture for
 *  the Office apps and PDF, a drawn glyph for Markdown and HTML — or nothing
 *  when the kind of file has none. */
export function DocumentAppMark({ path, size = 20, className }: { path: string; size?: number; className?: string }) {
  const app = documentApp(path);
  if (!app) return null;
  if (DRAWN.has(app)) {
    return (
      <span className={className} style={{ display: "inline-grid", placeItems: "center", width: size, height: size, flexShrink: 0 }}>
        {app === "markdown" ? <MarkdownMark size={size} /> : <HtmlMark size={size} />}
      </span>
    );
  }
  return <img className={className} src={APP_LOGOS[app as keyof typeof APP_LOGOS]} alt="" aria-hidden="true"
    style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }} />;
}

/** The documents that stand for the set: the first `limit` with a mark, in the
 *  order the run made them. They draw as a stack — one disc, two overlapping,
 *  three overlapping — and the caller says in words how many more there are.
 *  Per document, not per kind: three decks are three discs, the way three
 *  people are three faces. */
export function stackedDocumentMarks(paths: string[], limit = 3): string[] {
  return paths.filter((path) => documentApp(path) !== undefined).slice(0, limit);
}
