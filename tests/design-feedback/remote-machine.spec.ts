import { test, expect } from "@playwright/test";

test("machine setup installs through Settings and preserves active-task errors", async ({ page }) => {
  await page.goto("/preview/machines.html?active=1");
  await page.getByRole("button", { name: "Install Run host", exact: true }).first().click();
  await expect(page.getByRole("alert")).toContainText("Finish the remote host's active sessions");
  await expect(page.getByRole("button", { name: "Install Run host", exact: true }).first()).toBeEnabled();
  await page.goto("/preview/machines.html");
  await page.getByRole("button", { name: "Install Run host", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Install Run host", exact: true }).first()).toBeEnabled();
  await expect(page.getByText("Tasks run on this machine and keep going when your Mac is off.", { exact: false }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
