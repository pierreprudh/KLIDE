import { describe, expect, it } from "vitest";
import { connectorBrand, serverNames } from "./linkMark";

describe("connectorBrand", () => {
  it("reads the brand from any name a connector carries", () => {
    expect(connectorBrand("github")?.key).toBe("github");
    expect(connectorBrand("gh", "Work", serverNames({ url: "https://api.githubcopilot.com/mcp/", headers: {} }))?.key).toBe("github");
    expect(connectorBrand("docs", "Docs", serverNames({ command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: {} }))?.key).toBe("notion");
    expect(connectorBrand("node_repl")?.key).toBe("node");
    expect(connectorBrand("obsidian-mcp-tools")?.key).toBe("obsidian");
  });

  it("matches whole tokens, never a word inside another", () => {
    expect(connectorBrand("sandbox-runner", "Mirror")).toBeNull();
    expect(connectorBrand("pencil", "Pencil", "pencil mcp")).toBeNull();
  });

  it("names the product before its maker", () => {
    expect(connectorBrand("atlassian-jira")?.key).toBe("jira");
  });
});
