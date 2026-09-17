import { describe, expect, it } from "vitest";
import type { SkillLede } from "../../skillAppearance";
import {
  hoistSkillCommand,
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

describe("hoistSkillCommand", () => {
  const accept = (value: string, start: number, caret: number, ledes: SkillLedes = LEDES) =>
    hoistSkillCommand({ value, start, caret, prefix: "/visualise ", ledes });

  it("keeps the whole-draft case as it was: the command and a cursor after it", () => {
    expect(accept("/visu", 0, 5)).toEqual({ value: "/visualise ", caret: 11 });
  });

  it("takes the head when the command was typed at the end of a sentence", () => {
    expect(accept("draw the auth flow /vis", 19, 23)).toEqual({
      value: "/visualise draw the auth flow",
      caret: 29,
    });
  });

  it("cuts the word out of the middle and leaves the caret at the seam", () => {
    expect(accept("draw /vis the auth flow", 5, 9)).toEqual({
      value: "/visualise draw the auth flow",
      caret: 15,
    });
  });

  it("cuts the whole word when the caret sits inside it", () => {
    expect(accept("draw the flow /vis", 14, 17)).toEqual({
      value: "/visualise draw the flow",
      caret: 24,
    });
  });

  it("replaces a skill already leading — one skill leads a message", () => {
    const ledes: SkillLedes = new Map(LEDES);
    expect(
      hoistSkillCommand({ value: "/visualise draw the flow /td", start: 25, caret: 28, prefix: "/tdd ", ledes }),
    ).toEqual({ value: "/tdd draw the flow", caret: 18 });
  });
});
