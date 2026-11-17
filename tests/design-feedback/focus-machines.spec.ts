import { test, expect } from "@playwright/test";

test("first machine can be connected directly from Focus", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine…", exact: true }).click();
  await expect(page.getByLabel("SSH host", { exact: true })).toBeVisible();
  await expect(page.getByLabel("SSH host", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Machine ID", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Back to Focus" }).click();
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine…", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("SSH host", { exact: true })).toBeFocused();
});

test("Focus keeps management in Settings and offers setup for an offline machine", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=offline&theme=klide-light");
  const picker = page.getByRole("button", { name: "Where it runs", exact: true });
  await picker.click();
  await expect(page.getByRole("option", { name: "Manage machines…", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Add a machine…", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "klide-box", exact: true }).click();
  await page.getByRole("button", { name: "Set up machine", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your machines" })).toBeVisible();
  await expect(page.getByLabel("SSH host", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to Focus" }).click();
  await picker.click();
  await expect(page.getByRole("option", { name: "Manage machines…", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Add a machine…", exact: true }).click();
  await expect(page.getByLabel("SSH host", { exact: true })).toBeFocused();
});
