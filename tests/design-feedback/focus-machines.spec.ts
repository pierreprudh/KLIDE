import { test, expect } from "@playwright/test";

test("first machine can be connected directly from Focus", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?state=empty&theme=klide-light");
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  const addMachine = page.getByRole("option", { name: "Add a machine", exact: true });
  await expect(addMachine.locator(".menu-leadout")).toHaveCount(0);
  await expect(addMachine.locator("svg")).toHaveCount(1);
  await addMachine.click();
  await expect(page.getByRole("dialog", { name: "Add a machine" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your machines" })).toHaveCount(0);
  await expect(page.getByLabel("SSH host", { exact: true })).toBeVisible();
  await expect(page.getByLabel("SSH host", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Machine ID", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add a machine" })).toHaveCount(0);
  await page.getByRole("button", { name: "Where it runs", exact: true }).click();
  await page.getByRole("option", { name: "Add a machine", exact: true }).focus();
  await page.keyboard.press("Enter");
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
  await dialog.getByLabel("SSH host", { exact: true }).fill("dev@remote");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Could not save machine settings");
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
