import { describe, expect, it } from "vitest";
import {
  parseClassify,
  parseSummaryResponse,
} from "./summarizePrompts";

describe("parseSummaryResponse", () => {
  it("parses a well-formed three-block response", () => {
    const text = [
      "NOTES:",
      "Refactored the tab bar. One test still failing.",
      "",
      "DECISIONS:",
      "- keep inline styles",
      "* derive the index from the store",
      "",
      "GOAL:",
      "Fix the tab drift bug.",
    ].join("\n");
    const parsed = parseSummaryResponse(text);
    expect(parsed.notes).toBe("Refactored the tab bar. One test still failing.");
    expect(parsed.decisions).toEqual([
      "keep inline styles",
      "derive the index from the store",
    ]);
    expect(parsed.goal).toBe("Fix the tab drift bug.");
  });

  it("returns empty fields when a section is missing, not garbage", () => {
    const parsed = parseSummaryResponse("NOTES:\nJust notes, no other blocks.");
    expect(parsed.notes).toBe("Just notes, no other blocks.");
    expect(parsed.decisions).toEqual([]);
    expect(parsed.goal).toBe("");
  });

  // The shape of the old every-summary-came-back-empty bug: the model reply
  // arrives as an empty string. The parser must degrade to all-empty fields
  // (callers detect that and use the deterministic fallback), never throw.
  it("survives an empty model reply", () => {
    const parsed = parseSummaryResponse("");
    expect(parsed).toEqual({ notes: "", decisions: [], goal: "", filesTouched: [] });
  });

  it("ignores headers that are not alone on their line", () => {
    const parsed = parseSummaryResponse("Sure! NOTES: everything went fine.");
    expect(parsed.notes).toBe("");
  });
});

describe("parseClassify", () => {
  it("parses a reusable classification", () => {
    const cls = parseClassify(
      "REUSABLE: yes\nNAME: Review Strict PR\nTITLE: Strict PR review\nDESCRIPTION: Use when reviewing PRs.\n"
    );
    expect(cls).toEqual({
      reusable: true,
      slug: "review-strict-pr",
      title: "Strict PR review",
      description: "Use when reviewing PRs.",
    });
  });

  it("returns null for REUSABLE: no", () => {
    expect(parseClassify("REUSABLE: no")).toBeNull();
  });

  it("returns null when the slug reduces to nothing", () => {
    expect(parseClassify("REUSABLE: yes\nNAME: ---\nTITLE: x")).toBeNull();
  });

  it("fills title and description from the slug when missing", () => {
    const cls = parseClassify("REUSABLE: yes\nNAME: deploy-ritual");
    expect(cls?.title).toBe("deploy-ritual");
    expect(cls?.description).toBe("Auto-generated from a session.");
  });
});

