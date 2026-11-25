import { expect, test } from "@playwright/test";

test("execution choice blocks setup until isolation is prepared", async ({ page }) => {
  await page.goto("/preview/machines.html");
  const machine = page.locator(".klide-machine-entry").first();
  await machine.getByRole("button", { name: "Manage", exact: true }).click();
  const setup = machine.getByRole("region", { name: "Set up Cloud development" });
  await setup.getByRole("button", { name: "Execution", exact: true }).click();
  await setup.getByRole("radio", { name: /^Isolated/ }).check();
  await expect(setup.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await expect(setup.getByRole("button", { name: "Project", exact: true })).toBeDisabled();
  await setup.getByRole("button", { name: "Set up isolated environment", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__machineSetupActions)).toContain("isolate");
  await expect(setup.getByRole("heading", { name: "Ready for remote tasks" })).toBeVisible();
});

test("only an explicitly selected key is authorized, after consent", async ({ page }) => {
  await page.goto("/preview/machines.html");
  const machine = page.locator(".klide-machine-entry").first();
  await machine.getByRole("button", { name: "Manage", exact: true }).click();
  const setup = machine.locator(".klide-machine-setup");
  await setup.getByRole("button", { name: "Credentials", exact: true }).click();
  await setup.getByRole("radio", { name: /^Authorize an API key/ }).check();
  const authorize = setup.getByRole("button", { name: "Authorize selected key" });
  await expect(authorize).toBeDisabled();
  await setup.getByRole("combobox", { name: "API key", exact: true }).selectOption("test-key");
  await expect(authorize).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__authorizedMachineKey)).toBeUndefined();
  await setup.getByRole("checkbox").check();
  await authorize.click();
  await expect.poll(() => page.evaluate(() => (window as any).__authorizedMachineKey)).toEqual({ id: "cloud-dev", keyId: "test-key" });
});

test("new machine offers direct or isolated execution in the same short form", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/preview/machines.html");
  await page.getByRole("button", { name: "Add machine", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Direct SSH/ }).click();
  await dialog.getByRole("button", { name: "Add a machine", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /^Direct / })).toBeChecked();
  await dialog.getByRole("radio", { name: /^Isolated/ }).check();
  await dialog.getByLabel("SSH host", { exact: true }).fill("dev@example.test");
  await page.screenshot({ path: "artifacts/design-feedback/remote-execution-choice.png" });
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
