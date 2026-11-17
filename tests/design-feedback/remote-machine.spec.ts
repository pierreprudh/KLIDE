import { test, expect } from "@playwright/test";

test("guided setup installs the helper and preserves active-task errors", async ({ page }) => {
  await page.goto("/preview/machines.html?install=1&active=1");
  await page.getByRole("button", { name: "Continue setup", exact: true }).first().click();
  await page.getByRole("button", { name: "Install Klide helper only" }).first().click();
  await expect(page.getByRole("alert")).toContainText("Finish the remote host's active sessions");
  await expect(page.getByRole("button", { name: "Install Klide helper only" }).first()).toBeEnabled();
  await page.goto("/preview/machines.html?install=1");
  await page.getByRole("button", { name: "Continue setup", exact: true }).first().click();
  await page.screenshot({ path: "artifacts/design-feedback/machine-install.png", fullPage: true });
  await page.getByRole("button", { name: "Install and continue" }).first().click();
  await expect(page.getByText("Ready for remote tasks", { exact: true })).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__machineSetupActions)).toEqual(["prepare"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("offline setup saves an SSH address without exposing a machine ID", async ({ page }) => {
  await page.goto("/preview/machines.html?offline=1");
  await page.getByRole("button", { name: "Add machine", exact: true }).click();
  await page.getByLabel("SSH host", { exact: true }).fill("dev@my-vm");
  await expect(page.getByLabel("Machine ID", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const setup = page.getByRole("region", { name: "Set up dev@my-vm" });
  await expect(setup.getByText("Connect to dev@my-vm", { exact: true })).toBeVisible();
  await expect(setup.getByText("Your setup is saved.", { exact: false })).toBeVisible();
  await setup.getByRole("button", { name: "Prepare setup files on this Mac" }).click();
  await expect(setup.getByText("Setup files are saved on this Mac.", { exact: false })).toBeVisible();
  await expect(setup.getByText("Ready for remote tasks", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 420, height: 850 });
  await page.screenshot({ path: "artifacts/design-feedback/machine-offline-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await setup.getByRole("button", { name: "Save for later" }).click();
  await expect(page.getByRole("heading", { name: "dev@my-vm", exact: true })).toBeVisible();
});

test("remote sign-in and project clone advance only after a new readiness check", async ({ page }) => {
  await page.goto("/preview/machines.html?project=1");
  const home = page.locator("article.klide-machine-entry").filter({ hasText: "Home server" });
  await home.getByRole("button", { name: "Continue setup", exact: true }).click();
  await home.getByRole("button", { name: "Sign in on this machine" }).click();
  await expect(home.getByText("Choose the remote project", { exact: true })).toBeVisible();
  await home.getByLabel("Remote folder").fill("~/work/app");
  await home.getByRole("button", { name: "Use this folder" }).click();
  await home.getByRole("button", { name: "Clone project here" }).click();
  await expect(home.getByText("Ready for remote tasks", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__machineSetupActions)).toEqual(["signIn", "clone"]);
});

test("remote conversation uses native replay and reads remote changes", async ({ page }) => {
  await page.goto("/preview/design-feedback.html?scenario=subagent-activity&remote=1");
  await page.waitForFunction(() => (window as any).__designFeedback?.status === "ready");
  await expect(page.getByRole("button", { name: "Remote changes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remote changes", exact: true }).click();
  await expect(page.getByText("/home/klide/.klide/run-host/worktrees/task", { exact: true })).toBeVisible();
  await expect(page.locator("pre").filter({ hasText: "remote task result" })).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__designFeedback.native?.unexpected ?? [])).toEqual([]);
});
