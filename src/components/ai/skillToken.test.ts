import { describe, expect, it } from "vitest";
import type { Skill } from "../../skills";
import {
  joinSkillToken,
  skillTokenCaret,
  skillTokenOf,
  splitSkillToken,
} from "./skillToken";

function skill(name: string, enabled = true): Skill {
  return { id: name, name, description: "", instructions: "", tools: [], enabled };
}

const installed = [skill("visualise"), skill("Code Review")];

describe("skillTokenOf", () => {
  it("reads a wired command once the space closes it", () => {
    const token = skillTokenOf("/visualise draw the run loop", installed);
    expect(token).toMatchObject({ command: "visualise", label: "Visualise", prefix: "/visualise " });
  });

  it("leaves a half-typed command as text, so the / menu keeps its own", () => {
    expect(skillTokenOf("/visu", installed)).toBeNull();
    expect(skillTokenOf("/visualise", installed)).toBeNull();
  });

  it("stays out of prose and paths", () => {
    expect(skillTokenOf("open src/App.tsx please", installed)).toBeNull();
    expect(skillTokenOf("", installed)).toBeNull();
  });

  it("does not wire a command no skill answers to", () => {
    expect(skillTokenOf("/plan the release", installed)).toBeNull();
    expect(skillTokenOf("/code-review this diff", installed)).toBeNull();
  });

  it("refuses a skill that is installed but off — the run would not follow it", () => {
    expect(skillTokenOf("/visualise draw it", [skill("visualise", false)])).toBeNull();
    expect(skillTokenOf("/visualise draw it", [])).toBeNull();
  });
});

describe("split and join", () => {
  it("round-trips the draft through the lede", () => {
    const { token, body } = splitSkillToken("/visualise draw the flow", installed);
    expect(body).toBe("draw the flow");
    expect(joinSkillToken(token, body)).toBe("/visualise draw the flow");
  });

  it("hands an untokenized draft back verbatim", () => {
    const { token, body } = splitSkillToken("draw the flow", installed);
    expect(token).toBeNull();
    expect(body).toBe("draw the flow");
    expect(joinSkillToken(token, body)).toBe("draw the flow");
  });

  it("keeps an emptied body attached, so the lede survives clearing the text", () => {
    const { token, body } = splitSkillToken("/visualise ", installed);
    expect(body).toBe("");
    expect(joinSkillToken(token, "")).toBe("/visualise ");
  });

  it("maps a caret in the body onto the draft", () => {
    const { token } = splitSkillToken("/visualise draw", installed);
    expect(skillTokenCaret(token, 0)).toBe(11);
    expect(skillTokenCaret(null, 4)).toBe(4);
  });
});
