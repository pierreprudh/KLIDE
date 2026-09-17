import { describe, expect, it } from "vitest";
import type { SkillLede } from "../../skillAppearance";
import {
  draftSpans,
  joinSkillToken,
  skillTokenCaret,
  skillTokenOf,
  splitSkillToken,
  type SkillLedes,
} from "./skillToken";

const LEDES: SkillLedes = new Map<string, SkillLede>([
  ["visualise", { label: "Visualise", mark: "diagram" }],
]);
const NONE: SkillLedes = new Map();

describe("skillTokenOf", () => {
  it("reads a wired command once the space closes it", () => {
    const token = skillTokenOf("/visualise draw the run loop", LEDES);
    expect(token).toMatchObject({ command: "visualise", label: "Visualise", mark: "diagram", prefix: "/visualise " });
  });

  it("leaves a half-typed command as text, so the / menu keeps its own", () => {
    expect(skillTokenOf("/visu", LEDES)).toBeNull();
    expect(skillTokenOf("/visualise", LEDES)).toBeNull();
  });

  it("stays out of prose and paths", () => {
    expect(skillTokenOf("open src/App.tsx please", LEDES)).toBeNull();
    expect(skillTokenOf("", LEDES)).toBeNull();
  });

  it("does not wire a command that isn't in the map", () => {
    expect(skillTokenOf("/plan the release", LEDES)).toBeNull();
    expect(skillTokenOf("/visualise draw it", NONE)).toBeNull();
  });
});

describe("split and join", () => {
  it("round-trips the draft through the lede", () => {
    const { token, body } = splitSkillToken("/visualise draw the flow", LEDES);
    expect(body).toBe("draw the flow");
    expect(joinSkillToken(token, body)).toBe("/visualise draw the flow");
  });

  it("hands an untokenized draft back verbatim", () => {
    const { token, body } = splitSkillToken("draw the flow", LEDES);
    expect(token).toBeNull();
    expect(body).toBe("draw the flow");
    expect(joinSkillToken(token, body)).toBe("draw the flow");
  });

  it("keeps an emptied body attached, so the lede survives clearing the text", () => {
    const { token, body } = splitSkillToken("/visualise ", LEDES);
    expect(body).toBe("");
    expect(joinSkillToken(token, "")).toBe("/visualise ");
  });

  it("maps a caret in the body onto the draft", () => {
    const { token } = splitSkillToken("/visualise draw", LEDES);
    expect(skillTokenCaret(token, 0)).toBe(11);
    expect(skillTokenCaret(null, 4)).toBe(4);
  });
});

describe("draftSpans", () => {
  const marked = (value: string) => draftSpans(value, LEDES).filter((s) => s.skill).map((s) => s.text);

  it("marks a wired command inside a sentence", () => {
    expect(draftSpans("use /visualise here", LEDES)).toEqual([
      { text: "use ", skill: false },
      { text: "/visualise", skill: true },
      { text: " here", skill: false },
    ]);
  });

  it("marks one at the head and one at the end of the line", () => {
    expect(marked("/visualise the flow")).toEqual(["/visualise"]);
    expect(marked("draw the flow /visualise ")).toEqual(["/visualise"]);
  });

  it("waits for the space that closes the command, so nothing flickers while typing", () => {
    expect(marked("use /visu")).toEqual([]);
    expect(marked("use /visualise")).toEqual([]);
    expect(marked("use /visualise ")).toEqual(["/visualise"]);
  });

  it("leaves paths, prose and unwired skills plain", () => {
    expect(marked("open src/visualise now")).toEqual([]);
    expect(marked("run /tdd first")).toEqual([]);
    expect(draftSpans("plain text", LEDES)).toEqual([{ text: "plain text", skill: false }]);
    expect(draftSpans("", LEDES)).toEqual([]);
  });
});
