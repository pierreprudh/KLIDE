import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompletionCard, ResultEvidence } from "./CompletionCard";
import type { RunCompletion } from "../../agent/completion";
import { artifactActionLabel } from "../../artifacts";

const completion: RunCompletion = { runId: "r", completedAt: 1, outcome: "Updated settings.", files: [], commands: [], warnings: [] };
const render = (value: RunCompletion) => renderToStaticMarkup(<CompletionCard completion={value} onReview={() => {}} onRequestChanges={() => {}} />);
const renderIsland = (value: RunCompletion, compact = false) => renderToStaticMarkup(
  <CompletionCard variant="island" compact={compact} completion={value} onReview={() => {}} onRequestChanges={() => {}} />,
);
// The sheet only exists while open, and there is no DOM here to click in — so
// the evidence both surfaces share is asserted directly.
const renderEvidence = (value: RunCompletion, onOpenArtifact?: (path: string) => void) => renderToStaticMarkup(
  <ResultEvidence completion={value} onReview={() => {}} onOpenArtifact={onOpenArtifact}
    onRequestChanges={() => {}} onDone={() => {}} />,
);
const DECK = { path: "decks/Q3 review.pptx", bytes: 40_960, created: true };

describe("CompletionCard", () => {
  it("renders nothing for empty evidence, including older saved completions", () => {
    expect(render(completion)).toBe("");
    expect(renderIsland(completion)).toBe("");
  });
  it("does not interrupt successful command-only work", () => {
    expect(render({ ...completion, commands: [{ id: "c", label: "git status", status: "passed" }] })).toBe("");
  });
  it("offers review for changed files but keeps the evidence out of the page until asked", () => {
    const html = render({ ...completion, files: ["src/app.tsx"], commands: [{ id: "c", label: "npm test", status: "failed" }] });
    expect(html).toContain("Review result");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(/<dialog/);
    expect(html).not.toContain("Updated settings.");
    expect(html).not.toContain("Command results");
    expect(html).not.toContain("Review changes");
  });
  it("never presents a stopped attempt as a result", () => {
    const stopped = { ...completion, files: ["src/app.tsx"], stopped: true, warnings: ["The run stopped before finishing — this work is partial."] };
    expect(render(stopped)).toContain("Review partial work");
    expect(render(stopped)).not.toContain("Review result");
    expect(renderIsland(stopped)).toContain("Partial work");
    expect(renderEvidence(stopped)).toContain("stopped before finishing");
  });
});

describe("the island card", () => {
  const withFiles = { ...completion, files: ["src/app.tsx", "src/time.ts"] };

  it("waits in the column as a header, with no sheet to open", () => {
    const html = renderIsland(withFiles);
    expect(html).toContain("klide-result-island");
    expect(html).not.toContain("klide-result-scrim");
    expect(html).not.toMatch(/<dialog/);
    expect(html).toContain("Result");
    expect(html).toContain("2 files");
    // Closed, the card is only its header — the evidence mounts on open, so
    // the column carries one row until the reader asks for the rest.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("klide-result-island-panel");
    expect(html).not.toContain("Review changes");
  });
  // "On sidepanel open, each should be full width and when closed only icons."
  // Open, the entry is a window with its words and its own dismiss.
  // The files a run produced are its output, not a notice about it: the island
  // offers no way to close them, only the column's own fold.
  it("offers no dismiss of its own", () => {
    expect(renderIsland(withFiles)).not.toContain("klide-result-island-close");
  });

  it("is a full-width window while the column is open", () => {
    const html = renderToStaticMarkup(
      <CompletionCard variant="island" completion={withFiles}
        onReview={() => {}} onRequestChanges={() => {}} />,
    );
    expect(html).toContain("klide-result-island-title");
    expect(html).toContain("2 files");
    expect(html).not.toContain("klide-result-mark");
  });

  // "No full width compacted line option when opened": however narrow the
  // column gets, an open entry keeps its words. A row that filled the width
  // with a centred icon was neither a window nor a mark.
  it("keeps its words when the column is open and narrow", () => {
    const html = renderToStaticMarkup(
      <CompletionCard variant="island" compact completion={withFiles}
        onReview={() => {}} onRequestChanges={() => {}} />,
    );
    expect(html).toContain("klide-result-island-title");
    expect(html).toContain("2 files");
    expect(html).not.toContain('data-compact="1"');
  });

  // Folded, it is the plan's pill: mark, count, nothing else — and its job is
  // to open the column, not its own evidence.
  it("folds to a mark when the column is closed", () => {
    const html = renderToStaticMarkup(
      <CompletionCard variant="island" folded completion={withFiles}
        onReview={() => {}} onRequestChanges={() => {}} onUnfold={() => {}} />,
    );
    expect(html).toContain("klide-result-mark");
    expect(html).toContain('data-folded="1"');
    expect(html.split("<svg").length - 1).toBe(1);
    expect(html).toContain("Open the side panel");
    expect(html).not.toContain("klide-result-island-title");
    expect(html).not.toContain("klide-result-island-close");
  });
  it("offers no dismissal when the host has nowhere to put the state", () => {
    expect(renderIsland(withFiles)).not.toContain("klide-result-island-close");
  });
});

describe("documents a command produced", () => {
  it("lists them with their size, apart from the changes", () => {
    const html = renderEvidence({ ...completion, artifacts: [DECK] }, () => {});
    expect(html).toContain("Documents");
    // A fold like the others, open to start: the documents are what the run
    // made, and the reader can put them away.
    expect(html).toMatch(/<details class="klide-result-fold klide-result-documents" open/);
    expect(html).toContain("Q3 review.pptx");
    expect(html).toContain("41 KB");
    // No diff and no checkpoint behind a produced file: it must not arrive
    // where the reviewable edits are.
    expect(html).not.toContain("Changes");
    expect(html).not.toContain("Review changes");
  });

  // A document opens in two steps: the panel first, full width second. So the
  // row's resting promise is the preview, and the destination label — which of
  // the two things the second click does — belongs to the state after it.
  // Opening the result is the first of the two steps: every document it
  // produced shows its picture in the panel, each one beside the mark of the
  // app that owns it. The row is the second step and opens the document.
  it("shows every document with its app's mark, and opens on the row", () => {
    const html = renderEvidence({ ...completion, artifacts: [DECK, { path: "q3/summary.docx", bytes: 12_000, created: true }] }, () => {});
    expect(html).toContain("Open Q3 review.pptx in its app");
    expect(html).toContain("Open summary.docx in its app");
    expect(html).toContain("klide-result-app-logo");
    expect(html).not.toContain("in the panel");
    // The evidence counts them in its own heading; the island header carries
    // the same count where the reader sees it before opening anything.
    expect(html).toContain("klide-result-fold-title">Documents<");
    expect(renderIsland({ ...completion, files: ["src/app.tsx"], artifacts: [DECK] })).toContain("1 document");
  });

  it("names the destination the second click reaches", () => {
    expect(artifactActionLabel("decks/Q3 review.pptx")).toBe("Open Q3 review.pptx in its app");
    expect(artifactActionLabel("notes.md")).toBe("Read notes.md");
  });

  it("still lists them when the host offers no way to open one", () => {
    // The footer's own buttons stay; it is the row that stops being one.
    const html = renderEvidence({ ...completion, artifacts: [DECK] });
    expect(html).toContain("Q3 review.pptx");
    expect(html).not.toContain("Open Q3 review.pptx in its app");
    expect(html).not.toContain("↗</span></button>");
  });

  it("earns the card on its own", () => {
    // Nothing edited, no failing command: without the document this run would
    // draw no entry at all.
    expect(render({ ...completion, artifacts: [DECK] })).toContain("Review result");
  });
});

describe("ResultEvidence", () => {
  // Receipts, not headlines: one collapsed stack, dimmed, and it stays dimmed
  // when opened. A failure is the exception that cancels the dimming.
  it("stacks the commands, closed and quiet", () => {
    const html = renderEvidence({
      ...completion,
      commands: [{ id: "c1", label: "npm test", status: "passed" }, { id: "c2", label: "npm run build", status: "passed" }],
    }, () => {});
    expect(html).toContain('class="klide-result-fold klide-result-commands"');
    expect(html).not.toContain('class="klide-result-fold klide-result-commands" open');
    expect(html).not.toContain('data-failed');
    // The count leads on the left as part of the row's name; the disclosure is
    // the chevron, and nothing repeats the number on the right.
    expect(html).toContain('class="klide-result-fold-count">2</span>');
    expect(html).toContain("klide-result-fold-chevron");
    expect(html).toContain("commands</span>");
  });

  it("stops dimming the stack when a command failed", () => {
    const html = renderEvidence({
      ...completion,
      commands: [{ id: "c1", label: "npm test", status: "failed", output: "1 failing" }],
    }, () => {});
    expect(html).toContain('data-failed="1"');
  });

  it("lists changed files with a way into each one, folded until asked", () => {
    const html = renderEvidence({ ...completion, files: ["src/app.tsx", "src/time.ts"] });
    // Closed by default: one row saying how many, and the list behind a click
    // — the same fold the commands use.
    expect(html).toContain("klide-result-changes");
    expect(html).toMatch(/<details class="klide-result-fold klide-result-changes"(?![^>]*\bopen\b)/);
    expect(html).toContain('klide-result-fold-title">Changes<');
    expect(html).not.toContain("2</span><span>changes");
    expect(html).toContain("app.tsx");
    expect(html).toContain("Review changes");
    expect(html).not.toContain("Command results");
  });
  it.each(["failed", "unknown"] as const)("keeps %s command evidence accessible without edits", (status) => {
    const html = renderEvidence({ ...completion, commands: [{ id: "c", label: "npm test", status, output: "<script>bad</script>" }] });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Changed files");
    expect(html).not.toContain("Review changes");
  });
  it("keeps permission warnings accessible", () => {
    expect(renderEvidence({ ...completion, warnings: ["Permission denied"] })).toContain("Permission denied");
  });

  // "I have 2 times the same icons — wire in only one, the document created,
  // using the logos", then the sketch: one disc, two overlapping, three
  // overlapping. The mark is a stack of the documents' app marks, capped at
  // three, and the count says how many more there are.
  it("folds to a stack of the documents' marks, three at most, and counts the rest", () => {
    const html = renderToStaticMarkup(
      <CompletionCard variant="island" folded onUnfold={() => {}} onReview={() => {}} onRequestChanges={() => {}}
        completion={{ ...completion, artifacts: [
          DECK,
          { path: "decks/Q3 notes.pptx", bytes: 100, created: true },
          { path: "memo.docx", bytes: 100, created: true },
          { path: "report.md", bytes: 100, created: true },
        ] }} />,
    );
    expect(html).toContain("klide-result-app-stack");
    expect(html.split("klide-result-app-disc").length - 1).toBe(3);
    // Per document, not per kind: two decks and a memo are three pictures.
    expect(html.split("<img").length - 1).toBe(3);
    expect(html).toContain("powerpoint");
    expect(html).toContain("word");
    // The fourth is beyond the stack; no review glass anywhere.
    expect(html).not.toContain("<svg");
    expect(html).toContain("+1");
    expect(html).toContain("4 documents");
  });

  it("is one disc for one document, two for two, with no count beside them", () => {
    const stack = (paths: string[]) => renderToStaticMarkup(
      <CompletionCard variant="island" folded onUnfold={() => {}} onReview={() => {}} onRequestChanges={() => {}}
        completion={{ ...completion, artifacts: paths.map((path) => ({ path, bytes: 100, created: true })) }} />,
    );
    const one = stack(["report.md"]);
    expect(one.split("klide-result-app-disc").length - 1).toBe(1);
    expect(one).toContain('stroke="currentColor"');
    expect(one).not.toContain("klide-result-meta");
    const two = stack(["report.md", "site/index.html"]);
    expect(two.split("klide-result-app-disc").length - 1).toBe(2);
    expect(two.split("<svg").length - 1).toBe(2);
    expect(two).not.toContain("klide-result-meta");
  });

  it("gives a Markdown document its mark in the evidence rows too", () => {
    const html = renderEvidence({ ...completion, artifacts: [{ path: "report.md", bytes: 100, created: true }] });
    expect(html).toContain("klide-result-app-logo");
    expect(html).toContain("<svg");
  });
});
