import { test, expect, type Page } from "@playwright/test";

test("a VPS offers Claude Code and Kit on the APIs it holds keys for", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?pick=1&apiReady=1&needsLogin=1");
  const agent = page.getByRole("button", { name: "Provider", exact: true });
  await agent.click();
  // Subscription holds Claude Code alone; no Local group: a local server can't run there.
  await expect(page.getByRole("menuitem", { name: "Subscription" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Local" })).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "Subscription" }).getByRole("menuitem")).toHaveText(["Claude Code"]);
  await page.getByRole("menuitem", { name: "API" }).hover();
  await expect(page.getByRole("menuitem", { name: /^OpenRouter/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Azure/ })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/design-feedback/vps-agent-menu.png" });
  await page.getByRole("menuitem", { name: /^OpenRouter/ }).click();
  await expect(agent).toContainText("OpenRouter");
  await expect(page.getByRole("button", { name: "Where it runs", exact: true })).toContainText("klide-box");
});

test("API keys can be authorized before the VPS helper is installed", async ({ page }) => {
  await page.goto("/preview/where-it-runs.html?settings=1&needsInstall=1");
  await page.getByRole("button", { name: "Continue setup", exact: true }).click();
  const setup = page.locator(".klide-machine-setup");
  await setup.getByRole("button", { name: "Credentials", exact: true }).click();
  await setup.getByRole("button", { name: "Add an API key", exact: true }).click();
  await expect(setup.getByLabel("Provider", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: /^Authorize .* key$/ })).toBeVisible();
});

async function projectSetup(page: Page, extra = "", popup = false) {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`/preview/where-it-runs.html?needsProject=1&repoAccess=1&theme=dark&${popup ? "state=empty" : "settings=1"}&${extra}`);
  if (popup) {
    await page.getByRole("button", { name: "Where it runs", exact: true }).click();
    await page.getByRole("option", { name: "Add a machine", exact: true }).click();
    const dialog=page.getByRole("dialog",{name:"Add a machine"});
    await dialog.getByRole("button",{name:"Direct SSH",exact:false}).click();
    await dialog.getByRole("button",{name:"Add a machine",exact:true}).click();
    await dialog.getByLabel("SSH host",{exact:true}).fill("dev@100.64.0.3");
    await dialog.getByRole("button",{name:"Continue",exact:true}).click();
  } else await page.getByRole("button", { name: "Continue setup", exact: true }).click();
  return page.locator(".klide-machine-setup");
}

test("browse and create a remote clone destination without typing a path", async ({ page }) => {
  const setup=await projectSetup(page,"",true);
  await setup.getByRole("button",{name:"Browse folders",exact:true}).click();
  const explorer=setup.getByRole("region",{name:"Remote folder explorer"});
  await explorer.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(explorer.getByLabel("Remote location")).toHaveValue("/Users/remote/Projects");
  await page.screenshot({path:"artifacts/design-feedback/remote-folder-explorer-dark.png"});
  await explorer.getByRole("button",{name:"New folder",exact:true}).click();
  await explorer.getByLabel("New folder name").fill("My new project");
  await explorer.getByRole("button",{name:"Create folder",exact:true}).click();
  await expect(explorer.getByLabel("Remote location")).toHaveValue("/Users/remote/Projects/My new project");
  const dialog=page.getByRole("dialog"); const frame=(await dialog.boundingBox())!;
  const footer=(await setup.locator(".klide-machine-setup-footer").boundingBox())!;
  expect(footer.y+footer.height).toBeLessThan(frame.y+frame.height);
  expect(await dialog.evaluate((el)=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
  await explorer.getByRole("button",{name:"Choose this folder",exact:true}).click();
  await expect(setup.getByLabel("Remote folder",{exact:true})).toHaveValue("/Users/remote/Projects/My new project");
  await setup.getByRole("button",{name:"Clone project here",exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__MACHINE_FOLDER_CREATED__)).toBe("/Users/remote/Projects/My new project");
  await expect.poll(()=>page.evaluate(()=>(window as any).__MACHINE_SETUP_ACTIONS__)).toEqual(["clone"]);
  expect(await page.evaluate(()=>(window as any).__MACHINE_CLONE_CHECKOUT__)).toBe("/Users/remote/Projects/My new project/project");
});

test("choosing Documents clones into a named project folder without typing", async ({ page }) => {
  const setup = await projectSetup(page);
  await setup.getByRole("button", { name: "Browse folders", exact: true }).click();
  const explorer = setup.getByRole("region", { name: "Remote folder explorer" });
  await explorer.getByRole("button", { name: "Documents", exact: true }).click();
  await explorer.getByRole("button", { name: "Choose this folder", exact: true }).click();
  await expect(setup.getByLabel("Remote folder", { exact: true })).toHaveValue("/Users/remote/Documents");
  await expect(setup.getByText("Clone destination:", { exact: false })).toHaveText("Clone destination: /Users/remote/Documents/project");
  await setup.getByRole("button", { name: "Clone project here", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__MACHINE_CLONE_CHECKOUT__)).toBe("/Users/remote/Documents/project");
  await expect(setup.getByLabel("Remote folder", { exact: true })).toHaveValue("/Users/remote/Documents/project");
});

test("an existing checkout is scoped before its folder mapping is saved",async({page})=>{
  const setup=await projectSetup(page);
  await setup.getByRole("button",{name:"Browse folders",exact:true}).click();
  const explorer=setup.getByRole("region",{name:"Remote folder explorer"});
  await explorer.getByRole("button",{name:"Projects",exact:true}).click();
  await explorer.getByRole("button",{name:"Existing project",exact:true}).click();
  await explorer.getByRole("button",{name:"Choose this folder",exact:true}).click();
  await setup.getByRole("button",{name:"Use this folder",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__MACHINE_REPOSITORY_CONFIGURE__?.path)).toBe("/Users/remote/Projects/Existing project");
  expect(await page.evaluate(()=>(window as any).__MACHINE_SETUP_ACTIONS__)).toBeUndefined();
});

test("a failed folder listing cannot silently select a stale destination",async({page})=>{
  const setup=await projectSetup(page,"failBrowse=1");
  await setup.getByRole("button",{name:"Browse folders",exact:true}).click();
  const explorer=setup.getByRole("region",{name:"Remote folder explorer"});
  await expect(explorer.getByRole("alert")).toContainText("Permission denied");
  await expect(explorer.getByRole("button",{name:"Choose this folder",exact:true})).toBeDisabled();
  await explorer.getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(setup.getByLabel("Remote folder",{exact:true})).toHaveValue("~/code");
});

test("shared-account setup disconnects a personal login and grants read-only access to one repository",async({page})=>{
  const setup=await projectSetup(page,"needsGhLogin=1&personalGithub=1");
  await setup.getByRole("button",{name:"GitHub",exact:true}).click();
  await expect(setup.getByRole("heading",{name:"Repository access",exact:true})).toBeVisible();
  await expect(setup.getByRole("button",{name:"Connect this repository",exact:true})).toHaveCount(0);
  await expect(setup.getByRole("button",{name:"Sign in to GitHub",exact:true})).toHaveCount(0);
  await setup.getByRole("button",{name:"Disconnect example-user",exact:true}).click();
  await expect(setup.getByLabel("Allow pushing to this repository")).not.toBeChecked();
  await setup.getByRole("button",{name:"Connect this repository",exact:true}).click();
  await expect(setup.getByRole("status")).toContainText("Repository-only access verified");
  expect(await page.evaluate(()=>(window as any).__MACHINE_GITHUB_LOGOUT__)).toBe("example-user");
  expect((await page.evaluate(()=>(window as any).__MACHINE_REPOSITORY_CONNECT__)).allowPush).toBe(false);
  expect(await page.evaluate(()=>(window as any).__MACHINE_SETUP_ACTIONS__)).toBeUndefined();
  await page.screenshot({path:"artifacts/design-feedback/repository-only-access-dark.png",fullPage:true});
});

test("repository-only setup fits the popup before and after personal-login cleanup",async({page})=>{
  const setup=await projectSetup(page,"needsGhLogin=1&personalGithub=1",true);
  await setup.getByRole("button",{name:"GitHub",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await expect(setup.getByRole("button",{name:"Disconnect example-user",exact:true})).toBeVisible();
  expect(await dialog.evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
  await setup.getByRole("button",{name:"Disconnect example-user",exact:true}).click();
  await expect(setup.getByRole("button",{name:"Connect this repository",exact:true})).toBeVisible();
  expect(await dialog.evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
  const frame=(await dialog.boundingBox())!;
  const footer=(await setup.locator(".klide-machine-setup-footer").boundingBox())!;
  expect(footer.y+footer.height).toBeLessThan(frame.y+frame.height);
});

test("an older running backend cannot fall back to personal GitHub sign-in",async({page})=>{
  const setup=await projectSetup(page,"oldBackend=1");
  await setup.getByRole("button",{name:"Clone project here",exact:true}).click();
  await expect(setup.getByRole("status")).toContainText("Restart Klide");
  expect(await page.evaluate(()=>(window as any).__MACHINE_SETUP_ACTIONS__)).toBeUndefined();
  await setup.getByRole("button",{name:"GitHub",exact:true}).click();
  await expect(setup.getByText("Restart Klide to load repository-only setup.",{exact:false})).toBeVisible();
  await expect(setup.getByRole("button",{name:"Sign in to GitHub",exact:true})).toHaveCount(0);
});


test("any hosted API key is authorized without Claude sign-in", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/preview/where-it-runs.html?settings=1&needsLogin=1&repoAccess=1");
  await page.getByRole("button", { name: "Continue setup", exact: true }).click();
  const setup = page.locator(".klide-machine-setup");
  await setup.getByRole("button", { name: "Add an API key", exact: true }).click();
  await setup.getByLabel("Provider", { exact: true }).selectOption("deepseek");
  const authorize = setup.getByRole("button", { name: "Authorize DeepSeek key", exact: true });
  await expect(authorize).toBeDisabled();
  await setup.getByRole("checkbox", { name: /Store this key on/ }).check();
  await expect(authorize).toBeEnabled();
  await page.screenshot({ path: "artifacts/design-feedback/remote-api-credentials.png", fullPage: true });
  await authorize.click();
  await expect(setup.getByRole("heading", { name: "Ready for remote tasks", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__MACHINE_API_KEY__)).toEqual({ provider: "deepseek", keyId: "configured" });
  expect(await page.evaluate(() => (window as any).__MACHINE_SETUP_ACTIONS__ ?? [])).toEqual([]);
});
