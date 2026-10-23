// Typed frontend Adapter for the dropped-PDF commands: `pdf_extract_text`
// (`src-tauri/src/pdf_text.rs`) and `attachments_root`, the folder the
// originals are kept in (`src-tauri/src/attachment_store.rs`).

import { invoke } from "@tauri-apps/api/core";

/** A dropped PDF's text, one string per page, and where the original was
 *  kept — null when keeping it failed, which costs only the way back to it. */
export type PdfText = { pages: string[]; stored: string | null };

/** Read a PDF's text out, page by page, and keep the file. The bytes travel
 *  as the raw invoke body and the name as a header. Rejects with a sentence a
 *  person can read: a scan with no text layer, a password, a file that isn't
 *  a PDF. */
export function extractPdfText(bytes: ArrayBuffer, name: string): Promise<PdfText> {
  return invoke<PdfText>("pdf_extract_text", new Uint8Array(bytes), {
    headers: { "x-klide-name": encodeURIComponent(name) },
  });
}

/** The folder kept PDFs live in — the root a stored attachment's path is
 *  relative to. */
export function attachmentsRoot(): Promise<string> {
  return invoke<string>("attachments_root");
}
