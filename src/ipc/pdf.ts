// Typed frontend Adapter for `pdf_extract_text` — the text inside a PDF
// dropped on a composer, one string per page (`src-tauri/src/pdf_text.rs`).

import { invoke } from "@tauri-apps/api/core";

/** Read a PDF's text out, page by page. The bytes travel as the raw invoke
 *  body. Rejects with a sentence a person can read: a scan with no text
 *  layer, a password, a file that isn't a PDF. */
export function extractPdfText(bytes: ArrayBuffer): Promise<string[]> {
  return invoke<string[]>("pdf_extract_text", new Uint8Array(bytes));
}
