import { describe, expect, it } from "vitest";
import { parseScriptCommand } from "./scriptCommand";

describe("parseScriptCommand", () => {
  it("reads a heredoc script, one statement per line, and the file it writes", () => {
    const command = `python3 - <<'PY'
from pathlib import Path
p=Path('src-tauri/src/bench.rs');s=p.read_text().replace('"a"','"b"');p.write_text(s)
PY`;
    expect(parseScriptCommand(command)).toEqual({
      head: "python3",
      lines: [
        "from pathlib import Path",
        "p=Path('src-tauri/src/bench.rs')",
        `s=p.read_text().replace('"a"','"b"')`,
        "p.write_text(s)",
      ],
      writes: ["src-tauri/src/bench.rs"],
    });
  });

  it("keeps a semicolon inside a string, and a comment, on its line", () => {
    const parsed = parseScriptCommand(`python3 -c 'print("a;b")  # x; y'`);
    expect(parsed?.head).toBe("python3");
    expect(parsed?.lines).toEqual([`print("a;b")  # x; y`]);
    expect(parsed?.writes).toEqual([]);
  });

  it("names open() targets only when opened for writing", () => {
    const parsed = parseScriptCommand(`python3 - <<EOF
data = open('in.json').read()
with open("out.json", "w") as f:
    f.write(data)
EOF`);
    expect(parsed?.writes).toEqual(["out.json"]);
    expect(parsed?.lines[2]).toBe("    f.write(data)");
  });

  it("never claims a command with more chained after the script", () => {
    expect(parseScriptCommand(`python3 - <<'PY'\nprint(1)\nPY\ncargo check`)).toBeNull();
    expect(parseScriptCommand(`python3 -c 'print(1)' && rm -rf build`)).toBeNull();
  });

  it("leaves ordinary commands to the shell line", () => {
    expect(parseScriptCommand("git remote -v")).toBeNull();
    expect(parseScriptCommand("python3 scripts/bench.py")).toBeNull();
    expect(parseScriptCommand("node -e 'console.log(1)'")).toBeNull();
  });
});
