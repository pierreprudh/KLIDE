import { test, expect, type Page } from "@playwright/test";

async function enterManualSsh(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByRole("button", { name: "Direct SSH", exact: false }).click();
  await dialog.getByRole("button", { name: "Add a machine", exact: true }).click();
}

test("GitHub cursor controls do not hide confirmation or stall browser sign-in", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?settings=1&needsGhLogin=1&prompt=github&theme=klide-light");
  await page.evaluate(() => { window.open = ((url: string) => { (window as any).__MACHINE_OPENED_URL__ = url; return null; }) as typeof window.open; });
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const setup = page.locator(".klide-machine-setup");
  await setup.getByRole("list", { name: "Setup progress" }).getByRole("button", { name: "GitHub", exact: true }).click();
  await setup.getByRole("button", { name: "Sign in to GitHub", exact: true }).click();
  await expect(setup.getByText("? Authenticate Git with your GitHub credentials? (Y/n)", { exact: true })).toBeVisible();
  await expect(setup.getByLabel("Setup details")).toBeVisible();
  await setup.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(setup.getByLabel("Sign-in code", { exact: true })).toContainText("ABCD-1234");
  await setup.getByRole("button", { name: "Hide details", exact: true }).click();
  await expect(setup.getByLabel("Sign-in code", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(setup.getByLabel("Setup details")).toBeVisible();
  await setup.getByRole("button", { name: "Open GitHub", exact: true }).click();
  await expect(setup.getByText("GitHub verified", { exact: true })).toBeVisible();
  await expect(setup.getByRole("heading", { name: "Ready for remote tasks" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__MACHINE_OPENED_URL__)).toBe("https://github.com/login/device");
  expect(await page.evaluate(() => (window as any).__MACHINE_INPUTS__)).toEqual(["y\r", "\x1b[24;80R", "\r"]);
  expect(await page.evaluate(() => (window as any).__MACHINE_SETUP_ACTIONS__)).toEqual(["gitHub"]);
  await setup.getByRole("list", { name: "Setup progress" }).getByRole("button", { name: "GitHub", exact: true }).click();
  await expect(setup.getByText("GitHub is signed in on this machine. You can reconnect your account here.")).toBeVisible();
});

for (const [surface, theme] of [["settings", "dark"], ["popup", "klide-light"], ["popup", "dark"]]) {
  test(`${surface} shows and copies the GitHub code below the terminal in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).__COPIED_MACHINE_CODE__ = value; } } });
    });
    await page.goto(`/preview/where-it-runs.html?needsGhLogin=1&prompt=github&codeStyle=clipboard&theme=${theme}&${surface === "settings" ? "settings=1" : "state=empty"}`);
    if (surface === "settings") await page.getByRole("button", { name: "Manage", exact: true }).click();
    else {
      await page.getByRole("button", { name: "Where it runs", exact: true }).click();
      await page.getByRole("option", { name: "Add a machine", exact: true }).click();
      await enterManualSsh(page);
      await page.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
      await page.getByRole("dialog").getByRole("button", { name: "Continue", exact: true }).click();
    }
    const setup = page.locator(".klide-machine-setup");
    await setup.getByRole("list", { name: "Setup progress" }).getByRole("button", { name: "GitHub", exact: true }).click();
    await setup.getByRole("button", { name: "Sign in to GitHub", exact: true }).click();
    await setup.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(setup.getByRole("heading", { name: "GitHub sign-in code", exact: true })).toBeVisible();
    await expect(setup.getByLabel("Sign-in code", { exact: true })).toContainText("ABCD-1234");
    await expect(setup.locator(".klide-machine-code-character")).toHaveCount(8);
    await expect(setup.getByLabel("Setup details")).toBeVisible();
    const log = (await setup.getByLabel("Setup details").boundingBox())!;
    const codePanel = (await setup.locator(".klide-machine-signin-panel").boundingBox())!;
    expect(codePanel.y).toBeGreaterThanOrEqual(log.y + log.height);
    await setup.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect(setup.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__COPIED_MACHINE_CODE__)).toBe("ABCD-1234");
    await expect(setup.getByRole("button", { name: "Open GitHub", exact: true })).toBeVisible();
    expect(await setup.locator(".klide-machine-session-card").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (surface === "popup") {
      const dialog = page.getByRole("dialog");
      const frame = (await dialog.boundingBox())!;
      const footer = (await setup.locator(".klide-machine-setup-footer").boundingBox())!;
      expect(footer.y + footer.height).toBeLessThanOrEqual(frame.y + frame.height - 12);
    }
    await page.screenshot({ path: `artifacts/design-feedback/github-signin-code-${surface}-${theme}.png`, fullPage: surface === "settings" });
  });
}

for (const success of [true, false]) {
  test(`GitHub code ${success ? "morphs to verified only after successful login" : "never shows verified after a failed login"}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`/preview/where-it-runs.html?settings=1&needsGhLogin=1&prompt=github&holdGithub=1&theme=dark${success ? "" : "&failGithub=1"}`);
    await page.evaluate(() => { window.open = (() => null) as typeof window.open; });
    await page.getByRole("button", { name: "Manage", exact: true }).click();
    const setup = page.locator(".klide-machine-setup");
    await setup.getByRole("button", { name: "GitHub", exact: true }).click();
    await setup.getByRole("button", { name: "Sign in to GitHub", exact: true }).click();
    await setup.getByRole("button", { name: "Continue", exact: true }).click();
    const panel = setup.locator(".klide-machine-signin-panel");
    await expect(panel).toHaveAttribute("data-state", "code");
    await setup.getByRole("button", { name: "Open GitHub", exact: true }).click();
    await expect(panel).toHaveAttribute("data-state", "code");
    await page.evaluate(() => (window as any).__MACHINE_GITHUB_COMPLETE__());
    if (success) {
      await expect(panel).toHaveAttribute("data-state", "verified");
      await expect(setup.getByText("GitHub verified", { exact: true })).toBeVisible();
      await expect(setup.getByRole("button", { name: "Copy code", exact: true })).toBeHidden();
      await panel.evaluate(async (el) => { await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))); });
      await panel.screenshot({ path: "artifacts/design-feedback/github-signin-verified-dark.png", animations: "disabled" });
      await expect(setup.getByRole("heading", { name: "Ready for remote tasks" })).toBeVisible();
    } else {
      await expect(setup.getByRole("status").filter({ hasText: "Setup couldn’t finish" })).toBeVisible();
      await expect(setup.locator('[data-state="verified"]')).toHaveCount(0);
    }
  });
}

test("the logo checklist updates from live checks without stopping an active installer", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/preview/where-it-runs.html?state=empty&needsInstall=1&hostReady=1&missingGh=1&liveChecklist=1&system=macos&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  await enterManualSsh(page);
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  const checklist = dialog.getByRole("list", { name: "Setup progress" });
  const claude = checklist.locator("li").filter({ hasText: "Claude Code" });
  const github = checklist.locator("li").filter({ hasText: "GitHub" });
  await expect(claude).toContainText("Not installed");
  await expect(github).toContainText("Not installed");
  await expect(checklist.locator(".klide-machine-checklist-logo")).toHaveCount(6);
  await dialog.getByRole("button", { name: "Install and continue", exact: true }).click();
  await expect(claude).toHaveAttribute("data-state", "done", { timeout: 10000 });
  await expect(claude).toContainText("Validated");
  await expect(github).toContainText("Installed · sign in");
  await expect(github).toHaveAttribute("data-state", "needed");
  await expect(dialog.getByRole("heading", { name: "Prepare this machine" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__MACHINE_SETUP_CLOSES__)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__MACHINE_SETUP_ACTIONS__)).toEqual(["prepare"]);
  const frame = (await dialog.boundingBox())!;
  const footer = (await dialog.locator(".klide-machine-setup-footer").boundingBox())!;
  expect(footer.y + footer.height).toBeLessThanOrEqual(frame.y + frame.height - 12);
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/design-feedback/machine-live-checklist.png" });
  await page.evaluate(() => (window as any).__MACHINE_FINISH_SETUP__());
  await expect(dialog.getByRole("heading", { name: "Ready for remote tasks" })).toBeVisible();
  await checklist.getByRole("button", { name: "GitHub", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Connect GitHub" })).toBeVisible();
  await expect(dialog.getByText("GitHub CLI is already installed. Sign in to use private repositories.")).toBeVisible();
});

for (const [prompt, surface] of [["password", "popup"], ["trust", "popup"], ["password", "settings"]]) {
  test(`${surface} handles ${prompt} with form controls instead of a terminal`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(`/preview/where-it-runs.html?theme=klide-light&offline=1&needsInstall=1&prompt=${prompt}&${surface === "settings" ? "settings=1" : "state=empty"}`);
    if (surface === "settings") await page.getByRole("button", { name: "Continue setup", exact: true }).click();
    else {
      await page.getByRole("button", { name: "Where it runs", exact: true }).click();
      await page.getByRole("option", { name: "Add a machine", exact: true }).click();
      await enterManualSsh(page);
      await page.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    }
    const setup = page.locator(".klide-machine-setup");
    await setup.getByRole("button", { name: "Connect with SSH", exact: true }).click();
    await expect(prompt === "password" ? setup.getByLabel("Machine password") : setup.getByRole("heading", { name: "Trust this machine?" })).toBeVisible();
    await expect(setup.getByLabel("Setup details")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__MACHINE_INPUTS__)).toBeUndefined();
    if (surface === "popup") {
      const dialog = page.getByRole("dialog", { name: "Add a machine" });
      const frame = (await dialog.boundingBox())!;
      const footer = (await setup.locator(".klide-machine-setup-footer").boundingBox())!;
      expect(footer.y + footer.height).toBeLessThanOrEqual(frame.y + frame.height - 12);
      expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      await page.screenshot({ path: `artifacts/design-feedback/machine-${prompt}-form.png` });
    }
    if (prompt === "password") {
      await setup.getByRole("button", { name: "Show details", exact: true }).click();
      await expect(setup.getByLabel("Setup details")).toBeVisible();
      await setup.getByRole("button", { name: "Hide details", exact: true }).click();
      expect(await page.evaluate(() => (window as any).__MACHINE_SETUP_ACTIONS__)).toEqual(["connect"]);
      await setup.getByLabel("Machine password").fill("fixture-password");
      await setup.getByRole("button", { name: "Continue", exact: true }).click();
    } else await setup.getByRole("button", { name: "Trust and connect", exact: true }).click();
    await expect(setup.getByRole("heading", { name: "Prepare this machine" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__MACHINE_INPUTS__)).toEqual([prompt === "password" ? "fixture-password\r" : "yes\r"]);
  });
}

test("Claude sign-in offers a browser button and code field without a terminal", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&needsLogin=1&prompt=oauth&theme=klide-light");
  await page.evaluate(() => { window.open = ((url: string) => { (window as any).__MACHINE_OPENED_URL__ = url; return null; }) as typeof window.open; });
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  await enterManualSsh(page);
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Sign in on this machine", exact: true }).click();
  await expect(dialog.getByLabel("Authorization code")).toBeVisible();
  await expect(dialog.getByLabel("Setup details")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Open sign-in page", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__MACHINE_OPENED_URL__)).toBe("https://claude.ai/oauth/authorize?state=example");
  await dialog.getByLabel("Authorization code").fill("fixture-auth-code");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Ready for remote tasks" })).toBeVisible();
});

test("an unsupported interactive prompt only opens a terminal on request", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&needsLogin=1&prompt=interactive&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  await enterManualSsh(page);
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Sign in on this machine", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Open interactive prompt", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Setup details")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__MACHINE_INPUTS__)).toBeUndefined();
  await dialog.getByRole("button", { name: "Open interactive prompt", exact: true }).click();
  await expect(dialog.getByLabel("Remote setup terminal")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__MACHINE_SETUP_ACTIONS__)).toEqual(["signIn"]);
});

test("ordinary setup failures show a readable error without opening a terminal", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&offline=1&failConnect=1&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  await enterManualSsh(page);
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Connect with SSH", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Remote Login" })).toBeVisible();
  await expect(dialog.getByLabel("Setup details")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(dialog.getByLabel("Setup details")).toBeVisible();
  await expect(dialog.getByLabel("Remote setup terminal")).toHaveCount(0);
});

test("Settings deletes only a confirmed saved connection without opening Details", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=ready&settings=1&theme=klide-light");
  await page.getByRole("button", { name: "Delete machine", exact: true }).click();
  const confirmation = page.getByRole("alert");
  await expect(confirmation).toContainText("Files and tasks on the remote machine are kept");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "klide-box", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete machine", exact: true }).click();
  await confirmation.getByRole("button", { name: "Delete machine", exact: true }).click();
  await expect(page.getByRole("heading", { name: "klide-box", exact: true })).toHaveCount(0);
  await expect(page.getByText("No remote machines connected yet.")).toBeVisible();
  expect(await page.evaluate(async () => (window as any).__TAURI_INTERNALS__.invoke("machines_list"))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__MACHINE_SETUP_ACTIONS__)).toBeUndefined();
});

test("Settings keeps a saved machine when deleting fails", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=ready&settings=1&failRemove=1&theme=klide-light");
  await page.getByRole("button", { name: "Delete machine", exact: true }).click();
  await page.getByRole("alert").getByRole("button", { name: "Delete machine", exact: true }).click();
  await expect(page.getByRole("heading", { name: "klide-box", exact: true })).toBeVisible();
  await expect(page.getByText("Could not remove the saved machine", { exact: false })).toBeVisible();
});

for (const surface of ["popup", "settings"]) {
  test(`${surface} can revisit every setup step on an already ready machine`, async ({ page }) => {
    await page.goto(`/preview/where-it-runs.html?theme=klide-light&${surface === "settings" ? "state=ready&settings=1" : "state=empty"}`);
    if (surface === "settings") await page.getByRole("button", { name: "Manage", exact: true }).click();
    else {
      await page.getByRole("button", { name: "Where it runs", exact: true }).click();
      await page.getByRole("option", { name: "Add a machine", exact: true }).click();
      await enterManualSsh(page);
      await page.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    }
    const setup = page.locator(".klide-machine-setup");
    await expect(setup.getByRole("heading", { name: "Ready for remote tasks" })).toBeVisible();
    for (const [step, heading] of [["Connect", "Connect to your machine"], ["Install", "Prepare this machine"], ["Sign in", "Sign in to Claude Code"], ["Project", "Choose the remote project"], ["Ready", "Ready for remote tasks"]]) {
      await setup.getByRole("button", { name: step, exact: true }).click();
      await expect(setup.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      const marker = setup.locator(".klide-machine-step-marker");
      await expect(marker).toHaveAttribute("data-step", ({ Connect: "connection", Install: "software", "Sign in": "signIn", Project: "project", Ready: "ready" } as Record<string, string>)[step]);
      const selected = (await setup.locator('.klide-machine-checklist [aria-current="step"]').boundingBox())!;
      const position = (await marker.boundingBox())!;
      expect(Math.abs(position.y - selected.y)).toBeLessThan(1);
      expect(Math.abs(position.height - selected.height)).toBeLessThan(1);
    }
    await setup.getByRole("button", { name: "Connect", exact: true }).click();
    await setup.getByLabel("SSH host", { exact: true }).fill("100.64.0.9");
    await setup.getByLabel("Remote username", { exact: true }).fill("another-user");
    await setup.getByRole("button", { name: "Save for later", exact: true }).click();
    if (surface === "settings") {
      await expect(page.getByText("another-user@100.64.0.9", { exact: true })).toBeVisible();
      await expect(setup).toHaveCount(0);
    } else await expect(page.getByRole("dialog", { name: "Add a machine" })).toHaveCount(0);
    expect(await page.evaluate(async () => (window as any).__TAURI_INTERNALS__.invoke("machines_list"))).toEqual(expect.arrayContaining([expect.objectContaining({ sshHost: "another-user@100.64.0.9" })]));
  });
}

test("Settings edits the same SSH account fields and opens Tailscale discovery directly", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=ready&settings=1&theme=klide-light");
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("button", { name: "Edit machine", exact: true }).click();
  await page.getByLabel("SSH host", { exact: true }).fill("100.64.0.8");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.getByLabel("Remote username", { exact: true }).fill("mini-user");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".klide-machine-name > code").filter({ hasText: "mini-user@100.64.0.8" })).toBeVisible();
  await page.getByRole("button", { name: "Connect via Tailscale", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await expect(dialog.getByRole("heading", { name: "Machines on Tailscale" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Linux dev/ })).toBeVisible();
});

test("Settings stays synchronized with machine saves from the popup data layer", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=ready&settings=1&theme=klide-light");
  await expect(page.getByRole("heading", { name: "klide-box", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const setup = page.getByRole("region", { name: "Set up klide-box" });
  await setup.getByRole("button", { name: "Project", exact: true }).click();
  await setup.getByLabel("Remote folder").fill("~/code/unfinished-project-edit");
  await page.evaluate(async () => {
    const module = await import("/src/ipc/machines.ts");
    await module.machineSave({ id: "new-mini", label: "New mini", sshHost: "mini-user@100.64.0.9", checkouts: {} }, true);
  });
  await expect(page.getByRole("heading", { name: "New mini", exact: true })).toBeVisible();
  await expect(setup.getByLabel("Remote folder")).toHaveValue("~/code/unfinished-project-edit");
});

test("connection management fits before opening a terminal in a short window", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/preview/where-it-runs.html?state=empty&offline=1&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  await enterManualSsh(page);
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Connect with SSH", exact: true })).toBeVisible();
  const frame = (await dialog.boundingBox())!;
  const footer = (await dialog.locator(".klide-machine-setup-footer").boundingBox())!;
  await page.screenshot({ path: "artifacts/design-feedback/add-machine-connection-management.png" });
  expect(footer.y + footer.height).toBeLessThanOrEqual(frame.y + frame.height - 14);
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
});

test("device discovery reserves bottom padding for its footer with the full production guidance", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.goto("/preview/where-it-runs.html?state=empty&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByRole("button", { name: /^Tailscale/ }).click();
  await expect(dialog.getByRole("button", { name: /Linux dev/ })).toBeVisible();
  const frame = (await dialog.boundingBox())!;
  const footer = (await dialog.locator(".klide-machine-dialog-footer").boundingBox())!;
  expect(footer.y + footer.height).toBeLessThanOrEqual(frame.y + frame.height - 14);
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  for (const row of await dialog.locator(".klide-machine-candidates > button").all()) {
    const box = (await row.boundingBox())!;
    expect(box.y + box.height).toBeLessThan(footer.y);
  }
});

test("discovered IP addresses require the remote account before saving or connecting", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&offline=1&failConnect=1&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByRole("button", { name: /^Tailscale/ }).click();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByRole("button", { name: /Mac mini/ }).click();
  await expect(dialog.getByLabel("SSH host", { exact: true })).toHaveValue("100.64.0.3");
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await dialog.getByLabel("Remote username", { exact: true }).fill("mini-user");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByLabel("Remote username", { exact: true })).toHaveValue("mini-user");
  await dialog.getByLabel("Remote username", { exact: true }).fill("");
  await expect(dialog.getByRole("button", { name: "Connect with SSH", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Enable background access", exact: true })).toBeDisabled();
  await dialog.getByLabel("Remote username", { exact: true }).fill("mini-user");
  await dialog.getByRole("button", { name: "Connect with SSH", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__MACHINE_SETUP_HOST__)).toBe("mini-user@100.64.0.3");
  await expect(dialog.getByRole("status").filter({ hasText: "Remote Login" })).toBeVisible();
  await page.screenshot({ path: "artifacts/design-feedback/add-machine-explicit-account.png" });
});

test("machines stay dimmed until SSH readiness is confirmed", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=offline&pendingCheck=1&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  const row = page.getByRole("option", { name: "klide-box", exact: true });
  await expect(row.getByText("klide-box", { exact: true })).toHaveCSS("opacity", "0.45");
  await row.click();
  await expect(page.getByText(/Checking SSH connection/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Where it runs", exact: true })).toHaveText("This Mac");
});

test("reopening the machine picker dims a previously ready machine that went offline", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=ready&theme=klide-light");
  const picker = page.getByRole("button", { name: "Where it runs", exact: true });
  await picker.click();
  const row = page.getByRole("option", { name: "klide-box", exact: true });
  await expect(row.getByText("klide-box", { exact: true })).toHaveCSS("opacity", "1");
  await picker.click();
  await page.evaluate(() => { (window as any).__MACHINE_FORCE_OFFLINE__ = true; });
  await picker.click();
  await expect(row.getByText("klide-box", { exact: true })).toHaveCSS("opacity", "0.45");
  await expect(page.getByRole("option", { name: "This Mac", exact: true }).getByText("This Mac", { exact: true })).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "artifacts/design-feedback/machine-picker-unavailable.png" });
  await row.click();
  await expect(page.getByRole("button", { name: "Set up machine", exact: true })).toBeVisible();
});

test("first machine can be connected directly from Focus", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  const addMachine = page.getByRole("option", { name: "Add a machine", exact: true });
  await expect(addMachine.locator(".menu-leadout")).toHaveCount(0);
  await expect(addMachine.locator("svg")).toHaveCount(1);
  await addMachine.click();
  await expect(page.getByRole("dialog", { name: "Add a machine" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your machines" })).toHaveCount(0);
  await enterManualSsh(page);
  await expect(page.getByLabel("SSH host", { exact: true })).toBeVisible();
  await expect(page.getByLabel("SSH host", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Machine ID", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add a machine" })).toHaveCount(0);
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).focus();
  await page.keyboard.press("Enter");
  await enterManualSsh(page);
  await expect(page.getByLabel("SSH host", { exact: true })).toBeFocused();
});

test("Focus keeps management in Settings and offers setup for an offline machine", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=offline&theme=klide-light");
  const picker = page.getByRole("button", { name: "Where it runs", exact: true });
  await picker.click();
  await expect(page.getByRole("option", { name: "Manage machines…", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Add a machine", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "klide-box", exact: true }).click();
  await page.getByRole("button", { name: "Set up machine", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your machines" })).toBeVisible();
  await expect(page.getByLabel("SSH host", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to Focus" }).click();
  await picker.click();
  await expect(page.getByRole("option", { name: "Manage machines…", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  await enterManualSsh(page);
  await expect(page.getByLabel("SSH host", { exact: true })).toBeFocused();
});


test("add popup opens immediately while its form loads and reports SSH progress", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let release!: () => void;
  const formReady = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/src/components/settings/AddMachineForm.tsx*", async (route) => { await formReady; await route.continue(); });
  await page.goto("/preview/where-it-runs.html?state=empty&theme=klide-light&delay=1");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("Opening machine setup");
  await expect(dialog.locator(".klide-machine-spinner")).toHaveCSS("animation-name", "klide-machine-spin");
  release();
  await expect(dialog.getByText("How would you like to connect?", { exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/design-feedback/add-machine-connections.png" });
  await enterManualSsh(page);
  await expect(dialog.getByLabel("SSH host", { exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/design-feedback/add-machine-dialog.png" });
  await dialog.getByLabel("SSH host", { exact: true }).fill("dev@remote");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Checking SSH connection to dev@remote");
  await expect(dialog.getByText("Ready for remote tasks", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await expect(page.getByRole("option", { name: "dev@remote", exact: true })).toBeVisible();
});

test("popup shows save errors and closes with Escape", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&theme=klide-light&failSave=1");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await enterManualSsh(page);
  await dialog.getByLabel("SSH host", { exact: true }).fill("dev@remote");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Could not save machine settings");
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});


test("connection choice lists Tailscale devices before manual entry", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&theme=klide-light&discoveryDelay=1");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await expect(dialog.getByRole("button", { name: /Other VPN/ })).toBeVisible();
  await dialog.getByRole("button", { name: /^Tailscale/ }).click();
  await expect(dialog.getByRole("status")).toHaveText("Looking for Tailscale devices");
  await expect(dialog.getByRole("button", { name: /Linux dev/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /Mac mini/ })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: /Windows PC/ })).toBeEnabled();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /Phone/ })).toBeDisabled();
  await dialog.getByRole("button", { name: "Previous", exact: true }).click();
  await dialog.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /Build server/ })).toHaveCSS("opacity", "0.45");
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: "artifacts/design-feedback/add-machine-devices.png" });
  await dialog.getByRole("button", { name: /Linux dev/ }).click();
  await expect(dialog.getByLabel("SSH host", { exact: true })).toHaveValue("100.64.0.2");
  await expect(dialog.getByLabel("Display name (optional)")).toHaveValue("Linux dev");
});

test("Settings keeps the setup terminal alive when correcting an SSH username", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=offline&settings=1&failConnect=1&theme=klide-light");
  await page.getByRole("button", { name: "Continue setup", exact: true }).click();
  const setup = page.getByRole("region", { name: "Set up klide-box" });
  await setup.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await setup.getByRole("button", { name: "Connect with SSH", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__MACHINE_SETUP_HOST__)).toBe("mini-user@100.64.0.3");
  await expect(setup.getByRole("status").filter({ hasText: "Remote Login" })).toBeVisible();
  await expect(setup.getByLabel("Setup details")).toHaveCount(0);
  await setup.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(setup.getByLabel("Setup details")).toBeVisible();
});

test("missing VPN client still allows a manual private address", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&theme=klide-light&noTailscale=1");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByRole("button", { name: /^Tailscale/ }).click();
  await expect(dialog.getByText("No machines found yet. You can add one by address.")).toBeVisible();
  await dialog.getByRole("button", { name: "Add a machine", exact: true }).click();
  await expect(dialog.getByLabel("SSH host", { exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: /^Other VPN/ }).click();
  await dialog.getByRole("button", { name: "Add a machine", exact: true }).click();
  await expect(dialog.getByText("Enter the machine’s private address while your VPN is connected.")).toBeVisible();
});

for (const [system, copy] of [["macos", "Apple silicon and Intel Macs"], ["windows", "Native Windows over OpenSSH"]]) {
  test(`guided setup explains ${system} installation`, async ({ page }) => {
    await page.goto(`/preview/where-it-runs.html?state=empty&system=${system}&needsInstall=1&theme=klide-light`);
    await page.getByRole("button", { name: "Where it runs", exact: true }).click();
    await page.getByRole("option", { name: "Add a machine", exact: true }).click();
    await enterManualSsh(page);
    const dialog = page.getByRole("dialog", { name: "Add a machine" });
    await dialog.getByLabel("SSH host", { exact: true }).fill("dev@machine");
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Prepare this machine" })).toBeVisible();
    await expect(dialog.getByText(copy, { exact: false })).toBeVisible();
    await page.screenshot({ path: `artifacts/design-feedback/add-machine-${system}-install.png` });
  });
}

test("offline setup downloads the chosen native helper without reaching the machine", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&offline=1&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  await enterManualSsh(page);
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByLabel("SSH host", { exact: true }).fill("dev@machine");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Advanced options", exact: true }).click();
  await dialog.getByLabel("Machine system").selectOption("macos:aarch64");
  await dialog.getByRole("button", { name: "Prepare setup files on this Mac" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Setup files are saved on this Mac. Turn on the machine and continue here when you’re ready.");
  expect(await page.evaluate(() => (window as any).__MACHINE_PREPARED_TARGET__)).toEqual({ os: "macos", arch: "aarch64" });
  await expect(dialog.getByLabel("Machine system")).toHaveCSS("padding-left", "14px");
});

test("unsupported architectures show their limit instead of an offline installation loop", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&system=windows&unsupported=1");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  await enterManualSsh(page);
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByLabel("SSH host", { exact: true }).fill("dev@arm-machine");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Machine not supported yet" })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveText("This remote architecture does not have a published helper yet");
  await expect(dialog.getByRole("button", { name: "Install and continue" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Prepare setup files on this Mac" })).toHaveCount(0);
});

test("setup keeps its frame and recovery controls visible after SSH closes", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&offline=1&failConnect=1&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await expect(dialog.getByText("How would you like to connect?", { exact: true })).toBeVisible();
  const frame = await dialog.boundingBox();
  await enterManualSsh(page);
  await dialog.getByLabel("SSH host", { exact: true }).fill("100.64.0.3");
  await dialog.getByLabel("Remote username", { exact: true }).fill("dev");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Connect with SSH", exact: true })).toBeVisible();
  const assertFrame = async () => {
    expect((await dialog.boundingBox())!.height).toBe(frame!.height);
    expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    const footer = await dialog.getByRole("button", { name: "Save for later", exact: true }).boundingBox();
    expect(footer!.y + footer!.height).toBeLessThan(frame!.y + frame!.height);
  };
  await assertFrame();
  await dialog.getByRole("button", { name: "Connect with SSH", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Remote Login" })).toBeVisible();
  await dialog.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(dialog.getByLabel("Setup details")).toBeVisible();
  await assertFrame();
  await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await dialog.getByRole("button", { name: "Connect with SSH", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__MACHINE_SETUP_HOST__)).toBe("mini-user@100.64.0.3");
  await expect(dialog.getByRole("status").filter({ hasText: "Remote Login" })).toBeVisible();
  await assertFrame();
  await page.screenshot({ path: "artifacts/design-feedback/add-machine-ssh-recovery.png" });
});

for (const viewport of [{ width: 681, height: 865 }, { width: 800, height: 600 }]) {
  test(`setup fits every step without popup scrolling at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const [state, action] of [["offline=1&failConnect=1", "Connect with SSH"], ["needsInstall=1", "Install and continue"], ["needsLogin=1", "Sign in on this machine"], ["needsProject=1", "Sign in to GitHub"]]) {
      await page.goto(`/preview/where-it-runs.html?state=empty&theme=klide-light&system=macos&${state}`);
      await page.getByRole("button", { name: "Where it runs", exact: true }).click();
      await page.getByRole("option", { name: "Add a machine", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add a machine" });
      const frame = await dialog.boundingBox();
      await enterManualSsh(page);
      await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
      await dialog.getByRole("button", { name: "Continue", exact: true }).click();
      await dialog.getByRole("button", { name: action, exact: true }).click();
      if (action !== "Sign in to GitHub") await dialog.getByRole("button", { name: "Show details", exact: true }).click();
      await expect(dialog.getByLabel("Setup details")).toBeVisible();
      if (state.includes("failConnect")) await expect(dialog.getByRole("status").filter({ hasText: "Remote Login" })).toBeVisible();
      expect((await dialog.boundingBox())!.height).toBe(frame!.height);
      expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      const terminal = await dialog.getByLabel("Setup details").boundingBox();
      const footer = await dialog.locator(".klide-machine-setup-footer").boundingBox();
      expect(terminal!.height).toBeGreaterThanOrEqual(action === "Sign in to GitHub" ? 70 : 100);
      expect(terminal!.y + terminal!.height).toBeLessThanOrEqual(footer!.y);
      expect(footer!.y + footer!.height).toBeLessThan(frame!.y + frame!.height);
      await page.screenshot({ path: `artifacts/design-feedback/add-machine-${state.split("=")[0]}-${viewport.height}.png` });
    }
  });
}

test("successful connection advances in the same frame and clears the previous terminal", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&offline=1&needsInstall=1&connectSuccess=1&system=macos&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  const frame = await dialog.boundingBox();
  await enterManualSsh(page);
  await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Connect with SSH", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Prepare this machine" })).toBeVisible();
  await expect(dialog.getByLabel("Setup details")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Install and continue" })).toBeEnabled();
  expect((await dialog.boundingBox())!.height).toBe(frame!.height);
});

test("background SSH access authorizes in the popup then reconnects before installing", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&offline=1&needsInstall=1&authorizeSuccess=1&system=macos&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  const frame = await dialog.boundingBox();
  await enterManualSsh(page);
  await dialog.getByLabel("SSH host", { exact: true }).fill("mini-user@100.64.0.3");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Enable background access", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Prepare this machine" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__MACHINE_SETUP_ACTIONS__)).toEqual(["authorize", "connect"]);
  expect((await dialog.boundingBox())!.height).toBe(frame!.height);
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
});
