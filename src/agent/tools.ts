import type { AgentMode } from "./types";

export type AgentToolCall = { id?: string; name: string; args: any };

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full text contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Path relative to the workspace root, e.g. "src/App.tsx".',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries (files and folders) of a directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Path relative to the workspace root. Use "." for the workspace root itself.',
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Propose a search-and-replace edit to an existing file. The user reviews the diff and approves or rejects it.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the existing file, relative to the workspace root.",
          },
          old_str: {
            type: "string",
            description:
              "The exact text to find in the file. Must match a unique substring.",
          },
          new_str: {
            type: "string",
            description: "The replacement text. Use an empty string to delete the matched text.",
          },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find workspace files matching a glob-like pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: 'Pattern such as "src/**/*.ts" or "*.md".',
          },
          path: {
            type: "string",
            description: 'Optional workspace-relative directory to search from. Use "." for root.',
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search text files in the workspace for a literal pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Text pattern to search for.",
          },
          path: {
            type: "string",
            description: 'Optional workspace-relative file or directory. Use "." for root.',
          },
          maxResults: {
            type: "number",
            description: "Optional cap on returned matches.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_git_status",
      description: "Return git branch and changed files for the workspace.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_git_diff",
      description: "Return git diff for the workspace or one path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional workspace-relative path.",
          },
          staged: {
            type: "boolean",
            description: "Whether to read staged diff.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Propose creating a brand-new file with the given contents. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the new file, relative to the workspace root.",
          },
          contents: {
            type: "string",
            description: "Full text contents of the new file.",
          },
        },
        required: ["path", "contents"],
      },
    },
  },
];

const READ_ONLY_TOOLS = AGENT_TOOLS.filter(
  (t) =>
    t.function.name === "read_file" ||
    t.function.name === "list_dir" ||
    t.function.name === "glob" ||
    t.function.name === "grep" ||
    t.function.name === "get_git_status" ||
    t.function.name === "get_git_diff"
);

export function toolsForMode(mode: AgentMode) {
  if (mode === "chat") return undefined;
  return mode === "plan" ? READ_ONLY_TOOLS : AGENT_TOOLS;
}

export function parseToolCallsFromChunk(raw: any): AgentToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((tc): AgentToolCall | null => {
      const fn = tc.function ?? tc;
      const name = fn?.name;
      const id = typeof tc.id === "string" ? tc.id : undefined;
      let args = fn?.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = { _raw: args };
        }
      }
      return name ? { id, name, args: args ?? {} } : null;
    })
    .filter((x): x is AgentToolCall => x !== null);
}
