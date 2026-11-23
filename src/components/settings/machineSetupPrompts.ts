import type { MachineSetupAction } from "../../ipc/machines";

export type SetupPrompt = { kind: "password" | "passphrase" | "code" | "interactive" } | { kind: "trust"; fingerprint: string | null } | { kind: "confirm"; message: string } | { kind: "enter" };

export function plainSetupOutput(output: string): string {
  // gh's prompts use DEC save/restore cursor (ESC 7/8), not CSI sequences.
  // Leaving these after (Y/n) hides the question from the form parser.
  return output.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[78]/g, "").replace(/\r/g, "");
}

/** Interpret prompts only at the current input line, never old log messages. */
export function setupPrompt(output: string): SetupPrompt | null {
  const text = plainSetupOutput(output);
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return null;
  const line = text.split("\n").pop()?.trim() ?? "";
  if (/are you sure you want to continue connecting.*\?$/i.test(line)) return { kind: "trust", fingerprint: text.match(/SHA256:[A-Za-z\d+/]{20,}={0,2}/)?.[0] ?? null };
  if (/\bpassphrase\b[^\n]*:\s*$/i.test(line)) return { kind: "passphrase" };
  if (/\b(?:new|retype|confirm|change)\b[^\n]*\bpassword\b/i.test(line)) return { kind: "interactive" };
  if (/\bpassword\b[^\n]*:\s*$/i.test(line)) return { kind: "password" };
  if (/^(?:[>›❯]\s*)?(?:paste|enter)[^\n]{0,100}\b(?:code|token)\b[^\n]*[:>›❯]\s*$/i.test(line)) return { kind: "code" };
  if (/[[(]\s*[yn]\s*\/\s*[yn]\s*[\])]\s*[:?]?\s*$/i.test(line)) return { kind: "confirm", message: line.slice(-220) };
  if (/use.*(?:arrow|↑|↓)|arrow keys|select.*with.*(?:↑|↓)/i.test(line)) return { kind: "interactive" };
  if (/press\s+(?:enter|return)\b/i.test(line)) return { kind: "enter" };
  if (/\b(?:enter|paste|input|type|select|choose|press)\b.{0,160}[:?>›❯]\s*$/i.test(line) || /\?\s*$/.test(line)) return { kind: "interactive" };
  return null;
}

export function setupSignIn(output: string, action: MachineSetupAction): { url: string | null; deviceCode: string | null } {
  if (action !== "signIn" && action !== "gitHub") return { url: null, deviceCode: null };
  const text = plainSetupOutput(output);
  // gh prints either "First copy your one-time code: XXXX-XXXX" or
  // "One-time code (XXXX-XXXX) copied to clipboard". It can precede the URL.
  const codes = [...text.matchAll(/(?:one[- ]time|device|verification)\s+code\s*(?::\s*|\(\s*|\s+)([A-Z\d]{4}-[A-Z\d]{4})\b/gi)];
  const deviceCode = codes[codes.length - 1]?.[1] ?? null;
  for (const match of text.matchAll(/https:\/\/[^\s<>"'\x00-\x1f]+(?=[\s<>"'\x00-\x1f])/g)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ""));
      const domains = action === "gitHub" ? ["github.com"] : ["claude.ai", "claude.com", "anthropic.com"];
      if (url.username || url.password || !domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) continue;
      if (!/(?:^|\/)(?:oauth|login|auth|authorize)(?:\/|$)/i.test(url.pathname)) continue;
      return { url: url.href, deviceCode };
    } catch { /* Incomplete URL while a PTY chunk is arriving. */ }
  }
  return { url: null, deviceCode };
}
