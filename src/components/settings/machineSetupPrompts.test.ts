import { describe, expect, it } from "vitest";
import { setupPrompt, setupSignIn } from "./machineSetupPrompts";

describe("graphical machine setup prompts", () => {
  it("recognizes split and styled password prompts without matching earlier log lines", () => {
    expect(setupPrompt("mini-user@host's pass")).toBeNull();
    expect(setupPrompt("\x1b[32mmini-user@host's password: \x1b[0m")).toEqual({ kind: "password" });
    expect(setupPrompt("[sudo] password for mini-user: ")).toEqual({ kind: "password" });
    expect(setupPrompt("Enter passphrase for key '/home/user/.ssh/id_ed25519': ")).toEqual({ kind: "passphrase" });
    expect(setupPrompt("Password: \nInstalling dependencies…\n")).toBeNull();
    expect(setupPrompt("Password: \r\n")).toBeNull();
  });
  it("requires explicit host trust and retains the fingerprint", () => {
    const fingerprint = "SHA256:abcdefghijklmnopqrstuvwxyz1234567890abcdefg";
    expect(setupPrompt(`ED25519 key fingerprint is ${fingerprint}.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? `)).toEqual({ kind: "trust", fingerprint });
    expect(setupPrompt("REMOTE HOST IDENTIFICATION HAS CHANGED\nAre you sure you want to continue connecting? ")).toBeNull();
  });
  it("maps authentication codes, confirmations and enter prompts to form controls", () => {
    expect(setupPrompt("Paste code here if prompted > ")).toEqual({ kind: "code" });
    expect(setupPrompt("Authenticate Git with your GitHub credentials? (Y/n) ")?.kind).toBe("confirm");
    expect(setupPrompt("Press Enter to open github.com in your browser…")).toEqual({ kind: "enter" });
    expect(setupPrompt("Use arrow keys to choose an account, then press Enter")).toEqual({ kind: "interactive" });
    expect(setupPrompt("Enter an API key: ")).toEqual({ kind: "interactive" });
    expect(setupPrompt("New password: ")).toEqual({ kind: "interactive" });
  });
  it("offers only the selected provider's HTTPS sign-in links", () => {
    expect(setupSignIn("Open https://claude.ai/oauth/authorize?state=exam", "signIn").url).toBeNull();
    expect(setupSignIn("Open https://claude.ai/oauth/authorize?state=example\n", "signIn").url).toBe("https://claude.ai/oauth/authorize?state=example");
    expect(setupSignIn("Docs: https://code.claude.com/docs/en/setup\nSign in: https://claude.ai/oauth/authorize?state=example\n", "signIn").url).toBe("https://claude.ai/oauth/authorize?state=example");
    expect(setupSignIn("First copy your one-time code: ABCD-1234\nhttps://github.com/login/device\n", "gitHub")).toEqual({ url: "https://github.com/login/device", deviceCode: "ABCD-1234" });
    for (const url of ["javascript:alert(1)", "http://github.com/login/device", "https://github.com.evil.test/login", "https://user:secret@github.com/login"]) expect(setupSignIn(`${url}\n`, "gitHub").url).toBeNull();
    expect(setupSignIn("https://claude.ai/oauth/authorize", "prepare").url).toBeNull();
  });
});
