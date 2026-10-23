//! The text inside a PDF someone dropped on a composer.
//!
//! A dropped PDF travels the document lane, not a lane of its own: its text
//! is read out here, page by page, and the composer stages it as the same
//! `{ path, content }` attachment an `@mention` produces — so it reaches every
//! model, local and blind ones included. Layout, tables drawn as lines and
//! pictures don't survive; that is the honest ceiling of text extraction, and
//! a native document block for the wires that take one is a later upgrade
//! that keeps this as its fallback.
//!
//! A scanned PDF has no text layer to read. Rather than stage an empty
//! attachment that looks like support, it is refused here by name.
//!
//! The bytes come from the webview (a dropped `File` has no path Klide may
//! trust), so nothing here touches the filesystem.

/// The most a dropped PDF may weigh. Mirrors `MAX_PDF_BYTES` in
/// `src/components/ai/attachments.ts`; this one binds any other caller.
pub const MAX_PDF_BYTES: usize = 25_000_000;

/// Below this many visible characters across the whole document, there is no
/// text layer worth sending — the PDF is a scan, or pictures of words.
const MIN_VISIBLE_CHARS: usize = 16;

/// Read each page's text out of a PDF held in memory.
///
/// `pdf-extract` panics on some malformed fonts rather than returning an
/// error, so the parse runs behind `catch_unwind`: one odd file must not take
/// the command's worker down with it.
pub fn extract_pages(bytes: &[u8]) -> Result<Vec<String>, String> {
    if bytes.len() > MAX_PDF_BYTES {
        return Err(format!(
            "This PDF is too large to read (max {} MB).",
            MAX_PDF_BYTES / 1_000_000
        ));
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err("This file isn't a PDF.".to_string());
    }
    let parsed = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes))
        .map_err(|_| "Klide couldn't read this PDF.".to_string())?;
    let pages = parsed.map_err(|e| match e {
        // An empty password opens the many PDFs encrypted only to restrict
        // printing; this is the one that actually wants a password.
        pdf_extract::OutputError::PdfError(pdf_extract::Error::Decryption(_)) => {
            "This PDF is password-protected.".to_string()
        }
        _ => "Klide couldn't read this PDF.".to_string(),
    })?;
    let pages: Vec<String> = pages.iter().map(|p| tidy(p)).collect();
    let visible: usize = pages
        .iter()
        .map(|p| p.chars().filter(|c| !c.is_whitespace()).count())
        .sum();
    if visible < MIN_VISIBLE_CHARS {
        return Err("This PDF has no text to read — it looks like a scan.".to_string());
    }
    Ok(pages)
}

/// Extracted text keeps the PDF's line geometry: trailing spaces, form feeds
/// and long runs of blank lines where whitespace sat on the page. Fold those
/// down so the model's budget is spent on words.
fn tidy(page: &str) -> String {
    let mut out = String::with_capacity(page.len());
    let mut blank_run = 0;
    for line in page.lines() {
        let line = line.trim_end_matches(|c: char| c.is_whitespace() || c == '\u{c}');
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-page PDF with `text` drawn in Helvetica, offsets computed so
    /// the cross-reference table is valid.
    fn pdf_with_text(text: &str) -> Vec<u8> {
        let stream = if text.is_empty() {
            String::new()
        } else {
            format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET")
        };
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for off in offsets {
            out.extend(format!("{off:010} 00000 n \n").as_bytes());
        }
        out.extend(
            format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1)
                .as_bytes(),
        );
        out
    }

    #[test]
    fn reads_the_text_of_each_page() {
        let pages = extract_pages(&pdf_with_text("Quarterly revenue grew twelve percent")).unwrap();
        assert_eq!(pages.len(), 1);
        assert!(pages[0].contains("Quarterly revenue grew twelve percent"), "{pages:?}");
    }

    #[test]
    fn a_page_with_no_text_is_refused_as_a_scan() {
        let err = extract_pages(&pdf_with_text("")).unwrap_err();
        assert!(err.contains("scan"), "{err}");
    }

    #[test]
    fn bytes_that_are_not_a_pdf_are_refused_before_parsing() {
        assert_eq!(extract_pages(b"hello").unwrap_err(), "This file isn't a PDF.");
    }

    #[test]
    fn a_truncated_pdf_is_an_error_not_a_panic() {
        let mut bytes = pdf_with_text("Some words on a page");
        bytes.truncate(bytes.len() / 2);
        assert!(extract_pages(&bytes).is_err());
    }

    #[test]
    fn an_oversized_pdf_is_refused_before_parsing() {
        let mut bytes = b"%PDF-1.4\n".to_vec();
        bytes.resize(MAX_PDF_BYTES + 1, b' ');
        assert!(extract_pages(&bytes).unwrap_err().contains("too large"));
    }

    #[test]
    fn tidy_folds_blank_runs_and_trailing_space() {
        assert_eq!(tidy("one   \n\n\n\n two\u{c}\n\n"), "one\n\n two");
    }
}
