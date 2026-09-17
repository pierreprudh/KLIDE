import { describe, expect, it } from "vitest";
import { enabledFirst } from "./skills";

describe("enabledFirst", () => {
  it("moves the enabled skills ahead and keeps each side's own order", () => {
    const s = (id: string, enabled: boolean) => ({ id, name: id, description: "", instructions: "", tools: [], enabled });
    const out = enabledFirst([s("a", false), s("b", true), s("c", false), s("d", true)]);
    expect(out.map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
});
