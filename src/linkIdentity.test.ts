import { describe, expect, it } from "vitest";
import { linkIdentity } from "./linkIdentity";

describe("linkIdentity", () => {
  it("names a GitHub link after the repo, not the owner", () => {
    expect(linkIdentity("https://github.com/tauri-apps/tauri")).toEqual({
      label: "tauri", site: "github", bare: false,
    });
  });

  it("keeps the repo name through a deep path", () => {
    expect(linkIdentity("https://github.com/ollama/ollama/blob/main/docs/api.md").label).toBe("ollama");
  });

  it("falls back to the owner when that is all there is", () => {
    expect(linkIdentity("https://github.com/pierreprudh").label).toBe("pierreprudh");
    expect(linkIdentity("https://github.com").label).toBe("GitHub");
  });

  it("names an npm link after the package, scope and all", () => {
    expect(linkIdentity("https://www.npmjs.com/package/@tauri-apps/api")).toEqual({
      label: "@tauri-apps/api", site: "npm", bare: false,
    });
  });

  it("knows the products Klide is built out of", () => {
    expect(linkIdentity("https://v2.tauri.app/reference/").label).toBe("Tauri");
    expect(linkIdentity("https://xtermjs.org/docs/").label).toBe("xterm.js");
    expect(linkIdentity("https://ollama.com/library/llama3.1").site).toBe("ollama");
  });

  it("reads a project page as its project", () => {
    expect(linkIdentity("https://someone.github.io/my-lib/api")).toEqual({
      label: "my-lib", site: "github", bare: false,
    });
  });

  it("falls back to the host, without the www nobody reads", () => {
    expect(linkIdentity("https://www.example.com/a/b/c")).toEqual({
      label: "example.com", site: null, bare: false,
    });
  });

  it("leaves mail as the address, with no mark", () => {
    expect(linkIdentity("mailto:someone@example.com")).toEqual({
      label: "someone@example.com", site: null, bare: true,
    });
  });

  it("never throws on something that is not a URL", () => {
    expect(linkIdentity("not a url")).toEqual({ label: "not a url", site: null, bare: true });
  });
});
