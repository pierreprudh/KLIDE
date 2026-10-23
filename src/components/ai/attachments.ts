// Staging dropped/pasted files as turn attachments — the one place Klide
// decides what a photo or a document becomes on its way into a conversation.
//
// Two kinds land here, and they travel differently:
//
//  · a **photo** becomes a data-URI attachment the harness hands to a
//    vision-capable model, and the chat renders it as an image;
//  · a **document** becomes a text attachment — the same `{ path, content }`
//    shape an `@mention` produces — so it works on every model, blind or not.
//
// A **PDF** is a document whose text has to be read out first: Rust extracts
// it page by page (`pdf_text.rs`) and it stages as text like any other. Its
// layout and pictures don't come along, and a scan with no text layer is
// refused by name.
//
// Anything else (a zip, a binary) is refused by name rather than attached as
// garbage: folding raw bytes into the prompt would read as support that isn't
// there.
//
// Kept free of React, Tauri and the toast bus so both composers — the AI
// panel's and Focus's start stage — share one set of rules, and the rules
// stay testable. The PDF reader is handed in for the same reason.
import type { AgentAttachment as Attachment } from "../../agent/types";
import { errMessage } from "../../errors";

/** Per-image ceiling. The harness clamps to the same number at run ingress
 *  (`run_core::clamp_attachments`); this one exists so a composer can refuse a
 *  photo by name instead of letting it disappear on the way out. */
export const MAX_IMAGE_BYTES = 6_000_000;
/** Total image bytes one turn may carry, across every staged photo. The
 *  per-image cap alone lets 12 photos add up to a 70 MB request body (and a
 *  transcript line to match), which no provider accepts. */
export const MAX_TOTAL_IMAGE_BYTES = 12_000_000;
/** Per-document ceiling. Read whole, then truncated to MAX_DOC_CHARS. */
export const MAX_DOC_BYTES = 2_000_000;
/** Same text budget an `@mention` attachment gets. */
export const MAX_DOC_CHARS = 12_000;
/** Per-PDF ceiling, before extraction — a PDF's pictures weigh far more than
 *  its words. Rust holds the same line (`pdf_text::MAX_PDF_BYTES`). */
export const MAX_PDF_BYTES = 25_000_000;
/** A PDF's text budget. Larger than a text document's because a PDF is
 *  usually the whole point of the turn — a paper, a spec, an invoice — and
 *  about ten pages of prose fit, roughly 10k tokens. Cut at a page boundary. */
export const MAX_PDF_CHARS = 40_000;
/** How many files one drop/paste may stage at once. */
export const MAX_FILES_PER_DROP = 8;
/** How many attachments may sit staged on a composer. */
export const MAX_STAGED = 12;

/** The image formats every wire Klide speaks accepts — the same set
 *  `forwardable_image_media_type` enforces in `adapters.rs`. A photo outside
 *  it is refused at staging rather than dropped in silence on the way out
 *  (the harness clamp refuses it again, one layer later):
 *  HEIC (what an iPhone photo dropped from Finder actually is), TIFF, BMP,
 *  AVIF and ICO all render fine in the webview, so a staged thumbnail would
 *  otherwise promise a picture the model never receives. */
const FORWARDABLE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/** Text-ish MIME types that carry no `text/` prefix. */
const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/sql",
  "image/svg+xml", // markup a blind model can still read
]);

/** Extensions we treat as documents when the browser gives us no MIME at all
 *  (a common case for source files dragged from an editor or Finder). */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "org", "log",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "csv", "tsv", "xml", "html", "htm", "css", "scss", "sass",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "rs", "go", "py", "rb", "php",
  "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "gql", "lua", "vim",
  "dockerfile", "gitignore", "diff", "patch", "srt", "vtt",
]);

/** What an OS file picker should offer, derived from the same two sets
 *  `classifyFile` decides with — so the dialog can't hand back a file the
 *  composer is only going to refuse by name. A filter, not a guarantee: a
 *  picker set to "All Files" still routes through `stageFiles`. */
export const ATTACH_ACCEPT = [
  ...FORWARDABLE_IMAGE_MIMES,
  "text/*",
  ...[...TEXT_EXTENSIONS].map((ext) => `.${ext}`),
  "application/pdf",
  ".pdf",
].join(",");

/** The file kinds a composer can stage. `"other"` is refused. */
export type AttachmentKind = "photo" | "document" | "pdf" | "other";

/** Reads a PDF's text out, one string per page, and keeps the original —
 *  `extractPdfText` in `src/ipc/pdf.ts`. Rejects with a sentence a person can
 *  read. */
export type PdfReader = (
  bytes: ArrayBuffer,
  name: string,
) => Promise<{ pages: string[]; stored?: string | null }>;

/** What a composer should say out loud after a staging attempt. Returned
 *  rather than raised so the caller owns the notification surface. */
export type StagingNotice = { text: string; tone: "warn" | "info" };

export type StagingResult = { attachments: Attachment[]; notices: StagingNotice[] };

/** Just the fields staging needs — so a test can hand over a plain object and
 *  a browser can hand over a real `File`. */
export type StageableFile = {
  name: string;
  type: string;
  size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  // A dotfile (".gitignore") is all extension; a bare "Dockerfile" is its own.
  const dot = base.lastIndexOf(".");
  // A dotfile has no extension of its own — its name *is* the kind.
  if (dot <= 0) return base.replace(/^\./, "").toLowerCase();
  return base.slice(dot + 1).toLowerCase();
}

export function classifyFile(file: Pick<StageableFile, "name" | "type">): AttachmentKind {
  if (FORWARDABLE_IMAGE_MIMES.has(file.type)) return "photo";
  if (file.type === "application/pdf" || (!file.type && extensionOf(file.name) === "pdf")) return "pdf";
  if (file.type.startsWith("text/") || TEXT_MIMES.has(file.type)) return "document";
  if (!file.type && TEXT_EXTENSIONS.has(extensionOf(file.name))) return "document";
  return "other";
}

/** Roughly how many image bytes a staged set is holding. Base64 carries 3
 *  bytes in every 4 characters, which is close enough for a budget check. */
export function stagedImageBytes(attachments: readonly Attachment[]): number {
  return attachments.reduce(
    (sum, a) => sum + (a.dataUri ? Math.floor((a.dataUri.length * 3) / 4) : 0),
    0,
  );
}

/** True when this attachment is a photo rather than a document. The `dataUri`
 *  field is what the harness and the chat both key on. */
export function isPhotoAttachment(a: Attachment): boolean {
  return typeof a.dataUri === "string" && a.dataUri.length > 0;
}

/** The drawing behind each staged SVG, kept off the attachment itself: the
 *  wire gets the (possibly truncated) markup a blind model can read, the tray
 *  gets the whole picture. Keyed by the staged object, so it lives exactly as
 *  long as the tray holds it. */
const markupPreviews = new WeakMap<Attachment, string>();

/** A picture of a document that is one — an SVG travels as markup, but the
 *  person staging it should still see the drawing, not "2 lines". Rendered
 *  through `<img>`, where an SVG's scripts and external loads never run. Null
 *  for every other document. */
export function markupPreviewUri(a: Attachment): string | null {
  return markupPreviews.get(a) ?? null;
}

function base64Of(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  // Chunked so a multi-megabyte photo doesn't blow the argument limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function humanSize(bytes: number): string {
  return bytes >= 1_000_000
    ? `${Math.round(bytes / 100_000) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** What a staged attachment weighs, in the words the tray shows under its
 *  name: a photo by its decoded bytes, a document by the UTF-8 text it will
 *  send. Under a kilobyte it says bytes, so a two-line note isn't "1 KB". */
export function attachmentSize(a: Attachment): string {
  const uri = a.dataUri ?? "";
  const bytes = uri
    ? Math.floor(((uri.length - uri.indexOf(",") - 1) * 3) / 4)
    : new TextEncoder().encode(a.content).length;
  return bytes < 1000 ? `${bytes} B` : humanSize(bytes);
}

/** A PDF's pages as one text attachment's content, each under a `[page N]`
 *  line so the model can say where something is. Past `budget`, whole pages
 *  are dropped and the cut is said out loud; a first page longer than the
 *  whole budget is sliced, since some text beats none. */
export function pdfContent(pages: readonly string[], budget = MAX_PDF_CHARS): string {
  let out = "";
  let kept = 0;
  for (const [i, page] of pages.entries()) {
    const block = `${i === 0 ? "" : "\n\n"}[page ${i + 1}]\n${page}`;
    if (out.length + block.length > budget) {
      if (kept === 0) {
        out = block.slice(0, budget);
        kept = 1;
      }
      break;
    }
    out += block;
    kept += 1;
  }
  if (kept < pages.length) {
    out += `\n…(truncated after page ${kept} of ${pages.length})`;
  }
  return out;
}

/**
 * Turn dropped/pasted files into staged attachments.
 *
 * `allowPhotos` is the vision gate: when the chosen model is blind, a photo is
 * refused by name instead of being sent somewhere it can't be seen. Documents
 * are never gated — text reaches every model. `readPdf` is how a PDF's text
 * gets read; without one, a PDF is refused like any kind Klide can't read.
 */
export async function stageFiles(
  files: readonly StageableFile[],
  opts: { allowPhotos: boolean; alreadyStaged?: number; alreadyImageBytes?: number; readPdf?: PdfReader },
): Promise<StagingResult> {
  const notices: StagingNotice[] = [];
  const room = Math.max(0, MAX_STAGED - (opts.alreadyStaged ?? 0));
  if (files.length > 0 && room === 0) {
    return { attachments: [], notices: [{ text: `Already holding ${MAX_STAGED} attachments — send or remove some first.`, tone: "warn" }] };
  }
  const considered = files.slice(0, MAX_FILES_PER_DROP);
  if (files.length > considered.length) {
    notices.push({ text: `Taking the first ${MAX_FILES_PER_DROP} files — the rest were skipped.`, tone: "info" });
  }

  const staged: Attachment[] = [];
  let imageBytes = opts.alreadyImageBytes ?? 0;
  for (const file of considered) {
    const name = file.name || "attachment";
    const kind = classifyFile(file);
    if (kind === "other" || (kind === "pdf" && !opts.readPdf)) {
      notices.push({
        text: file.type.startsWith("image/")
          ? `${name} isn't a format the models accept — convert it to PNG, JPEG, GIF or WebP first.`
          : `Klide can't read ${name} yet — attach an image or a text document.`,
        tone: "warn",
      });
      continue;
    }
    if (kind === "photo" && !opts.allowPhotos) {
      notices.push({ text: `This model can't see images — ${name} wasn't attached.`, tone: "warn" });
      continue;
    }
    const limit = kind === "photo" ? MAX_IMAGE_BYTES : kind === "pdf" ? MAX_PDF_BYTES : MAX_DOC_BYTES;
    if (file.size > limit) {
      notices.push({ text: `${name} is too large to attach (max ${humanSize(limit)}).`, tone: "warn" });
      continue;
    }
    if (kind === "photo" && imageBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
      notices.push({
        text: `${name} doesn't fit — one turn carries at most ${humanSize(MAX_TOTAL_IMAGE_BYTES)} of images.`,
        tone: "warn",
      });
      continue;
    }
    try {
      if (kind === "photo") {
        const mime = file.type || "image/png";
        const dataUri = `data:${mime};base64,${base64Of(await file.arrayBuffer())}`;
        staged.push({ path: name, content: "", mime, dataUri });
        imageBytes += file.size;
      } else if (kind === "pdf") {
        let read: Awaited<ReturnType<PdfReader>>;
        try {
          read = await opts.readPdf!(await file.arrayBuffer(), name);
        } catch (err) {
          // The reader's refusal is already a sentence (a scan, a password).
          notices.push({ text: `${name}: ${errMessage(err)}`, tone: "warn" });
          continue;
        }
        const doc: Attachment = { path: name, content: pdfContent(read.pages) };
        if (read.stored) doc.stored = read.stored;
        staged.push(doc);
      } else {
        const full = await file.text();
        let content = full;
        if (content.length > MAX_DOC_CHARS) content = content.slice(0, MAX_DOC_CHARS) + "\n…(truncated)";
        // `mime` is the image lane's field by contract (see AgentAttachment) —
        // a document is identified by carrying no dataUri, so leave it unset.
        const doc = { path: name, content };
        // Preview from the untruncated markup — a cut-off SVG draws nothing.
        if (extensionOf(name) === "svg" && /<svg[\s>]/i.test(full)) {
          markupPreviews.set(doc, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(full)}`);
        }
        staged.push(doc);
      }
    } catch {
      notices.push({ text: `Couldn't read ${name}.`, tone: "warn" });
    }
  }

  if (staged.length > room) {
    notices.push({ text: `Only ${room} more attachment${room === 1 ? "" : "s"} fit on this turn.`, tone: "info" });
  }
  return { attachments: staged.slice(0, room), notices };
}
