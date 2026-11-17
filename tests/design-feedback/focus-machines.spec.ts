import { test, expect, type Page } from "@playwright/test";

async function enterManualSsh(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await dialog.getByRole("button", { name: "Direct SSH", exact: false }).click();
  await dialog.getByRole("button", { name: "Add a machine", exact: true }).click();
}

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
  await expect(dialog.getByRole("button", { name: /Mac mini/ })).toBeDisabled();
  await page.screenshot({ path: "artifacts/design-feedback/add-machine-devices.png" });
  await dialog.getByRole("button", { name: /Linux dev/ }).click();
  await expect(dialog.getByLabel("SSH host", { exact: true })).toHaveValue("100.64.0.2");
  await expect(dialog.getByLabel("Display name (optional)")).toHaveValue("Linux dev");
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
